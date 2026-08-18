/*
 * 管理画面と CSV で共通に使う「1件の見せ方」。
 *
 * 一覧・詳細・CSV で列がずれないよう、整形を1か所に集める（仕様書9章）。
 */

import {
  AGE_GROUP_LABELS,
  INDUSTRY_LABELS,
  OCCUPATION_LABELS,
  POSITION_LABELS,
} from './pricing.mjs';

/** 申込ステータスの表示名（仕様書5.4）。 */
export const STATUS_LABELS = {
  received: '申込受付済み',
  awaiting: '決済待ち',
  paid: '支払済み',
  failed: '決済失敗',
  expired: '決済期限切れ',
  refunded: '返金済み（例外対応）',
};

/** 日時を日本時間の「2026/08/01 14:30」形式にする。 */
export function formatDateTime(value) {
  if (!value) {
    return '';
  }

  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(value));

  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';

  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}

/**
 * カレンダー同期の状態を管理画面の1行にする。
 *
 * calendar_sync_state の初期値は last_synced_at = epoch（1970-01-01）で、
 * これは「一度も同期していない」を表す（マイグレーションのコメント参照）。
 * そのまま整形すると「1970/01/01 09:00（）」と表示され、同期が動いていない
 * のか壊れているのかが読み取れない。同じ理由で、結果（last_status）が
 * 空のままの場合も未実行として扱う。
 *
 * @param {{ last_synced_at?: string, last_status?: string } | null | undefined} state
 * @returns {string}
 */
export function describeCalendarSyncState(state) {
  if (!state) {
    return '未実行';
  }

  const syncedAtMs = Date.parse(state.last_synced_at);
  const status = typeof state.last_status === 'string' ? state.last_status.trim() : '';

  /* epoch 以前＝claimCalendarSync が一度も成功していない。 */
  if (!Number.isFinite(syncedAtMs) || syncedAtMs <= 0 || status === '') {
    return '未実行';
  }

  return `${formatDateTime(state.last_synced_at)}（${status}）`;
}

/*
 * PostgREST の埋め込みは配列で返る。
 * 支払記録は申込1件につき1件だけ使う。
 */
export function paymentOf(application) {
  const payments = application?.payments;

  if (Array.isArray(payments)) {
    return payments[0] ?? null;
  }

  return payments ?? null;
}

/** 「その他」なら自由記述を添える。 */
function labelWithOther(labels, key, otherText) {
  const label = labels[key] ?? key;

  return key === 'other' && otherText ? `${label}（${otherText}）` : label;
}

/**
 * 申込1件を、一覧とCSVで使う平たい形にする。
 *
 * @param {object} application payments を埋め込んだ行
 */
export function toAdminRow(application) {
  const payment = paymentOf(application);

  return {
    id: application.id,
    receiptNumber: application.receipt_number ?? '',
    name: application.name,
    nameKana: application.name_kana,
    email: application.email,
    phone: application.phone,
    company: application.company,
    department: application.department ?? '',
    jobTitle: application.job_title ?? '',
    industry: labelWithOther(
      INDUSTRY_LABELS, application.industry, application.industry_other_text,
    ),
    occupation: labelWithOther(
      OCCUPATION_LABELS, application.occupation, application.occupation_other_text,
    ),
    position: POSITION_LABELS[application.position] ?? application.position,
    ageGroup: AGE_GROUP_LABELS[application.age_group] ?? application.age_group,
    /* 出禁の申告は一覧に出す（仕様書9章）。 */
    bannedDeclared: application.is_banned_declared ? '該当する' : '該当しない',
    discountIndustry: payment?.discount_industry ?? '',
    discountOccupation: payment?.discount_occupation ?? '',
    discountPosition: payment?.discount_position ?? '',
    discountAge: payment?.discount_age ?? '',
    discountTotal: payment?.discount_total ?? '',
    finalPrice: payment?.final_price ?? '',
    status: STATUS_LABELS[application.status] ?? application.status,
    statusKey: application.status,
    appliedAt: formatDateTime(application.created_at),
    paidAt: formatDateTime(payment?.paid_at),
    transferred: application.is_transferred ? 'あり' : '',
  };
}

/** 申込者一覧CSVの列（一覧と同じ項目、仕様書9章）。 */
export const APPLICATION_CSV_COLUMNS = [
  { header: '受付番号', key: 'receiptNumber' },
  { header: '氏名', key: 'name' },
  { header: 'フリガナ', key: 'nameKana' },
  { header: 'メールアドレス', key: 'email' },
  { header: '電話番号', key: 'phone' },
  { header: '会社名', key: 'company' },
  { header: '部署名', key: 'department' },
  { header: '役職名', key: 'jobTitle' },
  { header: '業界', key: 'industry' },
  { header: '職種', key: 'occupation' },
  { header: '立場', key: 'position' },
  { header: '年齢区分', key: 'ageGroup' },
  { header: '出禁申告', key: 'bannedDeclared' },
  { header: '業界割引', key: 'discountIndustry' },
  { header: '職種割引', key: 'discountOccupation' },
  { header: '立場割引', key: 'discountPosition' },
  { header: '年齢割引', key: 'discountAge' },
  { header: '割引合計', key: 'discountTotal' },
  { header: '支払金額', key: 'finalPrice' },
  { header: 'ステータス', key: 'status' },
  { header: '申込日時', key: 'appliedAt' },
  { header: '決済日時', key: 'paidAt' },
  { header: '譲渡', key: 'transferred' },
];

/*
 * 名札印刷用CSVの列（仕様書9章）。
 * 年齢は載せない。当日の名札に年齢を記載しないと決めているため（仕様書7.3）。
 */
export const NAMETAG_CSV_COLUMNS = [
  { header: '氏名', key: 'name' },
  { header: '会社名', key: 'company' },
  { header: '業界', key: 'industry' },
  { header: '職種', key: 'occupation' },
  { header: '立場', key: 'position' },
];

/** 名札印刷用は支払済みだけを対象にする（仕様書9章）。 */
export function nametagRows(applications) {
  return applications
    .filter((application) => application.status === 'paid')
    .map((application) => {
      const row = toAdminRow(application);

      return {
        name: row.name,
        company: row.company,
        industry: row.industry,
        occupation: row.occupation,
        position: row.position,
      };
    });
}
