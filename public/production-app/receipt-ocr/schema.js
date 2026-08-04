/*
 * 保存先スプレッドシートの構造定義と、その検証。
 * 仕様: receipt-ocr-v2.md §9.1 / §9.4、receipt-ocr-v1.3.md §16.1〜16.3
 *
 * ==================================================================
 * 列の並びは v1.3 §16.1 が正
 * ==================================================================
 * v2.0 §9.1 が「v1.3 の 16.1 と同一の列構成（サーバー専用列を除く）」と
 * 定めている。したがって並びは v1.3 の表の順序をそのまま使う。
 *
 * v2.0 §9.1 の指示により削除した列（3つ）:
 *   B  idempotencyKey   … サーバーの冪等性制御ごと廃止
 *   X  processingStatus … 2段階フローが無くなり、状態が「処理中」を取らない
 *   AB 登録者（申告値）  … 本人のシートなので不要
 *
 * v1.3 の枝番レター（E2 / G2 / M2〜M7 / B2）は暫定表記だったため、
 * 削除後の並びで連続したレターへ振り直した。対応表は下の COLUMN_MAP_NOTE。
 *
 * ------------------------------------------------------------------
 * §9.4 により、ここから先は「右端への追加」しかできない
 * ------------------------------------------------------------------
 * 既存列の削除・並べ替え・改名を行わないこと。
 * 利用者のシートが作られたあとで並びを変えると、過去のデータがずれる。
 * 列を足すときは必ず配列の末尾へ足し、SCHEMA_VERSION を上げる。
 * ------------------------------------------------------------------
 */

/*
 * スキーマの版。設定タブへ記録する（§9.4）。
 * 1.0 = v1.3 §16.1 と突き合わせて確定した版。
 */
export const SCHEMA_VERSION = '1.0';

/*
 * v1.3 §16.1 の列レター → 確定後の列レター。
 * 仕様書と実物を突き合わせるときに使う。コードからは参照しない。
 *
 * 見出しを変えたのは2列だけ（2026-08-03 承認済み）。
 * C「API受付日時」→「登録日時」、U「補完実施有無（第2段階）」→「補完実施」。
 * v2.0 には API も2段階フローも存在せず、v1.3 の名前のままでは
 * 実在しない仕組みを指してしまうため。v1.3 の表記には戻さない。
 */
export const COLUMN_MAP_NOTE = Object.freeze({
  A: 'A', C: 'B', D: 'C', E: 'D', E2: 'E', F: 'F', G: 'G', G2: 'H',
  H: 'I', I: 'J', J: 'K', K: 'L', L: 'M', M: 'N', M2: 'O', M3: 'P',
  M4: 'Q', M5: 'R', M6: 'S', M7: 'T', N: 'U', O: 'V', P: 'W', Q: 'X',
  R: 'Y', S: 'Z', T: 'AA', U: 'AB', V: 'AC', W: 'AD', Y: 'AE', Z: 'AF',
  AA: 'AG', AC: 'AH',
});

/* タブ名（v2.0 §9.1）。処理台帳・処理ログはサーバー要素のため作らない。 */
export const TABS = Object.freeze({
  data: '領収書データ',
  ocrText: 'OCR原文',
  storeMaster: '店舗マスタ',
  settings: '設定',
});

export const TAB_ORDER = Object.freeze([
  TABS.data,
  TABS.ocrText,
  TABS.storeMaster,
  TABS.settings,
]);

/*
 * タブ「領収書データ」の列（v1.3 §16.1）。
 *
 * key   … コードが使う識別子
 * header… シートに書く見出し。**検証は名前の完全一致で行う**（§9.4）
 * kind  … 'number' の列は数値として書く（v1.3 §16.1 の書き込み要件）
 */
