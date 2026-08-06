/*
 * 保存構造の解決（要件定義書 §FR-07、§8.1 ステージ0）。
 *
 *   マイドライブ
 *   └─ TSAM AI
 *      └─ 名刺データ
 *         ├─ 名刺管理（Googleスプレッドシート）
 *         └─ images
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * public/production-app/card-ocr/poc/drive-storage.js（2026-08-04）。
 * その元は public/apps/card-scanner/drive-folders.js。
 * 健全性の確認は ../receipt-ocr/provisioning.js から取り込んだ。
 * **どこからも import はしない**（docs/repository-structure.md §4-1）。
 *
 * PoC から変えたところ:
 *   - 定数を config.js へ移した
 *   - 台帳の作成・検査を sheets.js へ分けた
 *   - **既存シートの健全性を確認する段を足した**（領収書OCRから取り込み）
 *   - AbortSignal を通せるようにした
 * ==================================================================
 *
 * ==================================================================
 * localStorage はキャッシュであって正本ではない
 * ==================================================================
 * 正本は Drive 上の実体である。localStorage は「前回そこにあった」という
 * 手がかりに過ぎない。したがって空でも、消えても、別端末でも動く。
 *
 * 解決は必ず3段階を通る。
 *
 *   段階1 … キャッシュのIDを検証する
 *            有効        → そのまま使う
 *            404/403     → キャッシュを捨てて段階2
 *            401/通信不良 → **キャッシュを捨てない**（認可・一時障害のため）
 *   段階2 … 名前・親・種別・未削除で検索する
 *            見つかればキャッシュへ書き戻す
 *   段階3 … 見つからなければ作成する
 *            **キャッシュが空というだけでは作らない。** 段階2を必ず通す
 *
 * 段階2を飛ばすと、localStorage を消しただけの利用者に対して
 * 保存先を作り直してしまう。過去のデータは残っているのに、
 * 新しい空のシートへ書き始めることになる。
 * ==================================================================
 */

import {
  APP_FOLDER_NAME,
  DRIVE_FOLDER_MIME,
  GOOGLE_SHEET_MIME,
  IMAGE_FOLDER_NAME,
  ROOT_FOLDER_NAME,
  SPREADSHEET_NAME,
  STORAGE_KEYS,
  TABS,
} from './config.js';

import {
  DriveError,
  DriveErrorCode,
  createFolder,
  getFileMeta,
  searchFiles,
} from './drive-api.js';

import {
  TAB_COLUMNS,
  TAB_ORDER,
  addTabs,
  appendMissingColumns,
  createSpreadsheet,
  getStructure,
  readHeader,
  writeHeader,
} from './sheets.js';

import { missingTabs, verifyHeader } from './schema.js';

/* 保存構造がどうなったか。画面の案内に使う。 */
export const StorageNotice = Object.freeze({
  /* 初回。保存先を作った。§5.3 の明示事項を出す合図でもある。 */
  CREATED: 'CREATED',
  /* 消えていたので作り直した。過去データは戻らない。 */
  RECREATED: 'RECREATED',
  /* 欠けていたタブを作り直した。 */
  TABS_REPAIRED: 'TABS_REPAIRED',
  /* 列を右端へ足した。 */
  SCHEMA_UPGRADED: 'SCHEMA_UPGRADED',
  /* 列が改変されている。**書き込みを停止する。** */
  SCHEMA_ALTERED: 'SCHEMA_ALTERED',
});

/* ---------- キャッシュ（保存先IDのみ） ---------- */

/*
 * ID として妥当な形か。
 *
 * 形の検査であって、実在の確認ではない。壊れた値を持ったまま
 * API を叩いて 404 を踏むより、ここで捨てたほうが速い。
 * （領収書OCR の store.js の isFileId から取り込み）
 */
export function isFileId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{10,120}$/.test(value);
}

/*
 * 保存領域が使えない環境（プライベートモード等）でも壊れない。
 *
 * **キーが null のときは何もしない。** 年月フォルダのように
 * キャッシュを持たない解決があり、そこで `null` というキーの項目を
 * 作ってしまわないため。
 */
function readCache(key) {
  if (!key) {
    return null;
  }

  try {
    const value = globalThis.localStorage?.getItem(key);
    return isFileId(value) ? value : null;
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  if (!key) {
    return;
  }

  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* 書けなくても解決自体は成立する。次回また検索するだけ。 */
  }
}

function dropCache(key) {
  if (!key) {
    return;
  }

  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* 同上。 */
  }
}

/* 検証をやり直すためにキャッシュだけ捨てる。Drive 上の実体は消さない。 */
export function clearStorageCache() {
  for (const key of Object.values(STORAGE_KEYS)) {
    dropCache(key);
  }
}

