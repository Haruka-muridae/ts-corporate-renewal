/*
 * 保存先スプレッドシートの構造定義と、その検証（仕様書 §9.1 / §9.4）。
 *
 * ==================================================================
 * 列の並びは暫定である（要判断事項）
 * ==================================================================
 * §9.1 は「タブ『領収書データ』は v1.3 の 16.1 と同一の列構成（サーバー専用列を除く）」
 * と定めているが、**v1.3 が未提供のため、正確な列名と並びを確認できていない。**
 *
 * ここに置いた DATA_COLUMNS は、v2.0 が本文中で名指しした列
 * （必須3項目・レシートNo.・電話番号・税率別内訳・表記区分・支払方法・
 *   登録番号状態・勘定科目候補・科目確定フラグ・宛名・但し書き・
 *   reviewStatus・extractionMethod・画像ハッシュ）から組み立てた暫定版である。
 * §9.1 が削除を指示した列（idempotencyKey / processingStatus / 処理台帳関連 /
 * 登録者（申告値））は入れていない。
 *
 * §9.4 は「既存列の削除・並べ替え・改名を行わない」と定めているため、
 * **利用者のシートを実際に作り始めたあとで並びを直すことはできない。**
 * v1.3 の 16.1 と突き合わせて確定するまで、SCHEMA_VERSION は draft のままにする。
 * 確定後は、この定義を差し替えたうえで版を 1.0 へ上げること。
 *
 * 逆に言えば、直すのはこのファイル1つで足りる。
 * プロビジョニングも検証も、列名を直接書かずここを参照している。
 * ==================================================================
 */

/*
 * スキーマの版。設定タブへ記録する（§9.4）。
 * draft のあいだは、列の並びが変わりうることを示す。
 */
export const SCHEMA_VERSION = '0.9-draft';

/* タブ名（§9.1）。 */
export const TABS = Object.freeze({
  data: '領収書データ',
  ocrText: 'OCR原文',
  storeMaster: '店舗マスタ',
  settings: '設定',
});

/* タブの並び順。作成と欠損検出の両方でこの順を使う。 */
export const TAB_ORDER = Object.freeze([
  TABS.data,
  TABS.ocrText,
  TABS.storeMaster,
  TABS.settings,
]);

/*
 * タブ「領収書データ」の列（暫定。冒頭の注記を読むこと）。
 *
 * key は画面とコードが使う識別子、header はシートに書く実際の見出し。
 * 検証は header の完全一致で行う（§9.4）。
 */
export const DATA_COLUMNS = Object.freeze([
  { key: 'recordId', header: '管理ID' },
  { key: 'createdAt', header: '登録日時' },
  { key: 'usedOn', header: '利用日', required: true },
  { key: 'payee', header: '支払先', required: true },
  { key: 'totalAmount', header: '合計金額', required: true },
  { key: 'taxRate10Base', header: '10%対象額' },
  { key: 'taxRate10Amount', header: '10%消費税' },
  { key: 'taxRate8Base', header: '8%対象額' },
  { key: 'taxRate8Amount', header: '8%消費税' },
  { key: 'taxNotation', header: '税表記区分' },
  { key: 'paymentMethod', header: '支払方法' },
  { key: 'receiptNumber', header: 'レシートNo.' },
  { key: 'phoneNumber', header: '電話番号' },
  { key: 'registrationNumber', header: '登録番号' },
  { key: 'registrationStatus', header: '登録番号状態' },
  { key: 'accountCandidate', header: '勘定科目候補' },
  { key: 'accountConfirmed', header: '科目確定' },
  { key: 'addressee', header: '宛名' },
  { key: 'note', header: '但し書き' },
  { key: 'confidence', header: '信頼度' },
  { key: 'reviewStatus', header: '確認状態' },
  { key: 'extractionMethod', header: '抽出方法' },
  { key: 'imageHash', header: '画像ハッシュ' },
  { key: 'originalFileId', header: '原本ファイルID' },
  { key: 'originalLink', header: '原本リンク' },
  { key: 'updatedAt', header: '更新日時' },
]);