export const DATA_COLUMNS = Object.freeze([
  { key: 'recordId', header: '管理ID' },
  { key: 'createdAt', header: '登録日時' },
  { key: 'usedOn', header: '利用日', required: true },
  { key: 'payee', header: '支払先', required: true },
  { key: 'phoneNumber', header: '電話番号' },
  { key: 'addressee', header: '宛名' },
  { key: 'note', header: '但し書き' },
  { key: 'receiptNumber', header: 'レシートNo.' },
  { key: 'summary', header: '摘要' },
  { key: 'accountCandidate', header: '勘定科目候補' },
  { key: 'accountSource', header: '科目候補の出所' },
  { key: 'accountConfirmed', header: '科目確定フラグ' },
  { key: 'totalAmount', header: '合計金額', kind: 'number', required: true },
  { key: 'taxTotal', header: '消費税合計', kind: 'number' },
  { key: 'tax8Base', header: '8％対象額', kind: 'number' },
  { key: 'tax8Amount', header: '8％消費税額', kind: 'number' },
  { key: 'tax10Base', header: '10％対象額', kind: 'number' },
  { key: 'tax10Amount', header: '10％消費税額', kind: 'number' },
  { key: 'taxNotation', header: '対象額の表記区分' },
  { key: 'paymentMethod', header: '支払方法' },
  { key: 'registrationNumber', header: '登録番号' },
  { key: 'registrationStatus', header: '登録番号状態' },
  { key: 'originalFileName', header: '原本ファイル名' },
  { key: 'originalFileId', header: '原本ファイルID' },
  { key: 'originalUrl', header: '原本画像URL', required: true },
  { key: 'imageHash', header: 'SHA-256' },
  { key: 'extractionMethod', header: 'extractionMethod' },
  { key: 'completionUsed', header: '補完実施' },
  { key: 'confidenceScore', header: '信頼度スコア', kind: 'number' },
  { key: 'confidenceLevel', header: '信頼度区分' },
  { key: 'reviewStatus', header: 'reviewStatus' },
  { key: 'duplicateStatus', header: 'duplicateStatus' },
  { key: 'warnings', header: '警告内容' },
  { key: 'updatedAt', header: '更新日時' },
]);

/* タブ「OCR原文」の列（v1.3 §16.2）。 */
export const OCR_TEXT_COLUMNS = Object.freeze([
  { key: 'recordId', header: '管理ID' },
  { key: 'text', header: 'OCR原文' },
  { key: 'savedAt', header: '保存日時' },
]);

/* タブ「店舗マスタ」の列（v1.3 §16.3。B2 は連続レターへ振り直し）。 */
export const STORE_MASTER_COLUMNS = Object.freeze([
  { key: 'keyword', header: '店舗キーワード' },
  { key: 'officialName', header: '正式名称' },
  { key: 'phoneNumber', header: '電話番号' },
  { key: 'accountCandidate', header: '勘定科目候補' },
  { key: 'summaryDefault', header: '摘要初期値' },
  { key: 'enabled', header: '有効・無効' },
  { key: 'note', header: '備考' },
]);

/* タブ「設定」の列。 */
export const SETTINGS_COLUMNS = Object.freeze([
  { key: 'name', header: '設定名' },
  { key: 'value', header: '値' },
  { key: 'note', header: '説明' },
]);

/* アプリが意味を持って読む設定（v1.3 §16.6 のうち、ブラウザ完結で意味のあるもの）。 */
export const SETTINGS_KEYS = Object.freeze({
  schemaVersion: 'スキーマバージョン',
  minOcrLength: 'OCR文字数の最低基準',
  maxAmount: '金額の上限',
  pastDateLimitDays: '日付の過去閾値（日）',
  confidenceHigh: '信頼度しきい値（高）',
  confidenceMedium: '信頼度しきい値（中）',
  duplicateEnabled: '重複判定',
  similarEnabled: '類似判定',
  geminiEnabled: 'Gemini使用',
});