/* ---------- 段階1: キャッシュの検証 ---------- */

/*
 * キャッシュしたIDがまだ使えるか確かめる。
 *
 * 戻り値 true … そのまま使ってよい
 *        false … キャッシュを捨てて探し直す
 *
 * **401 と通信不良ではキャッシュを捨てない。** 認可の問題や一時障害で
 * 捨ててしまうと、復旧したときに重複して作ることになる。
 * 名前・種別・親まで照合するのは、IDが別の何かを指していたときに
 * そこへ書き込まないため。
 */
async function verifyCachedId(id, { expectedName, expectedMime, parentId, token, fetchImpl, signal }) {
  try {
    const meta = await getFileMeta(id, { token, fetchImpl, signal });

    if (meta?.trashed === true) {
      return false;
    }

    if (meta?.mimeType !== expectedMime) {
      return false;
    }

    if (meta?.name !== expectedName) {
      return false;
    }

    if (parentId && Array.isArray(meta?.parents) && !meta.parents.includes(parentId)) {
      return false;
    }

    return true;
  } catch (error) {
    const code = error instanceof DriveError ? error.code : DriveErrorCode.UNKNOWN;

    if (code === DriveErrorCode.NOT_FOUND) {
      return false;
    }

    /*
     * **403 でも捨てない。** Drive はレート制限を 403 で返す
     * （drive-api.js、docs/receipt-ocr-findings-20260804.md #2）。
     * 権限が本当に無いなら、次の検索でも同じことが起きて例外になる。
     */
    throw error;
  }
}

/* ---------- 段階2・3: 検索と作成 ---------- */

/*
 * フォルダを3段階で解決する。
 *
 * 戻り値: { id, created, from }
 *   from … 'cache' | 'search' | 'created'
 */
export async function resolveFolder(name, parentId, cacheKey, { token, fetchImpl, signal } = {}) {
  const cached = readCache(cacheKey);

  if (cached) {
    const valid = await verifyCachedId(cached, {
      expectedName: name,
      expectedMime: DRIVE_FOLDER_MIME,
      parentId,
      token,
      fetchImpl,
      signal,
    });

    if (valid) {
      return { id: cached, created: false, from: 'cache' };
    }

    dropCache(cacheKey);
  }

  const found = await searchFiles(name, DRIVE_FOLDER_MIME, parentId, { token, fetchImpl, signal });

  if (found.length > 0) {
    /* 古い順に並べてある（drive-api.js）。先に作られたほうが正本。 */
    writeCache(cacheKey, found[0].id);
    return { id: found[0].id, created: false, from: 'search', duplicates: found.length };
  }

  const id = await createFolder(name, parentId, { token, fetchImpl, signal });
  writeCache(cacheKey, id);

  return { id, created: true, from: 'created' };
}

/*
 * 保存画像を入れる `images/YYYY/MM` を解決する（§FR-07）。
 *
 * **キャッシュは持たない。** 月が変われば別のフォルダになり、キーが
 * 増え続ける。登録は1件につき1回しか呼ばないので、検索2回で足りる。
 * （最も簡単な形を選んだ。速度が問題になったら考え直す）
 */
export async function resolveMonthFolder(imageFolderId, { year, month }, { token, fetchImpl, signal } = {}) {
  const yearFolder = await resolveFolder(String(year), imageFolderId, null, { token, fetchImpl, signal });

  return resolveFolder(String(month), yearFolder.id, null, { token, fetchImpl, signal });
}

/* 台帳をフォルダと同じ3段階で解決する。 */
export async function resolveSpreadsheet(parentFolderId, { token, fetchImpl, signal } = {}) {
  const cacheKey = STORAGE_KEYS.spreadsheet;
  const cached = readCache(cacheKey);

  if (cached) {
    const valid = await verifyCachedId(cached, {
      expectedName: SPREADSHEET_NAME,
      expectedMime: GOOGLE_SHEET_MIME,
      parentId: parentFolderId,
      token,
      fetchImpl,
      signal,
    });

    if (valid) {
      return { id: cached, created: false, from: 'cache' };
    }

    dropCache(cacheKey);
  }

  const found = await searchFiles(SPREADSHEET_NAME, GOOGLE_SHEET_MIME, parentFolderId, {
    token,
    fetchImpl,
    signal,
  });

  if (found.length > 0) {
    writeCache(cacheKey, found[0].id);
    return { id: found[0].id, created: false, from: 'search', duplicates: found.length };
  }

  const id = await createSpreadsheet(parentFolderId, { token, fetchImpl, signal });
  writeCache(cacheKey, id);

  return { id, created: true, from: 'created' };
}

/* ---------- 既存シートの健全性 ---------- */

