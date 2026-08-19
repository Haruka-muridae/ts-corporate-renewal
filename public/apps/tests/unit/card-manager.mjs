/*
 * 名刺管理（public/apps/card-manager/）の検証。
 *
 * records.js / search.js は純粋関数なので、そのまま呼んで確かめる。
 * manager-client.js は fetch を使うため、fetchImpl を差し替えて
 * 実APIへは一切通信しない（card-scanner のテスト方針と同じ）。
 */

import { check, section, finish } from '../helpers/assert.mjs';

const records = await import('../../card-manager/records.js');
const search = await import('../../card-manager/search.js');
const managerClient = await import('../../card-manager/manager-client.js');
const fields = await import('../../card-scanner/fields.js');
const sheetsClient = await import('../../card-scanner/sheets-client.js');

const { SHEET_HEADERS, emailsToColumns } = fields;
const { SPREADSHEET_ID_STORAGE_KEY, SPREADSHEET_NAME } = sheetsClient;

/* ================================================================
   共通の道具
   ================================================================ */

/* buildColumnLayout を使い、位置ずれの心配なくテスト用の行を組み立てる。 */
function buildRawRow(overrides = {}) {
  const layout = records.buildColumnLayout();
  const row = new Array(SHEET_HEADERS.length).fill('');

  layout.forEach(({ key, kind, index }) => {
    if (kind === 'emails') {
      const emails = overrides.emails ?? [];
      const cols = emailsToColumns(emails, overrides.primaryEmail ?? emails[0] ?? '');
      cols.forEach((value, offset) => { row[index + offset] = value; });
      return;
    }

    if (overrides[key] !== undefined) {
      row[index] = overrides[key];
    }
  });

  return row;
}

function okJson(body) {
  return { ok: true, status: 200, json: async () => body };
}

function errJson(status, body = {}) {
  return { ok: false, status, json: async () => body };
}

function makeFetchQueue(responses) {
  let cursor = 0;
  const calls = [];

  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const response = responses[cursor] ?? responses[responses.length - 1];
    cursor += 1;
    return response;
  };

  return { fetchImpl, calls };
}

function installLocalStorageStub(initial = {}) {
  const store = new Map(Object.entries(initial));

  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };

  return store;
}

function clearLocalStorageStub() {
  delete globalThis.localStorage;
}

/* ================================================================
   records.js
   ================================================================ */

section('records.js: 列の位置');

const layout = records.buildColumnLayout();
const totalSpan = layout.reduce((sum, entry) => sum + entry.span, 0);

check('レイアウトの合計幅が全36列と一致する', totalSpan === SHEET_HEADERS.length, totalSpan);
check('先頭はカードID（幅1）', layout[0].key === 'cardId' && layout[0].index === 0 && layout[0].span === 1);

const emailsEntry = layout.find((entry) => entry.kind === 'emails');
check('メール列の幅は4', emailsEntry?.span === 4, emailsEntry);

section('records.js: 見出し行の検証');

check('SHEET_HEADERS そのものは一致する', records.validateHeaderRow([...SHEET_HEADERS]));
check('列数が違えば不一致', !records.validateHeaderRow(SHEET_HEADERS.slice(0, -1)));

