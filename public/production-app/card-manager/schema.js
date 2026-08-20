/*
 * 台帳「名刺管理」の列構成（card-ocr/schema.js の複製）。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * ../card-ocr/schema.js を複製（2026-08-20）。**import はしない**
 * （docs/repository-structure.md §4-1）。
 *
 * **このアプリは card-ocr が作る台帳をそのまま編集する。** テスト環境
 * `/apps/card-manager/` が対象にしていた名刺スキャナ（card-scanner）の
 * 台帳「名刺台帳（表裏対応 v3）」とは列構成がまったく別物であり、
 * 本番では対象にしない（クライアントIDを card-ocr と共用する理由が
 * 「card-ocr の台帳を読み書きするため」である以上、対象は card-ocr の
 * 台帳でなければ意味がない）。
 *
 * **列を1文字でも変えないこと。** ここがずれると、card-ocr が書いた
 * 台帳の列位置と食い違い、電話番号の欄にメールが入るような事故になる。
 * card-ocr 側で SCHEMA_VERSION が上がったら、このファイルも合わせて
 * 複製し直すこと。
 * ==================================================================
 *
 * ==================================================================
 * ここに通信を書かない
 * ==================================================================
 * 列の定義と、値から行を作るところまで。Sheets の呼び出しは
 * manager-client.js。
 * ==================================================================
 */

import { escapeCellText, buildImageLink, unescapeCellText } from './sanitize.js';

/*
 * 台帳の見出し行の版（card-ocr/schema.js と同じ値であること）。
 * **列を足したら上げること。** 既存シートの更新判定に使う。
 */
export const SCHEMA_VERSION = '3.5';

/*
 * 名刺データタブの列。**並び順に意味がある。**
 *
 * 行は必ずこの順で作る。位置で書くのではなく、この定義から作ることで
 * 「定義と実際の行がずれる」を起こさないようにする。
 */
export const DATA_COLUMNS = Object.freeze([
  { key: 'record_id', header: 'record_id' },
  { key: 'registeredAt', header: '登録日時' },

  { key: 'companyName', header: '会社名' },
  { key: 'departmentName', header: '部署名' },
  { key: 'jobTitle', header: '役職' },
  { key: 'fullName', header: '氏名' },
  { key: 'fullNameKana', header: '氏名カナ' },
  { key: 'postalCode', header: '郵便番号' },
  { key: 'address', header: '住所' },
  { key: 'phone', header: '電話番号' },
  { key: 'mobile', header: '携帯番号' },
  { key: 'fax', header: 'FAX' },
  { key: 'email', header: 'メールアドレス' },
  { key: 'url', header: 'URL' },

  /* FR-12 の uncertainFields。空白区切りで入れる。 */
  { key: 'uncertainFields', header: '要確認項目' },

  { key: 'duplicateKey', header: 'duplicate_key' },

  /* v3.1: 面ごとの列。裏面が無くても列は必ず置く（card-ocr 要件書 §11.2）。 */
  { key: 'hasBack', header: 'has_back' },
  { key: 'backFilledFields', header: 'back_filled_fields' },
  { key: 'frontImageHash', header: 'front_image_hash' },
  { key: 'backImageHash', header: 'back_image_hash' },
  { key: 'frontFileId', header: 'front_file_id' },
  { key: 'backFileId', header: 'back_file_id' },
  { key: 'frontFileUrl', header: 'front_file_url' },
  { key: 'backFileUrl', header: 'back_file_url' },

  { key: 'appVersion', header: 'app_version' },
  { key: 'promptVersion', header: 'prompt_version' },

  /* v3.5: その他。右端に追加された列（card-ocr/schema.js と同じ）。 */
  { key: 'otherInformation', header: 'その他' },
]);

/*
 * 記録のための列（＝名刺の中身ではない列）。
 *
 * このアプリの編集フォームに出すのは、**利用者が読んで判断できる
 * 項目だけ**にする（card-ocr の差分確認画面と同じ考え方）。
 */