/*
 * 設定の初期値（v1.3 §16.6）。
 *
 * OCR文字数の最低基準 30 は v1.3 §11 が明示している。
 * 金額上限 1,000万円未満・過去閾値1年超は v1.3 §13.1 / §13.2 から。
 * 信頼度のしきい値は v1.3 §14 が「設定シートで管理し、フェーズ0・
 * 受入テストで校正する」としており、初期値の指定が無い。
 * 満点200点に対する暫定値を置く（要判断事項として報告済み）。
 */
export const DEFAULT_SETTINGS = Object.freeze([
  [SETTINGS_KEYS.minOcrLength, 30, 'これ未満の文字数はAI補完せず要確認にする（v1.3 §11）'],
  [SETTINGS_KEYS.maxAmount, 10000000, '合計金額の上限。これ以上は要確認（v1.3 §13.1）'],
  [SETTINGS_KEYS.pastDateLimitDays, 365, 'これより古い日付は要確認（v1.3 §13.2）'],
  [SETTINGS_KEYS.confidenceHigh, 120, 'このスコア以上を「高」とする（暫定値）'],
  [SETTINGS_KEYS.confidenceMedium, 60, 'このスコア以上を「中」とする（暫定値）'],
  [SETTINGS_KEYS.duplicateEnabled, 'TRUE', '同一画像の重複判定を行うか'],
  [SETTINGS_KEYS.similarEnabled, 'TRUE', '同日・同店舗・同金額の類似警告を出すか'],
  [SETTINGS_KEYS.geminiEnabled, 'TRUE', 'AI補完を使うか（v1.3 §11）'],
]);

export const TAB_COLUMNS = Object.freeze({
  [TABS.data]: DATA_COLUMNS,
  [TABS.ocrText]: OCR_TEXT_COLUMNS,
  [TABS.storeMaster]: STORE_MASTER_COLUMNS,
  [TABS.settings]: SETTINGS_COLUMNS,
});

/*
 * 初期店舗マスタ。
 * v1.3 §10.8 が「本書には具体的な対応表を記載しない。初期値は経理担当が定義する」
 * としており、v2.0 §0.6-2 でも未確定のため空で作成する。
 */
export const INITIAL_STORE_MASTER = Object.freeze([]);

/* 「要確認一覧」フィルタビューの名前（v1.3 §18.1・v2.0 §11）。 */
export const REVIEW_FILTER_VIEW_NAME = '要確認一覧';

/* ---------- 検証（純関数） ---------- */

export function headersOf(columns) {
  return columns.map((column) => column.header);
}

export function columnIndex(columns, key) {
  return columns.findIndex((column) => column.key === key);
}

export function columnOf(columns, key) {
  return columns.find((column) => column.key === key) ?? null;
}

/* 列番号（0始まり）を A1 表記の列文字へ。 */
export function columnLetter(index) {
  let n = Number(index);

  if (!Number.isInteger(n) || n < 0) {
    return '';
  }

  let letter = '';

  do {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);

  return letter;
}

/*
 * ヘッダー行の検証（§9.4）。
 *
 *   'ok'      … 期待どおり。書き込んでよい
 *   'upgrade' … 旧版。期待の先頭部分と一致し、右端が足りないだけ
 *   'altered' … 並べ替え・削除・改名。**書き込みを停止する**（DRV-002）
 *   'empty'   … ヘッダーが無い。作りかけとみなす
 *
 * 判定は名前の完全一致。前後の空白だけは落とす
 * （シートの手編集で紛れ込みやすく、これを改変とみなすと復旧できなくなる）。
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

/* 欠損しているタブ（§9.3「タブ削除」）。 */
export function missingTabs(existingTitles) {
  const present = new Set(
    (Array.isArray(existingTitles) ? existingTitles : []).map((title) => String(title ?? '').trim()),
  );

  return TAB_ORDER.filter((title) => !present.has(title));
}

/* データタブが欠けているか（§9.3 は「シート削除に準じる案内」を求める）。 */
export function isDataTabMissing(existingTitles) {
  return missingTabs(existingTitles).includes(TABS.data);
}