/* タブ「OCR原文」の列（§9.1「管理IDと紐付け」）。 */
export const OCR_TEXT_COLUMNS = Object.freeze([
  { key: 'recordId', header: '管理ID' },
  { key: 'engine', header: 'OCRエンジン' },
  { key: 'capturedAt', header: '取得日時' },
  { key: 'text', header: 'OCR原文' },
]);

/* タブ「店舗マスタ」の列。 */
export const STORE_MASTER_COLUMNS = Object.freeze([
  { key: 'storeName', header: '店舗名' },
  { key: 'normalizedName', header: '正規化名' },
  { key: 'accountCandidate', header: '勘定科目候補' },
  { key: 'registrationNumber', header: '登録番号' },
]);

/* タブ「設定」の列。閾値等の利用者別設定＋スキーマバージョン（§9.1）。 */
export const SETTINGS_COLUMNS = Object.freeze([
  { key: 'name', header: '設定名' },
  { key: 'value', header: '値' },
  { key: 'note', header: '説明' },
]);

/* 設定タブに書く行のうち、アプリが意味を持って読むもの。 */
export const SETTINGS_KEYS = Object.freeze({
  schemaVersion: 'スキーマバージョン',
});

export const TAB_COLUMNS = Object.freeze({
  [TABS.data]: DATA_COLUMNS,
  [TABS.ocrText]: OCR_TEXT_COLUMNS,
  [TABS.storeMaster]: STORE_MASTER_COLUMNS,
  [TABS.settings]: SETTINGS_COLUMNS,
});

/*
 * 初期店舗マスタ（§9.1「初期マスタ（0.6項で確定した値）を書き込む」）。
 *
 * §0.6-2 が「勘定科目候補の初期マスタ」を経理・税理士の確認事項として
 * 挙げており、**まだ確定していない。** 確定するまで空で作成する。
 * 空でもヘッダー行は書くため、あとから行を足すだけで済む。
 */
export const INITIAL_STORE_MASTER = Object.freeze([]);

/* 「要確認一覧」フィルタビューの名前（§11・§15.2）。 */
export const REVIEW_FILTER_VIEW_NAME = '要確認一覧';

/* ---------- 検証（純関数） ---------- */

export function headersOf(columns) {
  return columns.map((column) => column.header);
}

export function columnIndex(columns, key) {
  return columns.findIndex((column) => column.key === key);
}

/* 列番号（0始まり）を A1 表記の列文字へ変える。ハッシュ列だけを読むときに使う（§10）。 */
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
 * 戻り値の status:
 *   'ok'      … 期待どおり。書き込んでよい
 *   'upgrade' … 旧バージョン。期待の先頭部分と一致し、右端が足りないだけ。
 *               不足分を右端へ追加すれば使える（missing に列定義が入る）
 *   'altered' … 並べ替え・削除・改名。**書き込みを停止する**（DRV-002）
 *   'empty'   … ヘッダーが無い。作りかけとみなし、書き直してよい
 *
 * 判定は名前の完全一致で行う。前後の空白だけは落とす
 * （シートの手編集で紛れ込みやすく、これを改変とみなすと復旧できなくなる）。
 *
 * 実際の列が期待より多い場合は 'ok' とする。§9.4 が許すのは右端への追加だけなので、
 * 先頭が一致していれば、新しい版のアプリが足した列を古い版が見ている状態にあたる。
 * 知らない列には触れず、既知の列だけを読み書きする。
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

/* 欠損しているタブ（§9.3「タブ削除」）。並びは TAB_ORDER に従う。 */
export function missingTabs(existingTitles) {
  const present = new Set(
    (Array.isArray(existingTitles) ? existingTitles : []).map((title) => String(title ?? '').trim()),
  );

  return TAB_ORDER.filter((title) => !present.has(title));
}

/*
 * データタブが欠けているか。
 * §9.3 は「データタブが消えた場合はシート削除に準じる案内」を求めており、
 * 欠損タブの再作成とは扱いを分ける。
 */
export function isDataTabMissing(existingTitles) {
  return missingTabs(existingTitles).includes(TABS.data);
}
