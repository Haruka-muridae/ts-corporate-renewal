/*
 * 保存先フォルダの解決。
 *
 * ------------------------------------------------------------------
 * localStorage は正本ではなくキャッシュ
 * ------------------------------------------------------------------
 * 正本は Drive 上の実体（フォルダそのもの）で、localStorage は
 * 「前回そこにあった」という手がかりに過ぎない。
 * したがって空でも、消えても、別端末・別ブラウザ・シークレットモードでも動く。
 *
 * 解決は必ず次の3段階を通る。
 *
 *   段階1 … キャッシュのIDを files.get で検証する
 *            有効          → そのまま使う
 *            404/403/削除済み/名前・親・種別の不一致 → キャッシュを捨てて段階2
 *            401           → キャッシュは捨てない（認可の問題なので再認可する）
 *            通信不良/5xx  → キャッシュは捨てない（一時障害で消すと復旧が壊れる）
 *
 *   段階2 … 名前・親ID・種別・未削除を条件に Drive を検索する
 *            見つかれば ID をキャッシュへ書き戻す。
 *            **localStorage が消えただけなら、ここで必ず復旧する。**
 *
 *   段階3 … 見つからなければ作成する。
 *            **キャッシュが空というだけでは作らない。** 段階2の検索を必ず通し、
 *            本当に存在しないと分かってから作る。
 *
 * 例外は「同名の TSAM AI が複数見つかった場合」だけ。
 * どれが本物かはアプリには判断できないため、利用者に選んでもらう。
 * ------------------------------------------------------------------
 *
 * このアプリ群は自分で作る「TSAM AI」配下だけを使う前提なので、
 * Drive 全体から任意のフォルダを選ばせる仕組み（Google Picker）は持たない。
 * drive.file の範囲で見つからなければ、同じ名前で作れば足りる。
 * ------------------------------------------------------------------
 *
 * 旧バージョンのキー（-v2 など）は読み書きしない。移行処理も持たない。
 */

import {
  ATTACHMENT_FOLDER_NAME,
  APP_FOLDER_NAME,
  BACK_IMAGE_FOLDER_NAME,
  DRIVE_FOLDER_MIME,
  DriveError,
  DriveErrorCode,
  FRONT_IMAGE_FOLDER_NAME,
  IMAGE_FOLDER_NAME,
  ROOT_FOLDER_NAME,
  createFolder,
  getFileMeta,
  searchFolders,
} from './drive-ocr.js';

/* ---------- キャッシュのキー ---------- */

/*
 * すべて v3。v2 以前のキーは読み書きしない。
 * ここに入れてよいのは Drive のフォルダIDだけで、IDは秘密情報ではない。
 * アクセストークンは絶対に入れない（認可は drive-auth.js がメモリで持つ）。
 */
export const FOLDER_STORAGE_KEYS = Object.freeze({
  root: 'tsam-card-scanner-root-folder-id-v3',
  app: 'tsam-card-scanner-app-folder-id-v3',
  image: 'tsam-card-scanner-image-folder-id-v3',
  frontImage: 'tsam-card-scanner-front-image-folder-id-v3',
  backImage: 'tsam-card-scanner-back-image-folder-id-v3',
  attachment: 'tsam-card-scanner-attachment-folder-id-v3',
});

/* 解決の結果。呼び出し側はこれを見て画面を出し分ける。 */
export const FolderResolution = Object.freeze({
  CACHED: 'cached',       // キャッシュが有効だった
  FOUND: 'found',         // 検索で見つかった
  CREATED: 'created',     // 新規作成した
  NEEDS_CHOICE: 'needs-choice', // 利用者に決めてもらう必要がある
});

/* ---------- ログ ---------- */

let logger = () => {};

export function setFoldersLogger(fn) {
  logger = typeof fn === 'function' ? fn : () => {};
}

/* ---------- localStorage ---------- */

export function readCachedId(storageKey) {
  try {
    const value = globalThis.localStorage?.getItem(storageKey);
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    /* プライベートモードなどで使えない。検索から始めればよい。 */
    return null;
  }
}

export function writeCachedId(storageKey, id) {
  try {
    globalThis.localStorage?.setItem(storageKey, id);
  } catch {
    /* 保存できなくても動作に支障はない（毎回検索するだけ）。 */
  }
}

export function clearCachedId(storageKey) {
  try {
    globalThis.localStorage?.removeItem(storageKey);
  } catch {
    /* 何もしない。 */
  }
}

/* ---------- 検証 ---------- */

/*
 * 取得したメタデータが期待どおりかを確かめる。
 *
 * 名前・親・種別・未削除のすべてを見る。
 * IDだけ生きていても、別のフォルダへ移動されていたり名前が変わっていたら
 * 保存先として使わない（気付かないまま別の場所へ保存するのを防ぐ）。
 *
 * parentId が 'root' の場合、files.get の parents にはマイドライブの実IDが入る。
 * 実IDは分からないため、「親が1つだけある」ことを条件にする。
 */
