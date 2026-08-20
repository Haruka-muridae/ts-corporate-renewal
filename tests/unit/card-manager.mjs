/*
 * 名刺管理アプリ（public/production-app/card-manager/）の検証。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - card-ocr とクライアントID・スコープ（drive.file のみ）が一致すること
 *     （drive.file はクライアントIDごとに見える範囲が分かれるため、
 *     ずれると card-ocr が作った台帳「名刺管理」が見えなくなる。
 *     tests/unit/interview-recorder.mjs と同じパターン）
 *   - 台帳の場所の解決が**検索だけ**で、見つからなくても作らないこと
 *   - 見出し行の版（'ok'/'upgrade'/'altered'/'empty'）に応じて
 *     読み込み・書き込みの可否が正しく分かれること
 *   - 行 ⇄ レコードの往復変換で、自動項目（画像リンクの数式・record_id 等）
 *     が書き換えられずに残ること
 *   - 保存直前に record_id を再確認し、一致しなければ ROW_CONFLICT に
 *     なること（他端末での競合を上書きしない）
 *   - 変更履歴タブへの記録に失敗しても、台帳の更新そのものは失敗にしないこと
 *   - トークンが例外・画面用文言に漏れないこと
 * ==================================================================
 *
 * ブラウザ用モジュールを Node からそのまま import する（card-mail /
 * card-ocr のテストと同じやり方）。
 */

import { readFile } from 'node:fs/promises';

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  APP_FOLDER_NAME,
  DRIVE_SCOPE,
  GOOGLE_CLIENT_ID,
  ROOT_FOLDER_NAME,
  SPREADSHEET_NAME,
  isClientIdConfigured,
} from '../../public/production-app/card-manager/config.js';

import {
  DATA_COLUMNS,
  HISTORY_COLUMNS,
  headersOf,
  verifyHeader,
} from '../../public/production-app/card-manager/schema.js';

import {
  CONTENT_FIELDS,
  META_FIELDS,
  applyEditsToRow,
  checkHeader,
  extractHyperlinkUrl,
  formatRegisteredAtDisplay,
  rowToRecord,
} from '../../public/production-app/card-manager/records.js';

import {
  collectCompanyOptions,
  filterRecords,
  matchesCompany,
  matchesQuery,
  normalizeSearchText,
} from '../../public/production-app/card-manager/search.js';

import { hasDriveScope } from '../../public/production-app/card-manager/drive-auth.js';
import { describeDriveError, mapHttpErrorToCode } from '../../public/production-app/card-manager/drive-api.js';

import {
  ManagerError,
  ManagerErrorCode,
  readAllRecords,
  resolveLedger,
  updateRecord,
} from '../../public/production-app/card-manager/manager-client.js';

const APP_DIR = new URL('../../public/production-app/card-manager/', import.meta.url);

/* 比較対象。こちらは値を読むだけで、変更の起点にはしない。 */
const cardOcrConfig = await import('../../public/production-app/card-ocr/config.js');