const shuffled = [...SHEET_HEADERS];
[shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
check('並び順が違えば不一致（部分一致で続行しない）', !records.validateHeaderRow(shuffled));

const renamed = [...SHEET_HEADERS];
renamed[5] = `${renamed[5]}_old`;
check('ラベルが1つでも違えば不一致', !records.validateHeaderRow(renamed));

section('records.js: Sheetsのシリアル日時');

/* 2021-01-01 00:00 UTC はシリアル値 44197（SheetJS等でも使われる既知の対応値）。 */
check(
  'シリアル値44197は2021-01-01 00:00 UTC',
  (() => {
    const date = records.sheetSerialToDate(44197);
    return date.getUTCFullYear() === 2021
      && date.getUTCMonth() === 0
      && date.getUTCDate() === 1
      && date.getUTCHours() === 0
      && date.getUTCMinutes() === 0;
  })(),
);
check('formatSheetTimestamp(44197) は "2021/01/01 00:00"', records.formatSheetTimestamp(44197) === '2021/01/01 00:00', records.formatSheetTimestamp(44197));
check('空文字は空文字のまま', records.formatSheetTimestamp('') === '');
check('不正な値は空文字', records.formatSheetTimestamp('not-a-number') === '');

section('records.js: 画像リンクの抽出');

check(
  'HYPERLINK式からURLを取り出せる',
  records.extractHyperlinkUrl('=HYPERLINK("https://drive.google.com/file/d/abc","表面画像を見る")') === 'https://drive.google.com/file/d/abc',
);
check('数式でない値は空文字', records.extractHyperlinkUrl('表面画像を見る') === '');
check('空セルは空文字', records.extractHyperlinkUrl('') === '');
check(
  '二重引用符のエスケープを戻す',
  records.extractHyperlinkUrl('=HYPERLINK("https://example.com/?a=""b""","label")') === 'https://example.com/?a="b"',
);

section('records.js: 行 → レコード（往復）');

const sampleRow = buildRawRow({
  cardId: 'CARD-20260101-000001',
  createdAt: 44197,
  updatedAt: 44197,
  ocrAt: '',
  companyId: 'COMPANY-abc123',
  company: '株式会社サンプル',
  department: '営業部',
  title: '部長',
  name: '山田太郎',
  nameKana: 'ヤマダタロウ',
  emails: ['taro@example.com', 'sub@example.com'],
  primaryEmail: 'taro@example.com',
  tel: '03-1234-5678',
  mobile: '090-1234-5678',
  fax: '',
  postalCode: '100-0001',
  address: '東京都千代田区1-1-1',
  website: 'https://example.com',
  socialUrl: '',
  tags: '展示会, 2026年度',
  assignee: '鈴木',
  note: '備考テキスト',
  frontImageUrl: '=HYPERLINK("https://drive.google.com/front","表面画像を見る")',
  backImageUrl: '',
  frontOcr: '表面のOCRテキスト',
  backOcr: '',
  mergedOcr: '表面のOCRテキスト',
  ocrEngine: 'Google Drive OCR',
  ocrConfidence: 78,
  frontImageHash: 'a'.repeat(64),
  backImageHash: '',
  orientation: '横',
  language: '日本語',
  duplicateKey: 'email:taro@example.com',
});

const record = records.rowToRecord(sampleRow, 5);

check('rowNumber をそのまま保持する', record.rowNumber === 5);
check('cardId は auto.cardId と一致する', record.cardId === 'CARD-20260101-000001');
check('field列は文字列で読める（会社名）', record.values.company === '株式会社サンプル');
check('field列は文字列で読める（氏名）', record.values.name === '山田太郎');
check('タグは生の文字列のまま（カンマ区切り）', record.values.tags === '展示会, 2026年度');
check(
  'メールは配列へ戻る（emailsToColumns → columnsToEmails の往復）',
  record.values.emails.length === 2
    && record.values.emails[0] === 'taro@example.com'
    && record.values.emails[1] === 'sub@example.com',
  record.values.emails,
);
check('メインメールが先頭に来る', record.values.primaryEmail === 'taro@example.com');
check('登録日時はシリアル値から変換される', record.auto.createdAt === '2021/01/01 00:00');
check('OCR実行日時が空なら空文字のまま', record.auto.ocrAt === '');
check('OCR信頼度は数値で読める', record.auto.ocrConfidence === 78);
check('表面画像URLはHYPERLINK式からURLだけ取り出す', record.auto.frontImageUrl === 'https://drive.google.com/front');
check('裏面画像URLが空なら空文字', record.auto.backImageUrl === '');
check('auto列の会社IDも読める', record.auto.companyId === 'COMPANY-abc123');
check('raw は読み取った生セルのコピーを持つ', record.raw.length === SHEET_HEADERS.length && record.raw !== sampleRow);

section('records.js: カードIDが空の行');

const blankCardRow = buildRawRow({ cardId: '', company: '空行' });
const blankRecord = records.rowToRecord(blankCardRow, 9);
check('カードIDが空でも変換自体はできる（除外はmanager-client側の責務）', blankRecord.cardId === '');

section('records.js: 編集内容の書き戻し（applyEditsToRow）');

/* escapeCellText / formatTimestamp は呼び出し側から注入する（records.js は純粋関数のみ）。 */
/* 空文字は空文字のまま返す（sheets-client.js の escapeCellText と同じ挙動）。 */
const fakeEscape = (value) => (value === '' ? '' : `ESC(${value})`);
const fakeFormatTimestamp = (date) => `TS(${date.toISOString()})`;
const fixedDate = new Date('2026-02-01T00:00:00.000Z');

const editedRow = records.applyEditsToRow({
  raw: sampleRow,
  values: {
    company: '新しい会社名',
    department: record.values.department,
    title: record.values.title,
    name: record.values.name,
    nameKana: record.values.nameKana,
    tel: record.values.tel,
    mobile: record.values.mobile,
    fax: record.values.fax,
    postalCode: record.values.postalCode,
    address: record.values.address,
    website: record.values.website,
    socialUrl: record.values.socialUrl,
    tags: '新タグ',
    assignee: record.values.assignee,
    note: record.values.note,
    emails: ['new@example.com'],
    primaryEmail: 'new@example.com',
  },
  updatedAt: fixedDate,
  escapeCellText: fakeEscape,
  formatTimestamp: fakeFormatTimestamp,
});

const editedRecord = records.rowToRecord(editedRow, 5);

check('編集した会社名がエスケープを通って反映される', editedRow[layout.find((l) => l.key === 'company').index] === 'ESC(新しい会社名)');
check('タグはformatTagsで整えたうえでエスケープされる', editedRow[layout.find((l) => l.key === 'tags').index] === 'ESC(新タグ)');
check(
  'メールは新しい配列に差し替わる（エスケープを通った値で1件）',
  editedRecord.values.emails.length === 1 && editedRecord.values.emails[0] === 'ESC(new@example.com)',
  editedRecord.values.emails,
);
check('更新日時だけformatTimestampで置き換わる', editedRow[layout.find((l) => l.key === 'updatedAt').index] === 'TS(2026-02-01T00:00:00.000Z)');
check(
  'auto列（更新日時以外）は元のセルをそのまま書き戻す',
  editedRow[layout.find((l) => l.key === 'cardId').index] === sampleRow[layout.find((l) => l.key === 'cardId').index]
    && editedRow[layout.find((l) => l.key === 'frontImageUrl').index] === sampleRow[layout.find((l) => l.key === 'frontImageUrl').index]
    && editedRow[layout.find((l) => l.key === 'createdAt').index] === sampleRow[layout.find((l) => l.key === 'createdAt').index],
);

/* ================================================================
   search.js
   ================================================================ */

section('search.js: 正規化（NFKC → 小文字化 → カタカナ折りたたみ）');

check('全角英数字を半角へ（NFKC）', search.normalizeSearchText('ＡＢＣ１２３') === 'abc123');
check('大文字を小文字へ', search.normalizeSearchText('TARO') === 'taro');
check('カタカナはひらがなへ折りたたむ', search.normalizeSearchText('ヤマダタロウ') === 'やまだたろう');
check('ひらがなはそのまま', search.normalizeSearchText('やまだ') === 'やまだ');
check('漢字はそのまま', search.normalizeSearchText('山田太郎') === '山田太郎');

section('search.js: 全文検索（AND検索）');

function makeRecord(overrides = {}) {
  return {
    rowNumber: overrides.rowNumber ?? 1,
    cardId: overrides.cardId ?? 'CARD-1',
    values: {
      company: '',
      department: '',
      title: '',
      name: '',
      nameKana: '',
      tel: '',
      mobile: '',
      fax: '',
      postalCode: '',
      address: '',
      website: '',
      socialUrl: '',
      tags: '',
      assignee: '',
      note: '',
      emails: [],
      primaryEmail: '',
      ...overrides.values,
    },
    auto: { mergedOcr: '', ...overrides.auto },
  };
}

const rTaro = makeRecord({
  cardId: 'CARD-1',
  values: { name: '山田太郎', company: '株式会社サンプル', tags: '展示会, 重要顧客', emails: ['taro@example.com'] },
});
const rHanako = makeRecord({
  cardId: 'CARD-2',
  values: { name: '鈴木花子', company: 'テスト商事', tags: '重要顧客' },
  auto: { mergedOcr: 'ヤマダ商店との取引あり' },
});

check('氏名で一致する', search.matchesQuery(rTaro, '山田'));
check('会社名で一致する（かな折りたたみを介した検索）', search.matchesQuery(rTaro, 'サンプル'));
check('メールアドレスも検索対象', search.matchesQuery(rTaro, 'taro@example.com'));
check('統合OCRも検索対象', search.matchesQuery(rHanako, 'ヤマダ商店'));
check('スペース区切りはAND検索（両方満たす）', search.matchesQuery(rTaro, '山田 サンプル'));
check('スペース区切りはAND検索（片方しか無ければ不一致）', !search.matchesQuery(rTaro, '山田 テスト商事'));
check('カタカナ/ひらがなを跨いで一致する', search.matchesQuery(rHanako, 'やまだ商店'));
check('空クエリは常に一致', search.matchesQuery(rTaro, ''));
check('一致しない語は不一致', !search.matchesQuery(rTaro, '存在しない語'));

section('search.js: タグ・会社の絞り込み');

check('タグは完全一致（正規化後）', search.matchesTag(rTaro, '展示会'));
check('タグの部分一致では一致しない', !search.matchesTag(rTaro, '展示'));
check('タグ未指定は常に一致', search.matchesTag(rHanako, ''));
check('会社名は完全一致（正規化後）', search.matchesCompany(rHanako, 'テスト商事'));
check('会社名の部分一致では一致しない', !search.matchesCompany(rHanako, 'テスト'));

section('search.js: filterRecords（組み合わせ）');

const filtered = search.filterRecords([rTaro, rHanako], { query: '', tag: '重要顧客', company: '' });
check('タグ絞り込みだけで2件とも残る', filtered.length === 2, filtered.map((r) => r.cardId));

const filtered2 = search.filterRecords([rTaro, rHanako], { query: '山田', tag: '', company: '' });
check('全文検索を組み合わせると1件になる', filtered2.length === 1 && filtered2[0].cardId === 'CARD-1');

section('search.js: 選択肢の収集');

const tagOptions = search.collectTagOptions([rTaro, rHanako]);
check('タグの選択肢が重複なく集まる', tagOptions.includes('展示会') && tagOptions.includes('重要顧客') && tagOptions.length === 2, tagOptions);

const companyOptions = search.collectCompanyOptions([rTaro, rHanako]);
check('会社名の選択肢が集まる', companyOptions.includes('株式会社サンプル') && companyOptions.includes('テスト商事'), companyOptions);

/* ================================================================
   manager-client.js（fetchをスタブし、実APIへは通信しない）
   ================================================================ */

section('manager-client.js: 台帳の特定（resolveLedger）');

clearLocalStorageStub();
{
  const result = await managerClient.resolveLedger({
    token: 't',
    fetchImpl: async () => { throw new Error('キャッシュが無いのに通信してはいけない'); },
  });
  check('キャッシュが無ければ通信せず見つからない扱いにする', result.found === false && result.spreadsheetId === '');
}

installLocalStorageStub({ [SPREADSHEET_ID_STORAGE_KEY]: 'SHEET-CACHED' });
{
  const { fetchImpl, calls } = makeFetchQueue([okJson({ properties: { title: SPREADSHEET_NAME } })]);
  const result = await managerClient.resolveLedger({ token: 't', fetchImpl });
  check('キャッシュのIDが実在し名前も一致すれば見つかる', result.found === true && result.spreadsheetId === 'SHEET-CACHED');
  check('Sheets APIを1回だけ呼ぶ', calls.length === 1);
}

installLocalStorageStub({ [SPREADSHEET_ID_STORAGE_KEY]: 'SHEET-DELETED' });
{
  const { fetchImpl } = makeFetchQueue([errJson(404)]);
  const result = await managerClient.resolveLedger({ token: 't', fetchImpl });
  check('404なら見つからない扱いにする（例外を投げない）', result.found === false);
}

installLocalStorageStub({ [SPREADSHEET_ID_STORAGE_KEY]: 'SHEET-RENAMED' });
{
  const { fetchImpl } = makeFetchQueue([okJson({ properties: { title: '別の名前の台帳' } })]);
  const result = await managerClient.resolveLedger({ token: 't', fetchImpl });
  check('名前が一致しなければ見つからない扱いにする', result.found === false);
}

clearLocalStorageStub();

section('manager-client.js: 全行の読み込み（readAllRecords）');

{
  const dataRow = buildRawRow({ cardId: 'CARD-1', name: '山田太郎', company: 'サンプル' });
  const { fetchImpl } = makeFetchQueue([okJson({ values: [[...SHEET_HEADERS], dataRow] })]);
  const { records: loaded } = await managerClient.readAllRecords({ token: 't', spreadsheetId: 'SS', fetchImpl });
  check('データ行が1件読み込める', loaded.length === 1 && loaded[0].cardId === 'CARD-1');
  check('行番号は見出し行を1行目として数える', loaded[0].rowNumber === 2);
}

{
  const blankRow = buildRawRow({ cardId: '', name: '空行' });
  const dataRow = buildRawRow({ cardId: 'CARD-2', name: '花子' });
  const { fetchImpl } = makeFetchQueue([okJson({ values: [[...SHEET_HEADERS], blankRow, dataRow] })]);
  const { records: loaded } = await managerClient.readAllRecords({ token: 't', spreadsheetId: 'SS', fetchImpl });
  check('カードIDが空の行は一覧から除く', loaded.length === 1 && loaded[0].cardId === 'CARD-2');
}

{
  const brokenHeader = [...SHEET_HEADERS];
  brokenHeader[3] = '壊れた見出し';
  const { fetchImpl } = makeFetchQueue([okJson({ values: [brokenHeader] })]);

  let thrown = null;
  try {
    await managerClient.readAllRecords({ token: 't', spreadsheetId: 'SS', fetchImpl });
  } catch (error) {
    thrown = error;
  }

  check(
    '見出し不一致は部分一致で続行せず例外にする',
    thrown instanceof managerClient.ManagerError && thrown.code === managerClient.ManagerErrorCode.HEADER_MISMATCH,
    thrown,
  );
}

section('manager-client.js: 行ずれ防止（updateRecord）');

{
  const freshRow = buildRawRow({
    cardId: 'CARD-20260101-000001',
    company: '元の会社名',
    name: '山田太郎',
    createdAt: 44197,
  });

  const { fetchImpl, calls } = makeFetchQueue([
    okJson({ values: [freshRow] }),
    okJson({ updates: { updatedRange: 'F2:AJ2' } }),
  ]);

  const targetRecord = { rowNumber: 2, cardId: 'CARD-20260101-000001' };
  const editValues = {
    company: '新しい会社名',
    department: '',
    title: '',
    name: '山田太郎',
    nameKana: '',
    tel: '',
    mobile: '',
    fax: '',
    postalCode: '',
    address: '',
    website: '',
    socialUrl: '',
    tags: '',
    assignee: '',
    note: '',
    emails: [],
    primaryEmail: '',
  };

  const updated = await managerClient.updateRecord({
    token: 't',
    spreadsheetId: 'SS',
    record: targetRecord,
    values: editValues,
    fetchImpl,
  });

  check('カードIDが一致すれば更新できる', updated.values.company === '新しい会社名');
  check('再取得(GET)と更新(PUT)の2回だけ呼ぶ', calls.length === 2);
  check('1回目は再取得（GETのまま）', calls[0].method === 'GET');
  check('2回目がPUTで更新する', calls[1].method === 'PUT');
  check(
    '更新日時は "YYYY/MM/DD HH:mm" 形式で新しく入る',
    /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(updated.auto.updatedAt),
    updated.auto.updatedAt,
  );
  check(
    '登録日時（auto列）は変更されず元のまま',
    updated.auto.createdAt === '2021/01/01 00:00',
  );
}

{
  const shiftedRow = buildRawRow({ cardId: 'CARD-DIFFERENT', company: '別の名刺' });
  const { fetchImpl, calls } = makeFetchQueue([okJson({ values: [shiftedRow] })]);

  const targetRecord = { rowNumber: 2, cardId: 'CARD-20260101-000001' };

  let thrown = null;

  try {
    await managerClient.updateRecord({
      token: 't',
      spreadsheetId: 'SS',
      record: targetRecord,
      values: { emails: [], primaryEmail: '' },
      fetchImpl,
    });
  } catch (error) {
    thrown = error;
  }

  check(
    'カードIDが一致しなければ ROW_CONFLICT を投げる',
    thrown instanceof managerClient.ManagerError && thrown.code === managerClient.ManagerErrorCode.ROW_CONFLICT,
    thrown,
  );
  check('不一致のときは更新(PUT)を送らない', calls.length === 1 && calls[0].method === 'GET');
}

clearLocalStorageStub();

finish();