export function isExpectedFolder(meta, { name, parentId }) {
  if (!meta || meta.trashed === true) {
    return false;
  }

  if (meta.mimeType !== DRIVE_FOLDER_MIME) {
    return false;
  }

  if (String(meta.name ?? '') !== name) {
    return false;
  }

  const parents = Array.isArray(meta.parents) ? meta.parents : [];

  if (parentId === null || parentId === 'root') {
    return parents.length === 1;
  }

  return parents.includes(parentId);
}

/*
 * エラーからキャッシュを捨ててよいかを決める。
 *
 * 捨てる     … 404（無い）/ 403（権限が無い）
 * 捨てない   … 401（認可）/ ネットワーク / 5xx / その他
 *
 * 通信不良で捨ててしまうと、オフラインになるたびに復旧フローが起動して
 * 利用者に不要な選択を迫ることになる。ここは慎重側に倒す。
 */
export function shouldDropCache(error) {
  if (!(error instanceof DriveError)) {
    return false;
  }

  return error.code === DriveErrorCode.NOT_FOUND || error.code === DriveErrorCode.FORBIDDEN;
}

/*
 * 段階1。キャッシュのIDを検証する。
 *
 * 戻り値: 有効なら id、無効なら null（このときキャッシュは削除済み）
 * 401・通信不良はそのまま投げる（呼び出し側で再認可・再試行させる）。
 */
async function verifyCachedId({ storageKey, name, parentId, token, fetchImpl }) {
  const cached = readCachedId(storageKey);

  if (!cached) {
    return null;
  }

  let meta;

  try {
    meta = await getFileMeta(cached, { token, fetchImpl });
  } catch (error) {
    if (shouldDropCache(error)) {
      clearCachedId(storageKey);
      logger('folder:cache-dropped', { key: storageKey, reason: error.code });
      return null;
    }

    /* 401・NETWORK・SERVER_ERROR はキャッシュを残したまま上へ。 */
    throw error;
  }

  if (!isExpectedFolder(meta, { name, parentId })) {
    clearCachedId(storageKey);
    logger('folder:cache-dropped', { key: storageKey, reason: 'mismatch' });
    return null;
  }

  return cached;
}

/* ---------- 解決 ---------- */

/*
 * フォルダを1つ解決する。
 *
 * options:
 *   name        … フォルダ名
 *   parentId    … 親のID（最上位は null = マイドライブ直下）
 *   storageKey  … キャッシュのキー
 *   autoCreate  … 見つからないときに作ってよいか（既定 true）
 *   requireChoiceOnMultiple
 *               … 同名が複数見つかったときに、勝手に選ばないか
 *                 true  … NEEDS_CHOICE を返し、候補を呼び出し側へ渡す
 *                 false … modifiedTime の新しい方を採用する
 *
 * 戻り値: { id, resolution, candidates }
 *   candidates … 選択の対象となる候補（[{id,name,modifiedTime}]）
 */
export async function resolveFolder({
  name,
  parentId = null,
  storageKey,
  autoCreate = true,
  requireChoiceOnMultiple = false,
  token,
  fetchImpl,
}) {
  /* 段階1 */
  const cached = await verifyCachedId({ storageKey, name, parentId, token, fetchImpl });

  if (cached) {
    logger('folder:resolved', { key: storageKey, from: 'cache' });
    return { id: cached, resolution: FolderResolution.CACHED, candidates: [] };
  }

  /* 段階2 */
  const found = await searchFolders(name, parentId, { token, fetchImpl });

  /*
   * 同名が複数ある場合、どれが「本物」かはアプリには判断できない。
   * 更新日時が新しいものが正しいとは限らず（古い方に実データが入っていることもある）、
   * 黙って選ぶと、利用者が気付かないまま別のフォルダへ保存し続けることになる。
   * そのため最上位フォルダでは選ばせる。
   */
  if (found.length > 1 && requireChoiceOnMultiple) {
    logger('folder:multiple', { key: storageKey, count: found.length });
    return { id: null, resolution: FolderResolution.NEEDS_CHOICE, candidates: found };
  }

  if (found.length > 0) {
    writeCachedId(storageKey, found[0].id);
    logger('folder:resolved', { key: storageKey, from: 'search', count: found.length });

    return {
      id: found[0].id,
      resolution: FolderResolution.FOUND,
      candidates: [],
    };
  }

  /* 段階3 */
  if (!autoCreate) {
    logger('folder:needs-choice', { key: storageKey });
    return { id: null, resolution: FolderResolution.NEEDS_CHOICE, candidates: [] };
  }

  const created = await createFolder(name, parentId, { token, fetchImpl });
  writeCachedId(storageKey, created);
  logger('folder:resolved', { key: storageKey, from: 'created' });

  return { id: created, resolution: FolderResolution.CREATED, candidates: [] };
}