const BOOKKEEPING_KEYS = Object.freeze(new Set([
  'record_id', 'registeredAt', 'uncertainFields', 'duplicateKey',
  'hasBack', 'backFilledFields',
  'frontImageHash', 'backImageHash',
  'frontFileId', 'backFileId', 'frontFileUrl', 'backFileUrl',
  'appVersion', 'promptVersion',
]));

/* 名刺の中身にあたる列（＝このアプリで編集できる列）。 */
export const CONTENT_COLUMNS = Object.freeze(
  DATA_COLUMNS.filter((column) => !BOOKKEEPING_KEYS.has(column.key)),
);

/* 記録のための列（＝自動項目。読み取り専用で表示する）。 */
export const BOOKKEEPING_COLUMNS = Object.freeze(
  DATA_COLUMNS.filter((column) => BOOKKEEPING_KEYS.has(column.key)),
);

/* 変更履歴タブ（card-ocr 要件書 §11.3）。changed_by は本人のみのため持たない。 */
export const HISTORY_COLUMNS = Object.freeze([
  { key: 'historyId', header: 'history_id' },
  { key: 'changedAt', header: 'changed_at' },
  { key: 'recordId', header: 'record_id' },
  { key: 'fieldName', header: 'field_name' },
  { key: 'oldValue', header: 'old_value' },
  { key: 'newValue', header: 'new_value' },
]);

/*
 * 画像リンクの列。**このアプリでは実際には使わない**
 * （frontFileUrl / backFileUrl は生セルをそのまま書き戻す。
 * manager-client.js）。buildDataRow の対称性のためだけに残す。
 */
const LINK_COLUMNS = Object.freeze({
  frontFileUrl: '表面画像を見る',
  backFileUrl: '裏面画像を見る',
});

export function headersOf(columns) {
  return columns.map((column) => column.header);
}

/*
 * ヘッダー行の検証。
 *
 *   'ok'      … 期待どおり。書き込んでよい
 *   'upgrade' … 旧版。期待の先頭部分と一致し、右端が足りないだけ
 *   'altered' … 並べ替え・削除・改名。**書き込みを停止する**
 *   'empty'   … ヘッダーが無い。作りかけとみなす
 *
 * ==================================================================
 * このアプリは 'ok' のときだけ書き込みを許可する
 * ==================================================================
 * card-ocr は 'upgrade' を見つけると列を右へ足して使い続ける
 * （drive-storage.js の inspectSpreadsheet）。**このアプリはそれをしない。**
 * 台帳の版を上げるのは card-ocr の役割であり、このアプリは「読む・
 * 編集する」だけに責務を絞る（docs/specs/card-manager-requirements-v1.md
 * §11 採用しなかった案とその理由）。'upgrade' のときは閲覧のみ許可し、
 * 編集は止める（manager-client.js）。
 * ==================================================================
 *
 * 判定は名前の完全一致。前後の空白だけは落とす（手編集で紛れ込みやすく、
 * それを改変とみなすと復旧できなくなる）。
 */
export function verifyHeader(actualHeader, columns = DATA_COLUMNS) {
  const expected = headersOf(columns);
  const actual = (Array.isArray(actualHeader) ? actualHeader : [])
    .map((value) => String(value ?? '').trim());

  while (actual.length > 0 && actual[actual.length - 1] === '') {
    actual.pop();
  }

  if (actual.length === 0) {
    return { status: 'empty', missing: [...columns] };
  }

  const shared = Math.min(actual.length, expected.length);

  for (let i = 0; i < shared; i += 1) {
    if (actual[i] !== expected[i]) {
      return { status: 'altered', missing: [] };
    }
  }

  if (actual.length < expected.length) {
    return { status: 'upgrade', missing: columns.slice(actual.length) };
  }

  return { status: 'ok', missing: [] };
}

/*
 * 重複判定キー（card-ocr の FR-19 と同じ規則）。
 *
 * メール → 携帯 → 会社名＋氏名 の優先順位。
 * **表記ゆれを吸収するため小文字化と空白除去を行う。**
 */