try {
  /* ---------------------------------------------------------------- */
  section('クライアントID・スコープ（card-ocr との一致）');

  check(
    '★クライアントIDが card-ocr と同一（drive.file の可視範囲を共有するため）',
    GOOGLE_CLIENT_ID === cardOcrConfig.GOOGLE_CLIENT_ID,
    `card-manager=${GOOGLE_CLIENT_ID} / card-ocr=${cardOcrConfig.GOOGLE_CLIENT_ID}`,
  );

  check('クライアントIDの形が正しい', GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com'));
  check('設定済みと判定される', isClientIdConfigured() === true);
  check('空文字は未設定として扱う', isClientIdConfigured('') === false);

  check('スコープは drive.file だけ', DRIVE_SCOPE === 'https://www.googleapis.com/auth/drive.file');
  check(
    '★スコープが card-ocr と一致している',
    DRIVE_SCOPE === cardOcrConfig.DRIVE_SCOPE,
  );
  check('★スコープに drive 全体・gmail が混ざっていない', !/auth\/drive$|gmail/.test(DRIVE_SCOPE));

  check(
    '★保存構造（フォルダ・台帳名）が card-ocr と一致している',
    ROOT_FOLDER_NAME === cardOcrConfig.ROOT_FOLDER_NAME
    && APP_FOLDER_NAME === cardOcrConfig.APP_FOLDER_NAME
    && SPREADSHEET_NAME === cardOcrConfig.SPREADSHEET_NAME,
    `card-manager=${ROOT_FOLDER_NAME}/${APP_FOLDER_NAME}/${SPREADSHEET_NAME} `
    + `card-ocr=${cardOcrConfig.ROOT_FOLDER_NAME}/${cardOcrConfig.APP_FOLDER_NAME}/${cardOcrConfig.SPREADSHEET_NAME}`,
  );

  {
    const granted = (scope) => hasDriveScope({ scope });
    check('drive.file が付与されていれば true', granted(DRIVE_SCOPE) === true);
    check('別スコープだけなら false', granted('https://www.googleapis.com/auth/drive') === false);
  }

  /* ---------------------------------------------------------------- */
  section('台帳の列構成（card-ocr/schema.js との一致を、複製として固定）');

  const cardOcrSchema = await import('../../public/production-app/card-ocr/schema.js');

  check(
    '★列の並び・キーが card-ocr/schema.js と1対1で一致している',
    JSON.stringify(headersOf(DATA_COLUMNS)) === JSON.stringify(cardOcrSchema.headersOf(cardOcrSchema.DATA_COLUMNS))
    && DATA_COLUMNS.every((c, i) => c.key === cardOcrSchema.DATA_COLUMNS[i].key),
  );
  check(
    '★SCHEMA_VERSION が card-ocr と一致している',
    (await import('../../public/production-app/card-manager/schema.js')).SCHEMA_VERSION
      === cardOcrSchema.SCHEMA_VERSION,
  );

  /* ---------------------------------------------------------------- */
  section('見出し行の検証');

  const header = headersOf(DATA_COLUMNS);

  check("完全一致は 'ok'", verifyHeader(header).status === 'ok');
  check("右端が足りないだけなら 'upgrade'", verifyHeader(header.slice(0, -1)).status === 'upgrade');
  check("並びが違えば 'altered'", verifyHeader(['record_id', 'x', ...header.slice(2)]).status === 'altered');
  check("空なら 'empty'", verifyHeader([]).status === 'empty');
  check('records.js の checkHeader も同じ判定', checkHeader(header).status === 'ok');

  /* ---------------------------------------------------------------- */
  section('画面用の項目定義');

  check('編集フォームの項目数は13（自動項目14を除いた台帳27列）',
    CONTENT_FIELDS.length === 13 && META_FIELDS.length === 14,
    `content=${CONTENT_FIELDS.length} meta=${META_FIELDS.length}`);
  check('record_id は編集フォームに出ない（自動項目）',
    !CONTENT_FIELDS.some((f) => f.key === 'record_id'));
  check('email は編集フォームにある（自動項目ではない）',
    CONTENT_FIELDS.some((f) => f.key === 'email'));

  /* ---------------------------------------------------------------- */
  section('行 ⇄ レコードの往復変換');

  const sampleRow = [
    'rec-1', '2026-08-20 10:00:00',
    '株式会社サンプル', '営業部', '課長', '山田太郎', 'ヤマダタロウ',
    '100-0001', '東京都千代田区1-1-1', '03-1111-2222', '090-1111-2222', '',
    'taro@example.com', 'https://example.com',
    'jobTitle', 'email:taro@example.com',
    'TRUE', 'jobTitle',
    'hash-f', 'hash-b',
    'file-f', 'file-b',
    '=HYPERLINK("https://drive.google.com/file/d/xxx/view","表面画像を見る")',
    '=HYPERLINK("https://drive.google.com/file/d/yyy/view","裏面画像を見る")',
    'card-ocr-1.1', 'p1',
    'その他メモ',
  ];

  const record = rowToRecord(sampleRow, 5);

  check('record_id を読む', record.recordId === 'rec-1');
  check('会社名・氏名を読む', record.values.companyName === '株式会社サンプル' && record.values.fullName === '山田太郎');
  check('画像リンクの数式からURLだけを取り出す',
    record.auto.frontFileUrl === 'https://drive.google.com/file/d/xxx/view'
    && record.auto.backFileUrl === 'https://drive.google.com/file/d/yyy/view');
  check('hasBack は真偽値として読む', record.auto.hasBack === true);
  check('extractHyperlinkUrl は数式でない値には空文字',
    extractHyperlinkUrl('ただの文字列') === '' && extractHyperlinkUrl('') === '');

  {
    const edited = applyEditsToRow({
      raw: sampleRow,
      values: { ...record.values, email: 'shin-taro@example.com' },
    });
    const after = rowToRecord(edited, 5);

    check('編集した項目（メール）が反映される', after.values.email === 'shin-taro@example.com');
    check('★重複判定キーがメールの変更に追随して再計算される',
      after.auto.duplicateKey === 'email:shin-taro@example.com');
    check('★画像リンクの数式は書き換えない（生セルのまま）',
      after.auto.frontFileUrl === record.auto.frontFileUrl
      && after.auto.backFileUrl === record.auto.backFileUrl);
    check('★record_id は書き換えない', after.recordId === record.recordId);
    check('★登録日時は書き換えない', after.auto.registeredAt === record.auto.registeredAt);
    check('編集していない項目（会社名）はそのまま',
      after.values.companyName === record.values.companyName);
  }

  {
    /* 数式文字を含む値は先頭に ' が付き、数式として解釈されない（sanitize.js）。 */
    const edited = applyEditsToRow({
      raw: sampleRow,
      values: { ...record.values, otherInformation: '=cmd|/c calc' },
    });

    check('数式インジェクションになりうる値の先頭にアポストロフィが付く',
      edited[DATA_COLUMNS.findIndex((c) => c.key === 'otherInformation')].startsWith("'="));
  }

  check(
    'registeredAt がシリアル値で返ってきても読める（Sheetsが日時と解釈した場合）',
    formatRegisteredAtDisplay(46246.5).endsWith(':00') || formatRegisteredAtDisplay(46246.5) !== '',
  );
  check('registeredAt が既に文字列ならそのまま',
    formatRegisteredAtDisplay('2026-08-20 10:00:00') === '2026-08-20 10:00:00');
  check('registeredAt が空なら空', formatRegisteredAtDisplay('') === '');

  /* ---------------------------------------------------------------- */
  section('検索・絞り込み');

  const recordsForSearch = [
    rowToRecord(sampleRow, 5),
    rowToRecord([
      'rec-2', '2026-08-19 09:00:00',
      '合同会社テスト', '', '', '鈴木花子', 'スズキハナコ',
      '', '', '', '', '',
      'hanako@example.jp', '',
      '', '', '', '', '', '', '', '', '', '', '', '', '',
    ], 6),
  ];

  check('全文検索は氏名・会社名にヒットする',
    matchesQuery(recordsForSearch[0], '山田') && matchesQuery(recordsForSearch[0], 'サンプル'));
  check('スペース区切りはAND検索', matchesQuery(recordsForSearch[0], '山田 サンプル') === true);
  check('一部だけ一致しないとAND検索は不一致', matchesQuery(recordsForSearch[0], '山田 存在しない') === false);
  check('半角カナ・全角カナの表記ゆれを吸収する',
    normalizeSearchText('ヤマダ') === normalizeSearchText('やまだ'));
  check('会社名の完全一致でしか絞り込まない（部分一致では拾わない）',
    matchesCompany(recordsForSearch[0], '株式会社') === false
    && matchesCompany(recordsForSearch[0], '株式会社サンプル') === true);

  check('filterRecords はキーワード・会社を両方満たす行だけ返す',
    filterRecords(recordsForSearch, { query: '花子' }).length === 1
    && filterRecords(recordsForSearch, { query: '花子' })[0].recordId === 'rec-2');

  check('会社の選択肢はタグ列が無くても会社名だけから作れる',
    collectCompanyOptions(recordsForSearch).includes('株式会社サンプル')
    && collectCompanyOptions(recordsForSearch).includes('合同会社テスト'));

  /* ---------------------------------------------------------------- */
  section('台帳の解決（検索のみ・作らない）');

  const HISTORY_OK_HEADER = headersOf(HISTORY_COLUMNS);

  /*
   * Drive/Sheets の偽物。search/get/values/values:batchGet だけ応答し、
   * 呼び出しを記録する。
   *
   * saveHeader … 保存直前の values:batchGet が返す「名刺データ」タブの
   *              見出し。既定は `header` と同じ（変化なし）。読み込み後に
   *              見出しが変わったケースを再現するときだけ別の値を渡す
   *              （load 側の単発GETと save 側の batchGet は同じ範囲文字列
   *              でも別の口で応答を出し分けられる）。
   * historyHeader … 「変更履歴」タブの見出し。既定は最新版（'ok'）。
   */
  function buildStub({
    folders = {}, sheetId = null, header = [], rows = [], failHistory = false,
    saveHeader = null, historyHeader = null,
  } = {}) {
    const calls = [];
    const effectiveSaveHeader = saveHeader ?? header;
    const effectiveHistoryHeader = historyHeader ?? HISTORY_OK_HEADER;

    const rowFor = (rowNumber) => {
      const row = rows[rowNumber - 2];
      return row ? [row] : [];
    };

    const fetchImpl = async (url, options = {}) => {
      const urlText = String(url);
      calls.push({ url: urlText, method: options.method ?? 'GET', body: options.body });

      const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

      if (urlText.startsWith('https://www.googleapis.com/drive/v3/files?')) {
        const q = new URL(urlText).searchParams.get('q') ?? '';

        for (const [name, entry] of Object.entries(folders)) {
          if (q.includes(`name='${name}'`)) {
            return json({ files: entry ? [{ id: entry }] : [] });
          }
        }

        if (q.includes(`name='${SPREADSHEET_NAME}'`)) {
          return json({ files: sheetId ? [{ id: sheetId }] : [] });
        }

        return json({ files: [] });
      }

      /*
       * 保存直前の再検証（manager-client.js updateRecord）。
       * 「見出し」と「対象行」を1回でまとめて取得する。
       */
      if (urlText.includes(':batchGet')) {
        const ranges = new URL(urlText).searchParams.getAll('ranges');

        const valueRanges = ranges.map((range) => {
          if (/!A1:[A-Za-z0-9]+1$/.test(range)) {
            return { range, values: effectiveSaveHeader.length ? [effectiveSaveHeader] : [] };
          }

          const match = range.match(/!A(\d+):[A-Za-z0-9]+\1$/);

          return { range, values: match ? rowFor(Number(match[1])) : [] };
        });

        return json({ valueRanges });
      }

      if (urlText.includes('/values/') && urlText.includes(':append')) {
        if (failHistory) {
          return json({ error: { message: 'server error' } }, 500);
        }

        return json({ updates: { updatedRange: 'A2:F2' } });
      }

      if (urlText.includes('sheets.googleapis.com') && (options.method ?? 'GET') === 'PUT') {
        return json({ updatedRange: 'A5:AA5' });
      }

      if (urlText.includes('sheets.googleapis.com')) {
        const decoded = decodeURIComponent(urlText);

        /* 「変更履歴」タブの見出し（追記前の検証）。 */
        if (decoded.includes("'変更履歴'!A1:F1")) {
          return json({ values: effectiveHistoryHeader.length ? [effectiveHistoryHeader] : [] });
        }

        if (decoded.includes("'名刺データ'!A1:AA1")) {
          return json({ values: header.length ? [header] : [] });
        }

        if (decoded.includes('!A2:AA') && !/!A2:AA\d/.test(decoded)) {
          return json({ values: rows });
        }

        /* 特定の1行（単発GET。現在は使わないが、互換のため残す）。 */
        const match = decoded.match(/!A(\d+):AA\1/);

        if (match) {
          return json({ values: rowFor(Number(match[1])) });
        }
      }

      return { ok: false, status: 404, json: async () => ({}) };
    };

    return { fetchImpl, calls };
  }

  {
    const stub = buildStub({
      folders: { [ROOT_FOLDER_NAME]: 'root-id', [APP_FOLDER_NAME]: 'app-id' },
      sheetId: 'sheet-id-123456',
    });

    const { spreadsheetId, found } = await resolveLedger({ token: 'ya29.secret-token', fetchImpl: stub.fetchImpl });

    check('TSAM AI／名刺データ／名刺管理 の順で解決する', found === true && spreadsheetId === 'sheet-id-123456');
    check('作成のPOSTを一度も発行しない（読み取り専用）',
      stub.calls.every((call) => call.method === 'GET'),
      JSON.stringify(stub.calls.map((c) => c.method)));
  }

  {
    const stub = buildStub({ folders: { [ROOT_FOLDER_NAME]: 'root-id', [APP_FOLDER_NAME]: null } });
    const { found } = await resolveLedger({ token: 'ya29.secret-token', fetchImpl: stub.fetchImpl });

    check('台帳が無ければ found=false（作らない）', found === false);
  }

  /* ---------------------------------------------------------------- */
  section('全行の読み込み（見出しの版に応じた可否）');

  {
    const stub = buildStub({ header, rows: [sampleRow] });
    const result = await readAllRecords({ token: 't', spreadsheetId: 'sheet-1', fetchImpl: stub.fetchImpl });

    check("見出しが最新なら headerStatus='ok'・writable=true", result.headerStatus === 'ok' && result.writable === true);
    check('1件読み込む', result.records.length === 1 && result.records[0].recordId === 'rec-1');
  }

  {
    const stub = buildStub({ header: header.slice(0, -1), rows: [sampleRow.slice(0, -1)] });
    const result = await readAllRecords({ token: 't', spreadsheetId: 'sheet-1', fetchImpl: stub.fetchImpl });

    check("旧版（右端が足りない）なら headerStatus='upgrade'・writable=false（列を広げる作業はしない）",
      result.headerStatus === 'upgrade' && result.writable === false);
    check('閲覧はできる（0件ではない）', result.records.length === 1);
  }

  {
    const stub = buildStub({ header: ['record_id', 'x', ...header.slice(2)], rows: [sampleRow] });
    let mismatch = null;

    try {
      await readAllRecords({ token: 't', spreadsheetId: 'sheet-1', fetchImpl: stub.fetchImpl });
    } catch (error) {
      mismatch = error;
    }

    check('改変された見出しは HEADER_MISMATCH（列の位置を推測しない）',
      mismatch instanceof ManagerError && mismatch.code === ManagerErrorCode.HEADER_MISMATCH);
  }

  {
    const stub = buildStub({ header: [], rows: [] });
    const result = await readAllRecords({ token: 't', spreadsheetId: 'sheet-1', fetchImpl: stub.fetchImpl });

    check("見出しが空なら headerStatus='empty'・0件", result.headerStatus === 'empty' && result.records.length === 0);
  }

  /* ---------------------------------------------------------------- */
  section('1件の更新（record_id の再確認・変更履歴）');

  {
    const stub = buildStub({ header, rows: [sampleRow] });
    const target = rowToRecord(sampleRow, 2);

    const { record: updated, changes, historyRecorded } = await updateRecord({
      token: 't',
      spreadsheetId: 'sheet-1',
      record: target,
      values: { ...target.values, email: 'shin-taro@example.com' },
      writable: true,
      fetchImpl: stub.fetchImpl,
      at: new Date(2026, 7, 20, 12, 0, 0),
    });

    check('更新後のメールが反映される', updated.values.email === 'shin-taro@example.com');

    const putCalls = stub.calls.filter((c) => c.method === 'PUT');
    check('★台帳の更新（PUT）を1回だけ発行する', putCalls.length === 1);
    check('★保存直前の再検証（見出し＋対象行）は1回の values:batchGet でまとめて行う（往復回数が増えない）',
      stub.calls.filter((c) => c.url.includes(':batchGet')).length === 1);

    {
      /* PUT本文レベルの検証（レビュー指摘）。 */
      check('★PUTのURLに valueInputOption=USER_ENTERED が付いている',
        putCalls[0].url.includes('valueInputOption=USER_ENTERED'));

      const body = JSON.parse(putCalls[0].body);
      const putRow = body.values[0];

      check('★書き戻す行の長さは台帳の列数（27）と一致する',
        Array.isArray(body.values) && body.values.length === 1 && putRow.length === DATA_COLUMNS.length,
        `values.length=${body.values?.length} row.length=${putRow?.length}`);
      check('★行に null が混ざらない（すべて文字列）',
        putRow.every((cell) => typeof cell === 'string'),
        JSON.stringify(putRow));
      check('★画像リンクの数式（=HYPERLINK(...)）を生セルのまま書き戻す',
        putRow[DATA_COLUMNS.findIndex((c) => c.key === 'frontFileUrl')]
          === sampleRow[DATA_COLUMNS.findIndex((c) => c.key === 'frontFileUrl')]
        && putRow[DATA_COLUMNS.findIndex((c) => c.key === 'backFileUrl')]
          === sampleRow[DATA_COLUMNS.findIndex((c) => c.key === 'backFileUrl')]);
      check('編集したメール列が本文に反映されている',
        putRow[DATA_COLUMNS.findIndex((c) => c.key === 'email')] === 'shin-taro@example.com');
    }

    check('差分にメール・重複判定キーの変化が含まれる',
      changes.some((c) => c.key === 'email') && changes.some((c) => c.key === 'duplicateKey'));
    check('変更履歴の追記（POST :append）を発行する',
      stub.calls.some((c) => c.method === 'POST' && c.url.includes(':append')));
    check('変更履歴の記録に成功したと報告する', historyRecorded === true);
  }

  {
    /* 変更が無い場合は変更履歴に書かない。 */
    const stub = buildStub({ header, rows: [sampleRow] });
    const target = rowToRecord(sampleRow, 2);

    const { historyRecorded } = await updateRecord({
      token: 't',
      spreadsheetId: 'sheet-1',
      record: target,
      values: { ...target.values },
      writable: true,
      fetchImpl: stub.fetchImpl,
    });

    check('変更が無ければ変更履歴へ書かない',
      !stub.calls.some((c) => c.method === 'POST' && c.url.includes(':append')));
    check('変更が無くても historyRecorded は true（失敗ではない）', historyRecorded === true);
  }

  {
    /* 保存直前に別の場所で record_id が変わっていた（行がずれた）場合。 */
    const stub = buildStub({ header, rows: [['rec-DIFFERENT', ...sampleRow.slice(1)]] });
    const target = rowToRecord(sampleRow, 2);

    let conflict = null;

    try {
      await updateRecord({
        token: 't',
        spreadsheetId: 'sheet-1',
        record: target,
        values: { ...target.values },
        writable: true,
        fetchImpl: stub.fetchImpl,
      });
    } catch (error) {
      conflict = error;
    }

    check('record_id が一致しなければ ROW_CONFLICT', conflict instanceof ManagerError && conflict.code === ManagerErrorCode.ROW_CONFLICT);
    check('★別の行を誤って上書きしない（PUTを発行しない）',
      !stub.calls.some((c) => c.method === 'PUT'));
  }

  /* ---------------------------------------------------------------- */
  section('保存直前の見出し再検証（レビュー指摘: writable はスナップショット）');

  {
    /*
     * 読み込み時点では見出しが最新（'ok'）だったが、保存の直前に
     * 見出しが改変されていた（並び替え・削除）ケース。record_id 一致
     * だけでは検出できないため、保存直前の再取得（batchGet）で
     * 見出しも見る。
     */
    const alteredHeader = ['record_id', 'x', ...header.slice(2)];
    const stub = buildStub({ header, rows: [sampleRow], saveHeader: alteredHeader });
    const target = rowToRecord(sampleRow, 2);

    let mismatch = null;

    try {
      await updateRecord({
        token: 't',
        spreadsheetId: 'sheet-1',
        record: target,
        values: { ...target.values, email: 'shin-taro@example.com' },
        writable: true,
        fetchImpl: stub.fetchImpl,
      });
    } catch (error) {
      mismatch = error;
    }

    check('★読み込み後に見出しが改変されていたら HEADER_MISMATCH',
      mismatch instanceof ManagerError && mismatch.code === ManagerErrorCode.HEADER_MISMATCH);
    check('★無編集保存であっても含め、見出しが崩れていれば PUT を一切発行しない',
      !stub.calls.some((c) => c.method === 'PUT'),
      JSON.stringify(stub.calls.map((c) => c.method)));
  }

  {
    /* 読み込み後に見出しが旧版（'upgrade'）へ変わっていたケース。 */
    const outdatedHeader = header.slice(0, -1);
    const stub = buildStub({ header, rows: [sampleRow], saveHeader: outdatedHeader });
    const target = rowToRecord(sampleRow, 2);

    let outdated = null;

    try {
      await updateRecord({
        token: 't',
        spreadsheetId: 'sheet-1',
        record: target,
        values: { ...target.values },
        writable: true,
        fetchImpl: stub.fetchImpl,
      });
    } catch (error) {
      outdated = error;
    }

    check('★読み込み後に見出しが旧版へ変わっていたら HEADER_OUTDATED',
      outdated instanceof ManagerError && outdated.code === ManagerErrorCode.HEADER_OUTDATED);
    check('★HEADER_OUTDATED でも PUT を発行しない', !stub.calls.some((c) => c.method === 'PUT'));
  }

  {
    /* 無編集保存（自動項目を見ただけ）でも、見出しの再検証は必ず行う。 */
    const alteredHeader = ['record_id', 'x', ...header.slice(2)];
    const stub = buildStub({ header, rows: [sampleRow], saveHeader: alteredHeader });
    const target = rowToRecord(sampleRow, 2);

    let mismatch = null;

    try {
      await updateRecord({
        token: 't',
        spreadsheetId: 'sheet-1',
        record: target,
        values: { ...target.values }, /* 変更なし */
        writable: true,
        fetchImpl: stub.fetchImpl,
      });
    } catch (error) {
      mismatch = error;
    }

    check('★無編集保存でも、見出しが崩れていれば HEADER_MISMATCH で止まる（黙って壊さない）',
      mismatch instanceof ManagerError && mismatch.code === ManagerErrorCode.HEADER_MISMATCH);
  }

  {
    /* 見出しが古い（'upgrade'）ときは、呼び出し側が writable=false を渡す。 */
    const stub = buildStub({ header, rows: [sampleRow] });
    const target = rowToRecord(sampleRow, 2);

    let outdated = null;

    try {
      await updateRecord({
        token: 't',
        spreadsheetId: 'sheet-1',
        record: target,
        values: { ...target.values },
        writable: false,
        fetchImpl: stub.fetchImpl,
      });
    } catch (error) {
      outdated = error;
    }

    check('writable=false なら HEADER_OUTDATED（列を広げる作業はしない）',
      outdated instanceof ManagerError && outdated.code === ManagerErrorCode.HEADER_OUTDATED);
    check('★通信を一度も発行しない（保存前に止める）', stub.calls.length === 0);
  }

  {
    /* 変更履歴タブへの追記が失敗しても、台帳の更新そのものは成功扱いにする。 */
    const stub = buildStub({ header, rows: [sampleRow], failHistory: true });
    const target = rowToRecord(sampleRow, 2);

    const { record: updated, historyRecorded } = await updateRecord({
      token: 't',
      spreadsheetId: 'sheet-1',
      record: target,
      values: { ...target.values, email: 'shin-taro@example.com' },
      writable: true,
      fetchImpl: stub.fetchImpl,
    });

    check('★変更履歴への記録に失敗しても更新結果は返る（例外にしない）',
      updated.values.email === 'shin-taro@example.com');
    check('★historyRecorded=false で失敗を伝える', historyRecorded === false);
  }

  {
    /*
     * 「変更履歴」タブ自身が改変されていた場合。追記すると壊れた
     * （列がずれた）記録を残すことになるため、追記そのものを見送る。
     * 台帳（「名刺データ」）の更新自体は成功扱いのまま。
     */
    const stub = buildStub({
      header, rows: [sampleRow], historyHeader: ['history_id', 'x', ...HISTORY_OK_HEADER.slice(2)],
    });
    const target = rowToRecord(sampleRow, 2);

    const { record: updated, historyRecorded } = await updateRecord({
      token: 't',
      spreadsheetId: 'sheet-1',
      record: target,
      values: { ...target.values, email: 'shin-taro@example.com' },
      writable: true,
      fetchImpl: stub.fetchImpl,
    });

    check('★変更履歴タブの見出しが改変されていても台帳の更新は成功する',
      updated.values.email === 'shin-taro@example.com');
    check('★historyRecorded=false（壊れた記録を残さない）', historyRecorded === false);
    check('★追記（POST :append）を一切発行しない',
      !stub.calls.some((c) => c.method === 'POST' && c.url.includes(':append')));
  }

  /* ---------------------------------------------------------------- */
  section('短い行の書き戻し（Sheetsが行末の空セルを省略して返す場合）');

  {
    /*
     * Sheets は行末の空セルを省略して返すことがある（§FR-18・sanitize.js
     * の unescapeCellText コメント参照）。record_id〜email までしか
     * 無い短い行（13列）でも、書き戻す行は台帳の列数（27列）ぶん埋まり、
     * JSON に null が混ざらないこと。
     */
    const shortRow = sampleRow.slice(0, 13); /* record_id 〜 email まで */
    const stub = buildStub({ header, rows: [shortRow] });
    const target = rowToRecord(shortRow, 2);

    const { record: updated } = await updateRecord({
      token: 't',
      spreadsheetId: 'sheet-1',
      record: target,
      values: { ...target.values, otherInformation: '短い行からの追記' },
      writable: true,
      fetchImpl: stub.fetchImpl,
    });

    const putCall = stub.calls.find((c) => c.method === 'PUT');
    const body = JSON.parse(putCall.body);
    const putRow = body.values[0];

    check('★短い行でも書き戻す行の長さは台帳の列数と一致する',
      putRow.length === DATA_COLUMNS.length, putRow.length);
    check('★JSON.stringify で null に化ける穴（sparse array）が無い',
      !JSON.stringify(body).includes('null'), JSON.stringify(body));
    check('★足りなかった自動項目の列は空文字で埋める（undefined のままにしない）',
      putRow.every((cell) => typeof cell === 'string'));
    check('編集した「その他」欄が反映される', updated.values.otherInformation === '短い行からの追記');
  }

  /* ---------------------------------------------------------------- */
  section('保存時の入力上限（無警告で切り詰めない）');

  {
    const otherInfoField = CONTENT_FIELDS.find((f) => f.key === 'otherInformation');
    const phoneField = CONTENT_FIELDS.find((f) => f.key === 'phone');

    check('通常項目の maxLength は SHORT_CELL_MAX_LENGTH(1000) と同じ',
      phoneField.maxLength === 1000);
    check('★「その他」欄の maxLength は LONG_CELL_MAX_LENGTH(50000) と同じ（切り捨て上限と一致）',
      otherInfoField.maxLength === 50000);

    const longOther = 'あ'.repeat(2000);
    const edited = applyEditsToRow({ raw: sampleRow, values: { ...record.values, otherInformation: longOther } });
    const otherIndex = DATA_COLUMNS.findIndex((c) => c.key === 'otherInformation');

    check('★「その他」欄は画面のmaxLength(50000)を超えない入力なら切り詰められない',
      edited[otherIndex] === longOther, edited[otherIndex].length);
  }

  /* ---------------------------------------------------------------- */
  section('トークンが例外・エラー文言に漏れないこと');

  {
    /*
     * **サーバー応答にトークンを混ぜない。** Google は他人の Authorization
     * ヘッダーの値をエラーメッセージへ引用しないため、それを模したのでは
     * 「サーバーが返した文言をそのまま見せている」実装（summarizeErrorBody。
     * 意図的な仕様）を試すだけになる。確かめたいのはこちらのコードが
     * `token` 引数そのものを例外・文言へ組み込んでいないことなので、
     * 応答本文にはトークンを含めない、ふつうのエラーで検証する。
     */
    const secretToken = 'ya29.secret-token-should-never-leak';

    const stub = buildStub({
      folders: { [ROOT_FOLDER_NAME]: 'root-id', [APP_FOLDER_NAME]: 'app-id' },
      sheetId: 'sheet-id-123456',
    });

    const failingFetch = async (url, options = {}) => {
      if (String(url).includes('/values/') && (options.method ?? 'GET') !== 'PUT') {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: { message: 'internal server error' } }),
        };
      }

      return stub.fetchImpl(url, options);
    };

    let failure = null;

    try {
      await readAllRecords({ token: secretToken, spreadsheetId: 'sheet-1', fetchImpl: failingFetch });
    } catch (error) {
      failure = error;
    }

    check('通信は失敗する（テストの前提）', failure !== null);

    const described = describeDriveError(failure);
    const haystacks = [
      failure?.message ?? '',
      String(failure?.detail ?? ''),
      described.text,
      described.detail,
    ].join('\n');

    check('★例外メッセージにトークンが含まれない', !haystacks.includes(secretToken));
    check('★describeDriveError().text にトークンが含まれない', !described.text.includes(secretToken));
    check('★describeDriveError().detail にトークンが含まれない', !described.detail.includes(secretToken));

    /*
     * ManagerError（HEADER_MISMATCH / ROW_CONFLICT 等）も同じ規則を守る。
     * ManagerError はコンストラクタに token を渡す口すら無い設計だが、
     * その設計を固定する。
     */
    const managerError = new ManagerError(ManagerErrorCode.ROW_CONFLICT, { note: secretToken });
    check('ManagerError.message はコード名のみ（token を含む detail は message に混ぜない）',
      !managerError.message.includes(secretToken) && managerError.message === `manager:${ManagerErrorCode.ROW_CONFLICT}`);
  }

  /* ---------------------------------------------------------------- */
  section('ソース検査（CSP・innerHTML不使用・他アプリからの隔離）');

  {
    const htmlSource = await readFile(new URL('index.html', APP_DIR), 'utf8');

    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(htmlSource)?.[1] ?? '';

    check('CSP を宣言している', csp !== '');
    check("default-src は 'self'", csp.includes("default-src 'self'"));
    check('script-src は自分自身と GIS だけ',
      csp.includes("script-src 'self' https://accounts.google.com"));
    check("object-src を止めている", csp.includes("object-src 'none'"));
    check("base-uri を止めている", csp.includes("base-uri 'none'"));
    check('★CSP に unsafe-inline / unsafe-eval が無い', !/unsafe-inline|unsafe-eval/.test(csp));

    const connect = /connect-src ([^;]+)/.exec(csp)?.[1] ?? '';
    const allowedConnect = [
      "'self'",
      'https://www.googleapis.com',
      'https://sheets.googleapis.com',
      'https://script.google.com',
      'https://script.googleusercontent.com',
      /* 認証系の一部。セッション検証（verifySession）の宛先。 */
      'https://auth-verify.potenitas-lp.workers.dev',
    ];

    check('★connect-src が想定の2系統＋認証系に収まっている',
      connect.trim().split(/\s+/).every((host) => allowedConnect.includes(host)),
      connect);
    check('Drive・Sheetsの2系統が入っている',
      ['www.googleapis.com', 'sheets.googleapis.com'].every((host) => connect.includes(host)));
    check('★connect-src に gmail・generativelanguage 等の余計なホストが無い',
      !/gmail\.googleapis\.com|generativelanguage\.googleapis\.com/.test(connect));
    check('robots は noindex, nofollow', /name="robots"\s+content="noindex,\s*nofollow"/.test(htmlSource));
  }

  {
    const FILES = [
      'config.js', 'gis-loader.js', 'drive-auth.js', 'drive-api.js', 'sanitize.js',
      'schema.js', 'records.js', 'search.js', 'manager-client.js', 'script.js',
    ];

    const sources = await Promise.all(FILES.map(async (name) => ({
      name,
      text: await readFile(new URL(name, APP_DIR), 'utf8'),
    })));

    for (const { name, text } of sources) {
      check(`${name}: innerHTML 等のHTML注入APIを使っていない`,
        !/\.(inner|outer)HTML|insertAdjacentHTML|document\.write/.test(text));
      check(`${name}: テスト環境（apps/）から import していない`,
        !/from\s+['"][^'"]*\/apps\//.test(text));
      check(`${name}: 他の本番アプリから import していない（複製であり import ではない。§4-1）`,
        !/from\s+['"][^'"]*\/(card-ocr|card-mail|receipt-ocr|voice-recorder|interview-recorder)\//.test(text));
      check(`${name}: console.log/error/warn/info を使っていない（console.debug のみ許容）`,
        !/console\.(log|error|warn|info)/.test(text));
    }
  }

  /* ---------------------------------------------------------------- */
  section('Drive エラーの分類（トークンを含めない）');

  check('レート制限は403でも RATE_LIMITED', mapHttpErrorToCode(403, 'rateLimitExceeded') === 'RATE_LIMITED');
  check('権限不足の403は FORBIDDEN', mapHttpErrorToCode(403, 'insufficientPermissions') === 'FORBIDDEN');
  check('401は UNAUTHORIZED', mapHttpErrorToCode(401) === 'UNAUTHORIZED');
} catch (error) {
  fatal(error);
}

finish();