/*
 * 既にある台帳が、そのまま使える状態かを見る。
 *
 * 戻り値: { writable, notices }
 *
 * **列が改変されていたら書き込みを停止する。** 位置で意味が決まる表へ
 * こちらの並びで書くと、値が別の列に入る。名刺は第三者の個人情報なので、
 * 電話番号の欄にメールが入るような壊し方をしてはならない。
 * （領収書OCR の inspectSpreadsheet から取り込み）
 */
export async function inspectSpreadsheet(spreadsheetId, { token, fetchImpl, signal } = {}) {
  const notices = new Set();
  const structure = await getStructure(spreadsheetId, { token, fetchImpl, signal });
  const titles = structure.tabs.map((tab) => tab.title);

  const lacking = missingTabs(titles, TAB_ORDER);

  if (lacking.length > 0) {
    await addTabs(spreadsheetId, lacking, { token, fetchImpl, signal });

    for (const title of lacking) {
      await writeHeader(spreadsheetId, title, TAB_COLUMNS[title], { token, fetchImpl, signal });
    }

    notices.add(StorageNotice.TABS_REPAIRED);
  }

  const header = await readHeader(spreadsheetId, TABS.data, { token, fetchImpl, signal });
  const verdict = verifyHeader(header, TAB_COLUMNS[TABS.data]);

  if (verdict.status === 'altered') {
    notices.add(StorageNotice.SCHEMA_ALTERED);
    return { writable: false, notices: [...notices] };
  }

  /*
   * **グリッドの幅を渡す。** 既定のシートは26列しかなく、27列目へ
   * 書こうとすると Sheets が 400 で弾く（sheets.js の ensureColumnCount）。
   * タブを作り直した直後は幅が変わっているので、取り直す。
   */
  const dataTab = (lacking.length > 0
    ? (await getStructure(spreadsheetId, { token, fetchImpl, signal })).tabs
    : structure.tabs).find((tab) => tab.title === TABS.data);

  if (verdict.status === 'empty') {
    await writeHeader(spreadsheetId, TABS.data, TAB_COLUMNS[TABS.data], { token, fetchImpl, signal });
  } else if (verdict.status === 'upgrade') {
    await appendMissingColumns(
      spreadsheetId,
      TABS.data,
      header.length,
      verdict.missing,
      {
        token,
        fetchImpl,
        signal,
        sheetId: dataTab?.sheetId ?? null,
        currentColumnCount: dataTab?.columnCount ?? 0,
      },
    );
    notices.add(StorageNotice.SCHEMA_UPGRADED);
  }

  return { writable: true, notices: [...notices] };
}

/* ---------- 全体 ---------- */

/*
 * 保存構造をまとめて用意する（§8.1 ステージ0）。
 *
 * 戻り値:
 *   { appFolderId, imageFolderId, spreadsheetId, writable, firstRun, notices, steps }
 *
 * firstRun … 台帳を**このとき作った**かどうか。§5.3 の明示事項を
 *            「初回利用時」に出すための判定に使う（§10.1）。
 *            利用者ごとの状態を localStorage で覚えるより、
 *            **Drive の実体を根拠にするほうが正確**である。
 *            端末を変えても、保存先があれば初回ではない。
 */
export async function ensureStorage({ token, fetchImpl, signal } = {}) {
  const notices = new Set();

  const root = await resolveFolder(ROOT_FOLDER_NAME, null, STORAGE_KEYS.rootFolder, {
    token, fetchImpl, signal,
  });

  const app = await resolveFolder(APP_FOLDER_NAME, root.id, STORAGE_KEYS.appFolder, {
    token, fetchImpl, signal,
  });

  const images = await resolveFolder(IMAGE_FOLDER_NAME, app.id, STORAGE_KEYS.imageFolder, {
    token, fetchImpl, signal,
  });

  const sheet = await resolveSpreadsheet(app.id, { token, fetchImpl, signal });

  let writable = true;

  if (sheet.created) {
    /*
     * 作ったばかりなので検査は要らない。
     * フォルダだけ残っていて台帳が消えていた場合は「作り直し」であり、
     * 過去データは戻らないことを伝える必要がある。
     */
    notices.add(app.created ? StorageNotice.CREATED : StorageNotice.RECREATED);
  } else {
    const inspection = await inspectSpreadsheet(sheet.id, { token, fetchImpl, signal });

    writable = inspection.writable;

    for (const notice of inspection.notices) {
      notices.add(notice);
    }
  }

  return {
    appFolderId: app.id,
    imageFolderId: images.id,
    spreadsheetId: sheet.id,
    writable,
    firstRun: sheet.created && app.created,
    notices: [...notices],
    steps: {
      root: root.from,
      app: app.from,
      images: images.from,
      spreadsheet: sheet.from,
    },
  };
}