export function normalizeForCompare(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

export function buildDuplicateKey({
  email = '',
  mobile = '',
  companyName = '',
  fullName = '',
} = {}) {
  const normalize = normalizeForCompare;

  const normalizedEmail = normalize(email);

  if (normalizedEmail !== '') {
    return { key: `email:${normalizedEmail}`, source: 'email', strong: true };
  }

  /* 番号は記号を落として数字だけで比べる。 */
  const normalizedMobile = String(mobile ?? '').replace(/[^0-9]/g, '');

  if (normalizedMobile !== '') {
    return { key: `mobile:${normalizedMobile}`, source: 'mobile', strong: true };
  }

  const normalizedCompany = normalize(companyName);
  const normalizedName = normalize(fullName);

  if (normalizedCompany !== '' || normalizedName !== '') {
    return {
      key: `name:${normalizedCompany}/${normalizedName}`,
      source: 'name',
      /* 同姓同名がありうる。確定に使わない。 */
      strong: false,
    };
  }

  return { key: '', source: 'none', strong: false };
}

/*
 * 1件ぶんの行を、列定義の順に組み立てる。
 *
 * **このアプリの更新経路（manager-client.js）は使わない。** frontFileUrl /
 * backFileUrl を生セルのまま残す必要があり、buildImageLink で作り直すと
 * card-ocr が書いた元のURLを壊すため（複製元との対称性のためだけに残す。
 * 変更履歴タブの行を組み立てる buildHistoryRow は使う）。
 */
export function buildDataRow(values = {}, columns = DATA_COLUMNS) {
  return columns.map((column) => {
    const raw = values[column.key];

    if (column.key in LINK_COLUMNS) {
      return buildImageLink(raw, LINK_COLUMNS[column.key]);
    }

    if (Array.isArray(raw)) {
      return escapeCellText(raw.join(' '));
    }

    if (raw === true) {
      return 'TRUE';
    }

    /* false は「裏面なし」。空欄にする。 */
    if (raw === false) {
      return '';
    }

    return escapeCellText(raw);
  });
}

export function buildHistoryRow(values = {}) {
  return buildDataRow(values, HISTORY_COLUMNS);
}

/* ---------- 更新 ---------- */

/*
 * シートから読んだ1行を、列の定義にしたがって鍵付きの値へ戻す。
 *
 * **buildDataRow の逆**である。更新のときに「いま入っている値」を
 * 差分と変更履歴に使うために要る。
 *
 * 行が短ければ足りない分は空文字にする（Sheets は右端の空セルを
 * 返さない）。値は unescapeCellText を通す。
 */
export function rowToValues(row = [], columns = DATA_COLUMNS) {
  const cells = Array.isArray(row) ? row : [];
  const values = {};

  columns.forEach((column, index) => {
    values[column.key] = unescapeCellText(cells[index] ?? '');
  });

  return values;
}

/*
 * 2つの値の集まりを突き合わせて、変わった項目だけを返す。
 *
 * 戻り値: [{ key, header, oldValue, newValue }]
 *
 * **比較はサニタイズを外した形で行う。** 配列（要確認項目・
 * back_filled_fields）は行と同じ空白区切りへ寄せる。true/false は
 * 行と同じ 'TRUE' / '' へ寄せる。**表に入る形で比べる**ためで、
 * そうしないと型の違いだけで差分になる。
 */
function comparable(value) {
  if (Array.isArray(value)) {
    return value.join(' ');
  }

  if (value === true) {
    return 'TRUE';
  }

  if (value === false) {
    return '';
  }

  return unescapeCellText(value);
}

export function diffValues(oldValues = {}, newValues = {}, columns = CONTENT_COLUMNS) {
  const changes = [];

  for (const column of columns) {
    const before = comparable(oldValues[column.key]);
    const after = comparable(newValues[column.key]);

    if (before !== after) {
      changes.push({
        key: column.key,
        header: column.header,
        oldValue: before,
        newValue: after,
      });
    }
  }

  return changes;
}