/*
 * 最上位の TSAM AI を解決する。
 *
 * キャッシュ検証 → 検索 → 作成、の順。見つからなければそのまま作る。
 *
 * 例外は同名が複数見つかった場合だけで、そのときは
 * { id: null, resolution: NEEDS_CHOICE, candidates } を返して利用者に選ばせる。
 */
export function resolveRootFolder({ token, fetchImpl }) {
  return resolveFolder({
    name: ROOT_FOLDER_NAME,
    parentId: null,
    storageKey: FOLDER_STORAGE_KEYS.root,
    requireChoiceOnMultiple: true,
    token,
    fetchImpl,
  });
}

/*
 * 候補一覧から選ばれたフォルダを、最上位として採用してよいか検証する。
 *
 * 名前が TSAM AI であること、フォルダであること、マイドライブ直下にあること、
 * そして files.get で実際に読めることを確かめる。
 * ひとつでも欠けたら採用しない。誤って別のフォルダを保存先にすると、
 * 利用者のDriveに見に覚えのない階層ができてしまう。
 *
 * 戻り値: { ok: true, id } または { ok: false, reason }
 *   reason … 'name' | 'mime' | 'parent' | 'access'
 */
export async function adoptCandidateRootFolder({ folderId, token, fetchImpl }) {
  let meta;

  try {
    meta = await getFileMeta(folderId, { token, fetchImpl });
  } catch (error) {
    logger('folder:candidate-rejected', {
      reason: 'access',
      code: error instanceof DriveError ? error.code : 'UNEXPECTED',
    });
    return { ok: false, reason: 'access' };
  }

  if (meta?.mimeType !== DRIVE_FOLDER_MIME || meta?.trashed === true) {
    logger('folder:candidate-rejected', { reason: 'mime' });
    return { ok: false, reason: 'mime' };
  }

  if (String(meta?.name ?? '') !== ROOT_FOLDER_NAME) {
    logger('folder:candidate-rejected', { reason: 'name' });
    return { ok: false, reason: 'name' };
  }

  /* マイドライブ直下 = 親がちょうど1つ。共有ドライブや入れ子は受け付けない。 */
  const parents = Array.isArray(meta?.parents) ? meta.parents : [];

  if (parents.length !== 1) {
    logger('folder:candidate-rejected', { reason: 'parent' });
    return { ok: false, reason: 'parent' };
  }

  writeCachedId(FOLDER_STORAGE_KEYS.root, folderId);
  logger('folder:candidate-adopted', {});

  return { ok: true, id: folderId };
}

/*
 * 最上位が決まったあとの階層を用意する。
 *
 *   TSAM AI / 名刺スキャナ / 名刺画像 / 表面画像
 *                                    / 裏面画像
 *
 * 添付ファイルフォルダはここでは作らない。
 * 現時点で使う機能が無く、空のフォルダを先回りで置いても利用者を戸惑わせるだけで、
 * 「何のためにあるのか分からないフォルダ」が残る。
 * 実際に添付を保存するときに ensureAttachmentFolder() で作る。
 *
 * 戻り値: { app, image, frontImage, backImage }
 */
export async function ensureFolderTree({ rootId, token, fetchImpl }) {
  const options = { token, fetchImpl };

  const app = await resolveFolder({
    name: APP_FOLDER_NAME,
    parentId: rootId,
    storageKey: FOLDER_STORAGE_KEYS.app,
    ...options,
  });

  const image = await resolveFolder({
    name: IMAGE_FOLDER_NAME,
    parentId: app.id,
    storageKey: FOLDER_STORAGE_KEYS.image,
    ...options,
  });

  const frontImage = await resolveFolder({
    name: FRONT_IMAGE_FOLDER_NAME,
    parentId: image.id,
    storageKey: FOLDER_STORAGE_KEYS.frontImage,
    ...options,
  });

  const backImage = await resolveFolder({
    name: BACK_IMAGE_FOLDER_NAME,
    parentId: image.id,
    storageKey: FOLDER_STORAGE_KEYS.backImage,
    ...options,
  });

  return {
    app: app.id,
    image: image.id,
    frontImage: frontImage.id,
    backImage: backImage.id,
  };
}

/*
 * 添付ファイルフォルダを用意する。**初回の添付保存時に呼ぶ。**
 *
 * 起動時やフォルダ階層の準備時には呼ばないこと。
 * 使わないうちから空のフォルダを作ると、利用者のDriveに用途の分からない
 * 入れ物が増える。必要になった時点で作れば階層は同じ形になる。
 *
 * 添付機能そのものは未実装なので、現時点でこの関数を呼ぶ箇所は無い。
 */
export function ensureAttachmentFolder({ appFolderId, token, fetchImpl }) {
  return resolveFolder({
    name: ATTACHMENT_FOLDER_NAME,
    parentId: appFolderId,
    storageKey: FOLDER_STORAGE_KEYS.attachment,
    token,
    fetchImpl,
  });
}
