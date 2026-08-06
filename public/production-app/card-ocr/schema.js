/*
 * 台帳の列構成と、1行の組み立て（要件定義書 §11.2・§11.3）。
 *
 * ==================================================================
 * ここに通信を書かない
 * ==================================================================
 * 列の定義と、値から行を作るところまで。Sheets の呼び出しは sheets.js。
 * 分けてあるのは、列構成の正しさを通信なしで確かめられるようにするため。
 * ==================================================================
 *
 * ==================================================================
 * 見出しの決め方
 * ==================================================================
 * §11.2 は「v1.1 の列構成を基本とし」としているが、**v1.1 はこの
 * リポジトリに無い。** そこで、
 *
 *   - §11.2 が名前を明示している列（record_id / front_file_id /
 *     has_back / back_filled_fields / app_version など）は**その名前**
 *   - 名刺の中身にあたる列は、検証用PoC が使っていた日本語の見出し
 *
 * とした。人が開いて読む表なので、中身の列は日本語のほうがよい。
 * **v1.1 の実物が出てきて食い違ったら、そちらに合わせる。**
 * ==================================================================
 */

import { escapeCellText, buildImageLink } from './sanitize.js';

/*
 * 台帳の見出し行の版（§11.2）。
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

  /* v3.1: 面ごとの列。裏面が無くても列は必ず置く（§11.2）。 */
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

  /*
   * ==================================================================
   * v3.5: その他。**必ず右端に足すこと。**
   * ==================================================================
   * 中身の列なので、本当は「URL」の隣に置きたい。**置けない。**
   *
   * 既にある利用者のシートは26列で、見出しの並びで正しさを判定して
   * いる（verifyHeader）。途中へ挿すと、既存のシートが `altered` と
   * 判定されて**書き込みが止まる**。右端に足せば `upgrade` になり、
   * 不足分が自動で追加されて使い続けられる。
   *
   * **今後、列を足すときも必ず右端にすること。**
   * ==================================================================
   */
  { key: 'otherInformation', header: 'その他' },
]);

/* 変更履歴タブ（§11.3）。changed_by は本人のみのため持たない。 */
export const HISTORY_COLUMNS = Object.freeze([
  { key: 'historyId', header: 'history_id' },
  { key: 'changedAt', header: 'changed_at' },
  { key: 'recordId', header: 'record_id' },
  { key: 'fieldName', header: 'field_name' },
  { key: 'oldValue', header: 'old_value' },
  { key: 'newValue', header: 'new_value' },
]);

/*
 * 画像リンクの列。**サニタイズを通さず、こちらが数式を組み立てる。**
 * §11.2 が =HYPERLINK() を要求しており、利用者入力ではない。
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
 * 改変を見つけたら、列の位置を推測しないこと
 * ==================================================================
 * 利用者が列を入れ替えたシートへ、こちらの並びで書き込むと
 * **値が別の列に入る。** 名刺は第三者の個人情報なので、
 * 電話番号の欄にメールが入るような壊し方をしてはならない。
 * 直せないと分かった時点で止め、利用者に知らせる。
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

/* 欠けているタブ。 */
export function missingTabs(existingTitles, required) {
  const present = new Set(
    (Array.isArray(existingTitles) ? existingTitles : []).map((title) => String(title ?? '').trim()),
  );

  return required.filter((title) => !present.has(title));
}

/*
 * 重複判定キー（FR-19）。
 *
 * メール → 携帯 → 会社名＋氏名 の優先順位。card-scanner と同じ。
 * **表記ゆれを吸収するため小文字化と空白除去を行う。**
 * 会社名＋氏名まで落ちるのは連絡先が1つも無い名刺で、
 * その場合は同姓同名の別人を同一視しうるので、
 * **確定ではなく「候補」として扱う**（DUP-002）。
 */
/* 比較のための正規化。表記ゆれ（大文字小文字・空白）を吸収する。 */
export function normalizeForCompare(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

/*
 * 会社名＋氏名のキー（FR-17 の属性ベース判定）。
 *
 * **buildDuplicateKey とは別に作る。** あちらはメールがあればメールを
 * 返すので、「メールは違うが同じ会社の同じ人」を拾えない。
 * 同じ名刺を撮り直した場合はハッシュが変わるため、こちらで拾う。
 *
 * **会社名と氏名の両方が埋まっているときだけキーを作る。**
 * 片方だけで同一人物と判断すると、同姓の別会社や、社名しか読めなかった
 * 名刺どうしを同じものと見なしてしまう。
 */
export function buildNameKey({ companyName = '', fullName = '' } = {}) {
  const company = normalizeForCompare(companyName);
  const name = normalizeForCompare(fullName);

  if (company === '' || name === '') {
    return '';
  }

  return `${company}/${name}`;
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
 * **値は必ずサニタイズを通す**（画像リンクの2列を除く。上の LINK_COLUMNS）。
 * 配列は空白区切りの文字列にする（uncertainFields、backFilledFields）。
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

    /* false は「裏面なし」。空欄にする（§11.2「back_* は空にする」）。 */
    if (raw === false) {
      return '';
    }

    return escapeCellText(raw);
  });
}

export function buildHistoryRow(values = {}) {
  return buildDataRow(values, HISTORY_COLUMNS);
}
