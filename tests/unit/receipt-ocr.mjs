/*
 * 領収書スキャナ フェーズ1（基盤）の検証。
 * 対象仕様: docs/specs/receipt-ocr-v2.md
 *
 * 見るもの:
 *   §9.2  検出→作成フロー（順序）
 *   §9.3  壊れた状態への対応（表の全6行）
 *   §9.4  スキーマの進化ルール
 *   §9.5  共有設定を付与しない
 *   §12   エラーコード
 *   §15.2 プロビジョニングの個別基準（全5項）
 *   §13   XSS対策・キーとトークンの取り扱い（静的確認）
 *
 * ------------------------------------------------------------------
 * 実通信を行わない
 * ------------------------------------------------------------------
 * provisioning.js は Drive / Sheets の呼び出しを gateway 越しに行う。
 * ここでは同じ形の偽物（メモリ上の Drive）を渡す。
 * fetch は一度も呼ばれない。実キー・実トークンも登場しない。
 * ------------------------------------------------------------------
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../../public/production-app/receipt-ocr');

/* ---------- localStorage の偽物（store.js が読む） ---------- */

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

const storage = new MemoryStorage();
globalThis.localStorage = storage;

try {
  const schema = await import('../../public/production-app/receipt-ocr/schema.js');
  const errors = await import('../../public/production-app/receipt-ocr/errors.js');
  const hash = await import('../../public/production-app/receipt-ocr/hash.js');
  const store = await import('../../public/production-app/receipt-ocr/store.js');
  const sheets = await import('../../public/production-app/receipt-ocr/sheets.js');
  const datetime = await import('../../public/production-app/receipt-ocr/datetime.js');
  const provisioning = await import('../../public/production-app/receipt-ocr/provisioning.js');
  const config = await import('../../public/production-app/receipt-ocr/config.js');
  const { PORTAL_APPS } = await import('../../public/auth/apps.js');

  const { PROVISION_STATUS, NOTICE, provision, assertWritable } = provisioning;
  const DATA_HEADERS = schema.headersOf(schema.DATA_COLUMNS);

  /* ================================================================
     偽の Drive / Sheets
     ================================================================ */

  function createWorld() {
    return {
      seq: 0,
      folders: [],
      spreadsheets: [],
      /* 呼ばれた操作の記録。「呼ばれていないこと」も見たいので全部残す。 */
      calls: [],
    };
  }

  function nextId(world, prefix) {
    world.seq += 1;
    return `${prefix}00000000000${world.seq}`;
  }

  /*
   * provisioning.js が期待する形の偽物。
   * **共有設定を行うメソッドは存在しない**（§9.5）。
   */
  function createFakeGateway(world, { failOn = null, failCode = 'DRV-003' } = {}) {
    const record = (name, ...args) => {
      world.calls.push({ name, args });

      if (failOn === name) {
        throw new errors.AppError(failCode);
      }
    };

    return {
      getFileMeta(fileId) {
        record('getFileMeta', fileId);
        const sheet = world.spreadsheets.find((s) => s.id === fileId && !s.trashed);
        const folder = world.folders.find((f) => f.id === fileId && !f.trashed);
        const found = sheet ?? folder;
        return Promise.resolve(found ? { id: found.id, name: found.name } : null);
      },

      findOrCreateFolder(name, parentId) {
        record('findOrCreateFolder', name, parentId);

        const matches = world.folders
          .filter((f) => f.name === name && f.parentId === parentId && !f.trashed)
          .sort((a, b) => a.createdTime - b.createdTime);

        if (matches.length > 0) {
          return Promise.resolve({ folder: matches[0], created: false, duplicates: matches.slice(1) });
        }

        const folder = { id: nextId(world, 'fold'), name, parentId, createdTime: world.seq, trashed: false };
        world.folders.push(folder);
        return Promise.resolve({ folder, created: true, duplicates: [] });
      },

      findSpreadsheets(name, parentId) {
        record('findSpreadsheets', name, parentId);
        return Promise.resolve(
          world.spreadsheets
            .filter((s) => s.name === name && s.parentId === parentId && !s.trashed)
            .sort((a, b) => a.createdTime - b.createdTime)
            .map((s) => ({ id: s.id, name: s.name, createdTime: s.createdTime })),
        );
      },

      moveFile(fileId, parentId) {
        record('moveFile', fileId, parentId);
        const sheet = world.spreadsheets.find((s) => s.id === fileId);
        if (sheet) sheet.parentId = parentId;
        return Promise.resolve({ id: fileId });
      },

      createSpreadsheet(title) {
        record('createSpreadsheet', title);

        const sheet = {
          id: nextId(world, 'sprd'),
          name: title,
          parentId: null,
          createdTime: world.seq,
          trashed: false,
          tabs: schema.TAB_ORDER.map((t, i) => ({ sheetId: i + 1, title: t })),
          headers: {},
          filterViews: [],
          protectedRanges: [],
          schemaVersion: null,
          storeMaster: [],
        };

        world.spreadsheets.push(sheet);

        return Promise.resolve({ spreadsheetId: sheet.id, sheets: sheet.tabs });
      },

      getStructure(spreadsheetId) {
        record('getStructure', spreadsheetId);
        const sheet = world.spreadsheets.find((s) => s.id === spreadsheetId);
        return Promise.resolve({
          tabs: sheet ? sheet.tabs.map((t) => ({ ...t })) : [],
          filterViews: sheet ? [...sheet.filterViews] : [],
        });
      },

      readHeader(spreadsheetId, tabTitle) {
        record('readHeader', spreadsheetId, tabTitle);
        const sheet = world.spreadsheets.find((s) => s.id === spreadsheetId);
        return Promise.resolve(sheet?.headers?.[tabTitle] ?? []);
      },

      writeAllHeaders(spreadsheetId) {
        record('writeAllHeaders', spreadsheetId);
        const sheet = world.spreadsheets.find((s) => s.id === spreadsheetId);

        for (const title of schema.TAB_ORDER) {
          sheet.headers[title] = schema.headersOf(schema.TAB_COLUMNS[title]);
        }

        return Promise.resolve(null);
      },

      writeHeaderFor(spreadsheetId, tabTitle, columns) {
        record('writeHeaderFor', spreadsheetId, tabTitle);
        const sheet = world.spreadsheets.find((s) => s.id === spreadsheetId);
        sheet.headers[tabTitle] = schema.headersOf(columns);
        return Promise.resolve(null);
      },

      appendMissingColumns(spreadsheetId, tabTitle, existingCount, missing) {
        record('appendMissingColumns', spreadsheetId, tabTitle, existingCount, missing.length);
        const sheet = world.spreadsheets.find((s) => s.id === spreadsheetId);
        const current = sheet.headers[tabTitle] ?? [];
        sheet.headers[tabTitle] = [...current, ...missing.map((c) => c.header)];
        return Promise.resolve(null);
      },

      addTabs(spreadsheetId, titles) {
        record('addTabs', spreadsheetId, titles);
        const sheet = world.spreadsheets.find((s) => s.id === spreadsheetId);
        let id = sheet.tabs.length + 10;

        for (const title of titles) {
          id += 1;
          sheet.tabs.push({ sheetId: id, title });
        }

        return Promise.resolve(null);
      },

      writeSchemaVersion(spreadsheetId, version) {
        record('writeSchemaVersion', spreadsheetId, version);
        const sheet = world.spreadsheets.find((s) => s.id === spreadsheetId);
        sheet.schemaVersion = version;
        return Promise.resolve(null);
      },

      writeStoreMaster(spreadsheetId, rows) {
        record('writeStoreMaster', spreadsheetId, rows.length);
        const sheet = world.spreadsheets.find((s) => s.id === spreadsheetId);
        sheet.storeMaster = rows;
        return Promise.resolve(null);
      },

      createReviewViewAndProtection(spreadsheetId, dataSheetId) {
        record('createReviewViewAndProtection', spreadsheetId, dataSheetId);
        const sheet = world.spreadsheets.find((s) => s.id === spreadsheetId);
        sheet.filterViews.push(schema.REVIEW_FILTER_VIEW_NAME);
        sheet.protectedRanges.push({ sheetId: dataSheetId, headerOnly: true });
        return Promise.resolve(null);
      },
    };
  }

  const called = (world, name) => world.calls.some((c) => c.name === name);
  const countOf = (world, name) => world.calls.filter((c) => c.name === name).length;

  /* ================================================================ */
  section('§9.4 ヘッダー検証（名前の完全一致）');

  check(
    '期待どおりなら ok',
    schema.verifyHeader([...DATA_HEADERS]).status === 'ok',
  );

  {
    const short = DATA_HEADERS.slice(0, 5);
    const verdict = schema.verifyHeader(short);
    check('右端が足りないだけなら upgrade', verdict.status === 'upgrade');
    check(
      '不足列は右端の分だけ返る',
      verdict.missing.length === DATA_HEADERS.length - 5
        && verdict.missing[0].header === DATA_HEADERS[5],
    );
  }

  {
    const swapped = [...DATA_HEADERS];
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    check('並べ替えは altered', schema.verifyHeader(swapped).status === 'altered');
  }

  {
    const removed = DATA_HEADERS.filter((_, i) => i !== 3);
    check('中間の列の削除は altered', schema.verifyHeader(removed).status === 'altered');
  }

  {
    const renamed = [...DATA_HEADERS];
    renamed[2] = '利用日付';
    check('改名は altered', schema.verifyHeader(renamed).status === 'altered');
  }

  check('空のヘッダーは empty', schema.verifyHeader([]).status === 'empty');
  check('空文字だけのヘッダーも empty', schema.verifyHeader(['', '', '']).status === 'empty');

  check(
    '末尾の空セルは無視する',
    schema.verifyHeader([...DATA_HEADERS, '', '']).status === 'ok',
  );

  check(
    '前後の空白は落として一致とみなす',
    schema.verifyHeader(DATA_HEADERS.map((h) => ` ${h} `)).status === 'ok',
  );

  check(
    '知らない列が右端に増えていても ok（新しい版が足した列）',
    schema.verifyHeader([...DATA_HEADERS, '将来の列']).status === 'ok',
  );

  check('列名に重複が無い', new Set(DATA_HEADERS).size === DATA_HEADERS.length);
  check('列キーに重複が無い',
    new Set(schema.DATA_COLUMNS.map((c) => c.key)).size === schema.DATA_COLUMNS.length);

  /* v1.3 §13.4 の必須は 支払先 / 利用日 / 合計金額 / 原本画像URL の4つ。 */
  check('必須項目が4つ定義されている',
    schema.DATA_COLUMNS.filter((c) => c.required === true).length === 4);

  check('A1表記の列文字（0→A / 25→Z / 26→AA）',
    schema.columnLetter(0) === 'A' && schema.columnLetter(25) === 'Z' && schema.columnLetter(26) === 'AA');

  check('ハッシュ列を key から引ける',
    schema.columnIndex(schema.DATA_COLUMNS, 'imageHash') >= 0);

  /* ---------------------------------------------------------------- */
  section('§9.3 タブの欠損検出');

  check('欠損なしなら空',
    schema.missingTabs([...schema.TAB_ORDER]).length === 0);

  check('欠けたタブだけを返す',
    JSON.stringify(schema.missingTabs([schema.TABS.data, schema.TABS.ocrText]))
      === JSON.stringify([schema.TABS.storeMaster, schema.TABS.settings]));

  check('データタブの欠損を区別する',
    schema.isDataTabMissing([schema.TABS.settings]) === true
    && schema.isDataTabMissing([...schema.TAB_ORDER]) === false);

  /* ---------------------------------------------------------------- */
  section('§12 エラーコード');

  for (const code of [
    'AUTH-001', 'OAUTH-001', 'KEY-001', 'KEY-002', 'AI-002',
    'DRV-001', 'DRV-002', 'DRV-003', 'OCR-001', 'SHEET-001', 'DUP-001',
  ]) {
    check(`${code} が定義されている`, errors.isKnownCode(code));
  }

  check('未知のコードでも例外を投げない',
    errors.describeError('NOPE').code === 'UNKNOWN');

  check('どこまで完了したかを必ず添える（§12 末尾）',
    errors.describeError('SHEET-001', { progress: errors.PROGRESS.ORIGINAL_SAVED })
      .progressText.includes('原本画像は保存済み'));

  check('KEY系は Portal へ誘導する',
    errors.describeError('KEY-001').guide === errors.GUIDE.PORTAL_KEY
    && errors.describeError('KEY-002').guide === errors.GUIDE.PORTAL_KEY);

  check('401 は OAUTH-001', errors.mapGoogleError(401) === 'OAUTH-001');
  check('容量不足の 403 は DRV-003',
    errors.mapGoogleError(403, 'storageQuotaExceeded') === 'DRV-003');
  check('容量以外の 403 は OAUTH-001',
    errors.mapGoogleError(403, 'forbidden') === 'OAUTH-001');
  check('404 は DRV-001', errors.mapGoogleError(404) === 'DRV-001');

  /* ---------------------------------------------------------------- */
  section('SHA-256（§5-② / §10）');

  check('空データのハッシュが既知の値と一致する',
    (await hash.sha256Hex(new Uint8Array([])))
      === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

  check('"abc" のハッシュが既知の値と一致する',
    (await hash.sha256Hex(new TextEncoder().encode('abc')))
      === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  check('ハッシュ列から完全一致を見つける',
    hash.findDuplicateIndex(['aa', 'bb', 'cc'], 'bb') === 1);

  check('大文字小文字と空白の違いを無視する',
    hash.findDuplicateIndex(['  AA  '], 'aa') === 0);

  check('無ければ -1', hash.findDuplicateIndex(['aa'], 'zz') === -1);
  check('空のハッシュは一致させない', hash.findDuplicateIndex(['', 'aa'], '') === -1);

  /* ---------------------------------------------------------------- */
  section('§13 数式インジェクション対策');

  for (const dangerous of ['=1+1', '+1', '-1', '@SUM(A1)', '\tX', '\rX']) {
    check(`${JSON.stringify(dangerous)} は先頭を無害化する`,
      sheets.escapeFormula(dangerous).startsWith("'"));
  }

  check('ふつうの文字列はそのまま', sheets.escapeFormula('セブンイレブン') === 'セブンイレブン');
  check('数値もそのまま', sheets.escapeFormula(1200) === '1200');
  check('null は空文字', sheets.escapeFormula(null) === '');
  check('行ごと通せる',
    JSON.stringify(sheets.escapeRow(['=X', 'ok'])) === JSON.stringify(["'=X", 'ok']));

  /* ---------------------------------------------------------------- */
  section('§6 タイムゾーン（Asia/Tokyo）');

  {
    /* UTC で 1/31 15:30 は日本時間で 2/1 00:30。月フォルダは 02 でなければならない。 */
    const { year, month } = datetime.yearMonthPath(new Date('2026-01-31T15:30:00Z'));
    check('端末の時間帯ではなく日本時間で月を決める', year === '2026' && month === '02');
  }

  check('日付は YYYY-MM-DD',
    /^\d{4}-\d{2}-\d{2}$/.test(datetime.dateStamp(new Date('2026-08-03T01:00:00Z'))));

  check('日時は YYYY-MM-DD HH:mm:ss',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(datetime.timestamp(new Date('2026-08-03T01:00:00Z'))));

  /* ---------------------------------------------------------------- */
  section('保存先IDの記憶（§9.2-1 / §9.2-5）');

  storage.clear();
  check('未記憶なら null が並ぶ', store.readLocations().spreadsheetId === null);

  store.writeLocations({ spreadsheetId: 'sprd000000000001' });
  check('書いた値を読み戻せる', store.readLocations().spreadsheetId === 'sprd000000000001');

  store.writeLocations({ rootFolderId: 'fold000000000001' });
  check('部分更新でも既存の値は消えない',
    store.readLocations().spreadsheetId === 'sprd000000000001'
    && store.readLocations().rootFolderId === 'fold000000000001');

  store.writeLocations({ spreadsheetId: 'ya!' });
  check('IDの形でない値は取り込まない',
    store.readLocations().spreadsheetId === 'sprd000000000001');

  for (const broken of ['{', 'null', '"text"', '[1,2]', '']) {
    storage.setItem('tsam-receipt-ocr-locations', broken);
    check(`壊れた保存値（${broken || '空文字'}）でも例外を投げない`,
      store.readLocations().spreadsheetId === null);
  }

  store.clearLocations();
  check('消せる', store.readLocations().spreadsheetId === null);

  {
    const keys = [...storage.map.keys()];
    check('保存キーは1つだけ', keys.length <= 1);
  }

  /* ================================================================
     §15.2 プロビジョニング（個別基準の全5項）
     ================================================================ */
  section('§15.2-1 初回利用で保存先が自動作成される');

  {
    storage.clear();
    const world = createWorld();
    const gateway = createFakeGateway(world);
    const result = await provision(gateway);

    check('status は created', result.status === PROVISION_STATUS.CREATED);
    check('書き込み可', result.writable === true);

    check('フォルダ階層が3段できる（TSAM AI / 領収書データ / 原本）',
      world.folders.length === 3);

    check('原本フォルダの親は領収書データフォルダ',
      world.folders[2].parentId === world.folders[1].id
      && world.folders[1].parentId === world.folders[0].id);

    check('スプレッドシートが1つできる', world.spreadsheets.length === 1);

    const sheet = world.spreadsheets[0];

    check('4つのタブができる',
      JSON.stringify(sheet.tabs.map((t) => t.title)) === JSON.stringify([...schema.TAB_ORDER]));

    check('データタブのヘッダーが定義どおり',
      JSON.stringify(sheet.headers[schema.TABS.data]) === JSON.stringify(DATA_HEADERS));

    check('全タブにヘッダーが書かれる',
      schema.TAB_ORDER.every((t) => Array.isArray(sheet.headers[t]) && sheet.headers[t].length > 0));

    check('スキーマバージョンが記録される', sheet.schemaVersion === schema.SCHEMA_VERSION);
    check('初期店舗マスタが書き込まれる（現在は空）', called(world, 'writeStoreMaster'));
    check('要確認一覧のフィルタビューができる',
      sheet.filterViews.includes(schema.REVIEW_FILTER_VIEW_NAME));
    check('ヘッダー行の保護が設定される', sheet.protectedRanges.length === 1);
    check('シートが領収書データフォルダへ移される', sheet.parentId === world.folders[1].id);

    check('初回案内を出す（§9.2 末尾）', result.notices.includes(NOTICE.FIRST_RUN));
    check('保存先IDが記憶される', store.readLocations().spreadsheetId === sheet.id);
  }

  /* ---------------------------------------------------------------- */
  section('§15.2-4 作成物に共有設定が付与されていない（§9.5）');

  {
    storage.clear();
    const world = createWorld();
    const gateway = createFakeGateway(world);
    await provision(gateway);

    check('gateway に共有を行うメソッドが存在しない',
      Object.keys(gateway).every((name) => !/permission|share|anyone/i.test(name)));

    check('共有らしき操作が一度も呼ばれていない',
      world.calls.every((c) => !/permission|share|anyone/i.test(c.name)));
  }

  /* ---------------------------------------------------------------- */
  section('§15.2-5 localStorage 消去後、名前検索で再発見できる');

  {
    storage.clear();
    const world = createWorld();
    const gateway = createFakeGateway(world);

    await provision(gateway);
    const firstId = world.spreadsheets[0].id;

    /* 端末の記憶だけを消す。ドライブ側はそのまま。 */
    storage.clear();
    world.calls = [];

    const again = await provision(gateway);

    check('同じシートを使う', again.locations.spreadsheetId === firstId);
    check('新しいシートを作らない', world.spreadsheets.length === 1);
    check('作成ではなく名前検索を通っている',
      called(world, 'findSpreadsheets') && !called(world, 'createSpreadsheet'));
    check('IDを覚え直す', store.readLocations().spreadsheetId === firstId);
    check('status は ready', again.status === PROVISION_STATUS.READY);
  }

  /* ---------------------------------------------------------------- */
  section('2回目以降の起動（記憶したIDをそのまま使う）');

  {
    storage.clear();
    const world = createWorld();
    const gateway = createFakeGateway(world);

    await provision(gateway);
    world.calls = [];

    const again = await provision(gateway);

    check('記憶したIDの実体を確認する', called(world, 'getFileMeta'));
    check('名前検索まで行かない', !called(world, 'findSpreadsheets'));
    check('作成しない', !called(world, 'createSpreadsheet'));
    check('書き込み可', again.writable === true);
    check('よけいな案内を出さない', again.notices.length === 0);
  }

  /* ================================================================
     §9.3 壊れた状態への対応（表の全6行）
     ================================================================ */
  section('§9.3-1 シート削除済み（ID参照が404）');

  {
    storage.clear();
    const world = createWorld();
    const gateway = createFakeGateway(world);

    await provision(gateway);
    const firstId = world.spreadsheets[0].id;

    /* 利用者がシートを消した。記憶は残っている。 */
    world.spreadsheets[0].trashed = true;
    world.calls = [];

    const result = await provision(gateway);

    check('status は recreated', result.status === PROVISION_STATUS.RECREATED);
    check('新しいシートを作る', result.locations.spreadsheetId !== firstId);
    check('復元不可を案内する', result.notices.includes(NOTICE.NOT_RESTORED));
    check('初回案内も添える', result.notices.includes(NOTICE.FIRST_RUN));
    check('書き込みは再開できる', result.writable === true);
    check('消えたシートを掘り起こさない',
      world.spreadsheets.filter((s) => !s.trashed).length === 1);
  }

  /* ---------------------------------------------------------------- */
  section('§9.3-2 列の改変（並べ替え・削除）→ 書き込み停止');

  {
    storage.clear();
    const world = createWorld();
    const gateway = createFakeGateway(world);

    await provision(gateway);
    const sheet = world.spreadsheets[0];

    /* 利用者が列を並べ替えた。 */
    const swapped = [...sheet.headers[schema.TABS.data]];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    sheet.headers[schema.TABS.data] = swapped;

    world.calls = [];
    const result = await provision(gateway);

    check('status は blocked', result.status === PROVISION_STATUS.BLOCKED);
    check('書き込み不可', result.writable === false);
    check('DRV-002 を返す', result.errorCode === 'DRV-002');
    check('改変の案内を出す', result.notices.includes(NOTICE.SCHEMA_ALTERED));

    check('列位置を推測して書き込まない',
      !called(world, 'appendMissingColumns') && !called(world, 'writeHeaderFor'));

    check('ヘッダーを勝手に直さない',
      JSON.stringify(sheet.headers[schema.TABS.data]) === JSON.stringify(swapped));

    check('新しいシートを勝手に作らない', world.spreadsheets.length === 1);

    let thrown = null;
    try {
      assertWritable(result);
    } catch (error) {
      thrown = error;
    }

    check('停止中に書こうとすると DRV-002 で止まる', thrown?.code === 'DRV-002');
  }

  /* ---------------------------------------------------------------- */
  section('§9.3-3 ファイルの移動・リネーム（影響なし）');

  {
    storage.clear();
    const world = createWorld();
    const gateway = createFakeGateway(world);

    await provision(gateway);
    const sheet = world.spreadsheets[0];
    const originalId = sheet.id;

    /* 利用者が名前を変え、別の場所へ移した。IDは変わらない。 */
    sheet.name = '経費まとめ（2026年度）';
    sheet.parentId = 'fold-somewhere-else';

    world.calls = [];
    const result = await provision(gateway);

    check('IDで追跡して同じシートを使う', result.locations.spreadsheetId === originalId);
    check('通常動作（ready）', result.status === PROVISION_STATUS.READY);
    check('書き込み可', result.writable === true);
    check('作り直さない', world.spreadsheets.length === 1);
    check('案内を出さない', result.notices.length === 0);
  }

  /* ---------------------------------------------------------------- */
  section('§9.3-4 タブ削除（欠損タブのみ再作成）');

  {
    storage.clear();
    const world = createWorld();
    const gateway = createFakeGateway(world);

    await provision(gateway);
    const sheet = world.spreadsheets[0];

    /* 設定タブだけ消えた。データは無事。 */
    sheet.tabs = sheet.tabs.filter((t) => t.title !== schema.TABS.settings);
    delete sheet.headers[schema.TABS.settings];

    world.calls = [];
    const result = await provision(gateway);

    check('status は tabs-repaired', result.status === PROVISION_STATUS.TABS_REPAIRED);
    check('欠損タブを作り直す',
      sheet.tabs.some((t) => t.title === schema.TABS.settings));
    check('作り直したタブにヘッダーを書く',
      Array.isArray(sheet.headers[schema.TABS.settings]));
    check('案内を出す', result.notices.includes(NOTICE.TABS_REPAIRED));
    check('シートごと作り直さない', world.spreadsheets.length === 1);
    check('書き込み可', result.writable === true);
  }

  {
    /* データタブが消えた場合は「シート削除」に準じる（§9.3-4 括弧書き）。 */
    storage.clear();
    const world = createWorld();
    const gateway = createFakeGateway(world);

    await provision(gateway);
    const sheet = world.spreadsheets[0];
    const firstId = sheet.id;

    sheet.tabs = sheet.tabs.filter((t) => t.title !== schema.TABS.data);
    delete sheet.headers[schema.TABS.data];

    const result = await provision(gateway);

    check('データタブ欠損は recreated 扱い', result.status === PROVISION_STATUS.RECREATED);
    check('復元不可を案内する', result.notices.includes(NOTICE.NOT_RESTORED));
    check('新しいシートを作る', result.locations.spreadsheetId !== firstId);
  }

  /* ---------------------------------------------------------------- */
  section('§9.3-5 2タブ同時初回起動（古い方へ寄せる）');

  {
    storage.clear();
    const world = createWorld();
    const gateway = createFakeGateway(world);

    /* 1つ目のタブが作った状態。 */
    await provision(gateway);
    const olderId = world.spreadsheets[0].id;

    /* 2つ目のタブが、同じ名前・同じ親で、あとから作ってしまった。 */
    world.seq += 1;
    world.spreadsheets.push({
      id: 'sprd00000000099',
      name: world.spreadsheets[0].name,
      parentId: world.spreadsheets[0].parentId,
      createdTime: world.seq,
      trashed: false,
      tabs: schema.TAB_ORDER.map((t, i) => ({ sheetId: i + 1, title: t })),
      headers: { [schema.TABS.data]: [...DATA_HEADERS] },
      filterViews: [schema.REVIEW_FILTER_VIEW_NAME],
      protectedRanges: [],
      schemaVersion: schema.SCHEMA_VERSION,
      storeMaster: [],
    });

    /* localStorage を消し、名前検索で両方が見える状態にする。 */
    storage.clear();
    const result = await provision(gateway);

    check('作成日時が古い方を使う', result.locations.spreadsheetId === olderId);
    check('重複の案内を出す', result.notices.includes(NOTICE.DUPLICATE_STRUCTURE));
    check('自動削除はしない',
      world.spreadsheets.filter((s) => !s.trashed).length === 2);
    check('書き込みは続けられる', result.writable === true);
  }

  /* ---------------------------------------------------------------- */
  section('§9.3-6 ドライブ容量不足（DRV-003）');

  {
    storage.clear();
    const world = createWorld();
    const gateway = createFakeGateway(world, { failOn: 'createSpreadsheet', failCode: 'DRV-003' });

    let thrown = null;

    try {
      await provision(gateway);
    } catch (error) {
      thrown = error;
    }

    check('DRV-003 が伝わる', thrown?.code === 'DRV-003');
    check('容量不足の文言が用意されている',
      errors.describeError('DRV-003').message.includes('空き容量'));
    check('データ消失なしを添えられる',
      errors.describeError('DRV-003', { progress: errors.PROGRESS.NONE })
        .progressText.includes('保存されていません'));
  }

  /* ================================================================
     §9.4 スキーマの進化
     ================================================================ */
  section('§9.4 旧バージョンのシートへ不足列を右端に追加');

  {
    storage.clear();
    const world = createWorld();
    const gateway = createFakeGateway(world);

    await provision(gateway);
    const sheet = world.spreadsheets[0];

    /* 旧バージョン相当。右端の列がまだ無い。 */
    const oldHeader = DATA_HEADERS.slice(0, DATA_HEADERS.length - 3);
    sheet.headers[schema.TABS.data] = oldHeader;
    sheet.schemaVersion = '0.1-old';

    world.calls = [];
    const result = await provision(gateway);

    check('status は upgraded', result.status === PROVISION_STATUS.UPGRADED);
    check('不足列が右端に足される',
      JSON.stringify(sheet.headers[schema.TABS.data]) === JSON.stringify(DATA_HEADERS));
    check('既存列には触れない',
      sheet.headers[schema.TABS.data].slice(0, oldHeader.length).join() === oldHeader.join());
    check('スキーマバージョンを更新する', sheet.schemaVersion === schema.SCHEMA_VERSION);
    check('案内を出す', result.notices.includes(NOTICE.SCHEMA_UPGRADED));
    check('書き込み可', result.writable === true);
  }

  /* ================================================================
     規約の静的確認
     ================================================================ */
  section('規約（§13 / PORTAL_APPS / import の禁止）');

  /*
   * アプリ側の全ファイル。フェーズを足したらここへ加えること。
   * 加え忘れると、新しいファイルだけ規約の検査を素通りする。
   */
  const APP_FILES = [
    'ai-complete.js', 'amount.js', 'app.js', 'completion-policy.js', 'confidence.js',
    'config.js', 'datetime.js', 'drive.js', 'duplicate.js', 'errors.js',
    'extract.js', 'gateway.js', 'gemini-client.js', 'google-api.js', 'hash.js',
    'oauth.js', 'ocr.js', 'ocr-drive.js', 'ocr-gemini.js', 'provisioning.js',
    'record.js', 'review.js', 'schema.js', 'sheets.js', 'status.js',
    'store.js', 'validate.js',
  ];

  /*
   * コメントを落としてから見る。
   *
   * 各ファイルの冒頭には「innerHTML を使わない」「localStorage を直接触らない」と
   * 禁止事項そのものが書いてある。素朴に文字列を探すと、その注意書きに当たって
   * 落ちる。見たいのは実際の呼び出しなので、コメントは除いてから調べる。
   *
   * 文字列リテラルの中の // は消さないよう、引用符の内外を追う。
   */
  function stripComments(source) {
    let out = '';
    let i = 0;
    let quote = null;

    while (i < source.length) {
      const ch = source[i];
      const next = source[i + 1];

      if (quote) {
        if (ch === '\\') {
          out += '  ';
          i += 2;
          continue;
        }

        if (ch === quote) {
          quote = null;
        }

        out += ch;
        i += 1;
        continue;
      }

      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        out += ch;
        i += 1;
        continue;
      }

      if (ch === '/' && next === '/') {
        while (i < source.length && source[i] !== '\n') i += 1;
        continue;
      }

      if (ch === '/' && next === '*') {
        i += 2;
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
        i += 2;
        continue;
      }

      out += ch;
      i += 1;
    }

    return out;
  }

  const sources = new Map(
    APP_FILES.map((name) => [name, stripComments(readFileSync(resolve(appDir, name), 'utf8'))]),
  );

  const rawHtml = readFileSync(resolve(appDir, 'index.html'), 'utf8');
  const indexHtml = rawHtml.replace(/<!--[\s\S]*?-->/g, '');

  /* 除去がコードまで削っていないことを確かめてから、下の検査を信用する。 */
  check('コメント除去が本文を壊していない（宣言が残る）',
    [...sources.values()].every((src) => /\b(export|import|const|function)\b/.test(src)));

  check('コメント除去が文字列リテラルを壊していない（// を含むURLが残る）',
    sources.get('oauth.js').includes('https://accounts.google.com/gsi/client'));

  check('innerHTML を使っていない',
    [...sources.values()].every((src) => !src.includes('innerHTML')));

  check('outerHTML / insertAdjacentHTML / document.write も使っていない',
    [...sources.values()].every((src) =>
      !src.includes('outerHTML')
      && !src.includes('insertAdjacentHTML')
      && !src.includes('document.write')));

  check('public/apps/ から import していない',
    [...sources.values()].every((src) => !/from\s+['"][^'"]*\/apps\//.test(src)));

  {
    /* localStorage を直接触ってよいのは store.js だけ（保存先IDの記憶に限る）。 */
    const offenders = [...sources.entries()]
      .filter(([name, src]) => name !== 'store.js' && src.includes('localStorage'))
      .map(([name]) => name);

    check(`localStorage を触るのは store.js だけ（違反: ${offenders.join(', ') || 'なし'}）`,
      offenders.length === 0);
  }

  check('sessionStorage を使っていない',
    [...sources.values()].every((src) => !src.includes('sessionStorage')));

  {
    /* トークンを保存する経路が無いこと。 */
    const suspicious = [...sources.entries()]
      .filter(([, src]) => /setItem\(\s*[^)]*[Tt]oken/.test(src))
      .map(([name]) => name);

    check('アクセストークンを保存する呼び出しが無い', suspicious.length === 0);
  }

  check('OAuth スコープは drive.file のみ',
    config.OAUTH.scope === 'https://www.googleapis.com/auth/drive.file');

  check('ドライブ全体を読むスコープを要求していない',
    !/auth\/drive(\s|'|"|$)|drive\.readonly|drive\.metadata/.test(sources.get('config.js')));

  {
    /* 第三者CDN の禁止。Google の認可スクリプトだけを許す。 */
    const hosts = [...indexHtml.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
    const allowed = new Set([
      'accounts.google.com',
      'www.googleapis.com',
      'sheets.googleapis.com',
      'generativelanguage.googleapis.com',
      'script.google.com',
      'script.googleusercontent.com',
    ]);

    const outside = [...new Set(hosts)].filter((host) => !allowed.has(host));

    check(`index.html が読む外部ホストは Google だけ（ほか: ${outside.join(', ') || 'なし'}）`,
      outside.length === 0);
  }

  check('CSP を宣言している', indexHtml.includes('Content-Security-Policy'));
  check('object-src を止めている', indexHtml.includes("object-src 'none'"));

  check('当社ドメインへ画像やデータを送る宛先が設定に無い',
    !/tsam-ai\.com/.test(sources.get('config.js')));

  check('KeyStore は読み取りだけ（set / remove を呼ばない）',
    !/KeyStore\.(set|remove)\(/.test(sources.get('app.js')));

  check('共有設定を付ける呼び出しが無い（§9.5）',
    [...sources.values()].every((src) => !/permissions/i.test(src)));

  {
    const app = PORTAL_APPS.find((entry) => entry.id === 'receipt-ocr');

    check('PORTAL_APPS に登録されている', Boolean(app));
    check('登録パスに apps/ を含まない', !String(app?.path ?? '').includes('apps/'));
    check('登録パスは先頭が / でない', !String(app?.path ?? '').startsWith('/'));
    check('登録パスが実体と一致する', app?.path === 'production-app/receipt-ocr/');
  }

  /* v1.3 §16.1 と突き合わせて確定済み。draft へ戻さないこと。 */
  check('スキーマ版は確定版（1.0）', schema.SCHEMA_VERSION === '1.0');

  {
    /*
     * ファイルの一覧に取りこぼしが無いこと。
     * ここが漏れると、新しいファイルだけ上の検査を素通りする。
     */
    const onDisk = readdirSync(appDir)
      .filter((name) => name.endsWith('.js'))
      .sort();

    const listed = [...APP_FILES].sort();

    check(`検査対象が実ファイルと一致する（漏れ: ${onDisk.filter((n) => !listed.includes(n)).join(', ') || 'なし'}）`,
      JSON.stringify(onDisk) === JSON.stringify(listed));
  }

  storage.clear();
  delete globalThis.localStorage;

  finish();
} catch (error) {
  fatal(error);
}
