/*
 * マイページ情報（プロフィール）の保存層。**雛形**
 *
 * ------------------------------------------------------------------
 * Phase 1 時点の状態
 * ------------------------------------------------------------------
 * 検証・キャッシュ・Drive同期は実装済みだが、**画面（UI）は存在しない**。
 * 入力フォームと概要表示は Phase 3-4 で apps/mypage.js として追加する。
 *
 * PROFILE_FIELDS の項目定義は **暫定** である。
 * 実際に必要な項目が決まったら、この配列だけを直せばよい形にしてある
 * （検証・保存・概要表示はすべてこの表から導出される）。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 保存方針
 * ------------------------------------------------------------------
 * 正本   … 利用者自身のGoogle Drive
 *          マイドライブ / TSAM AI / マイページ / profile.json
 * キャッシュ … このブラウザの localStorage（読み取り高速化と初回判定のため）
 *
 * なぜ localStorage が必要か:
 *   Drive を読むにはアクセストークンが要り、その取得はポップアップを伴う。
 *   ポップアップは利用者の操作からしか開けないため、
 *   「ページを開いた瞬間に Drive を読む」ことができない。
 *   そこで前回の内容をキャッシュし、初回かどうかの判定にも使う。
 *
 * 保存してはならないもの:
 *   Gemini APIキー / アクセストークン / IDトークン / パスワード。
 *   これらを PROFILE_FIELDS へ追加しないこと（Driveへ送られてしまう）。
 *
 * このプロフィールは利用者自身が入力した情報であり、
 * 本人確認の結果ではない。アクセス制御や権限判定に使わない。
 * ------------------------------------------------------------------
 */

import {
  DRIVE_PATHS,
  ensureFolderPath,
  readJsonFile,
  writeJsonFile,
  isUnauthorized,
  formatPath,
} from './drive-files.js';

import {
  withAccessToken,
  getSignedInProfile,
} from './drive-auth.js';

/* 保存形式のバージョン。形式を変えたら +1 する（旧データは読み替えるか破棄する）。 */
export const PROFILE_SCHEMA_VERSION = 1;

/* マイドライブ直下からのフォルダ階層。 */
export const PROFILE_FOLDER_PATH = Object.freeze([DRIVE_PATHS.ROOT, DRIVE_PATHS.MYPAGE]);

export const PROFILE_FILE_NAME = 'profile.json';

/* localStorage のキー。 */
export const PROFILE_CACHE_KEY = 'tsam-ai-profile-cache';

/* 状態変化の通知イベント。detail: { source, profile } */
export const PROFILE_EVENT = 'tsam-profile-change';

/* キャッシュの発生源。UI側が「Driveと同期済みか」を判別するために使う。 */
export const PROFILE_SOURCE = Object.freeze({
  CACHE: 'cache',
  DRIVE: 'drive',
  CLEARED: 'cleared',
});

/*
 * ------------------------------------------------------------------
 * 項目定義（暫定）
 * ------------------------------------------------------------------
 * 実際の項目が確定したらこの配列を差し替える。ここだけで完結する。
 *   key       … profile.json 内のキー。変更するとバージョンを上げる必要がある
 *   label     … 画面表示名（UI実装時に使用）
 *   maxLength … 上限文字数。超えたら検証エラー
 *   required  … 必須かどうか
 *   summary   … 登録後の概要表示に出すかどうか
 *
 * 秘密情報（APIキー・パスワード等）の項目を追加しないこと。
 * ------------------------------------------------------------------
 */
export const PROFILE_FIELDS = Object.freeze([
  { key: 'displayName', label: '表示名', maxLength: 64, required: true, summary: true },
  { key: 'company', label: '会社名', maxLength: 128, required: false, summary: true },
  { key: 'department', label: '部署', maxLength: 64, required: false, summary: true },
  { key: 'position', label: '役職', maxLength: 64, required: false, summary: false },
  { key: 'email', label: '連絡先メールアドレス', maxLength: 254, required: false, summary: false },
  { key: 'note', label: 'メモ', maxLength: 500, required: false, summary: false },
]);

/* ---------- ストレージの安全な取得 ---------- */

/*
 * localStorage を安全に取得する。
 * プライベートモードや設定によっては参照そのものが SecurityError を投げる。
 * 使用できない場合は null を返し、呼び出し側は保存なしで動作を継続する。
 */
function getStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    /* SecurityError など。キャッシュ無しでも機能自体は動く。 */
    return null;
  }
}

/* ---------- 検証（純関数） ---------- */

/*
 * 表示・保存に使える文字列へ整える。
 * 制御文字（タブ・改行・NUL・DELなど）を除去する。
 * 制御文字の正規表現リテラルを避け、文字コードで判定する。
 */
function toSafeString(value) {
  if (typeof value !== 'string') {
    return '';
  }

  let cleaned = '';

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);

    if (code > 0x1f && code !== 0x7f) {
      cleaned += value[i];
    }
  }

  return cleaned.trim();
}

/*
 * 入力値を検証して正規化する。
 *
 * 戻り値: { values, errors }
 *   values … PROFILE_FIELDS のキーだけを持つオブジェクト（未入力は空文字）
 *   errors … { フィールドキー: 理由 }。空オブジェクトなら検証通過
 *
 * 未知のキーは黙って捨てる（画面から余計な値が混ざらないようにするため）。
 */
export function sanitizeProfileValues(raw) {
  const values = {};
  const errors = {};

  const source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};

  PROFILE_FIELDS.forEach((field) => {
    const value = toSafeString(source[field.key]);

    if (value === '' && field.required) {
      errors[field.key] = `${field.label}を入力してください。`;
    }

    if (value.length > field.maxLength) {
      errors[field.key] = `${field.label}は${field.maxLength}文字以内で入力してください。`;
    }

    if (field.key === 'email' && value !== '' && !value.includes('@')) {
      errors[field.key] = 'メールアドレスの形式が正しくありません。';
    }

    values[field.key] = value;
  });

  return { values, errors };
}

export function hasValidationErrors(errors) {
  return Boolean(errors) && Object.keys(errors).length > 0;
}

/* profile.json として書き出す形を組み立てる。 */
export function buildProfileDocument(values, { sub = null, updatedAt = null } = {}) {
  const { values: safeValues } = sanitizeProfileValues(values);

  return {
    v: PROFILE_SCHEMA_VERSION,
    sub: typeof sub === 'string' && sub !== '' ? sub : null,
    updatedAt: updatedAt ?? new Date().toISOString(),
    profile: safeValues,
  };
}

/*
 * profile.json から読んだ生データを検証する。
 * 形式違い・バージョン不一致は null を返す（例外は投げない）。
 * 呼び出し側は「壊れていたら入力し直してもらう」判断ができる。
 */
export function parseProfileDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  if (raw.v !== PROFILE_SCHEMA_VERSION) {
    return null;
  }

  const { values } = sanitizeProfileValues(raw.profile);

  return {
    v: PROFILE_SCHEMA_VERSION,
    sub: typeof raw.sub === 'string' && raw.sub !== '' ? raw.sub : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    profile: values,
  };
}

/*
 * 登録後の概要表示に使う項目を、定義順で返す。
 * DOMは作らない（表示は呼び出し側の責任）。
 */
export function getProfileSummary(document_) {
  const values = document_?.profile;

  if (!values || typeof values !== 'object') {
    return [];
  }

  return PROFILE_FIELDS
    .filter((field) => field.summary && toSafeString(values[field.key]) !== '')
    .map((field) => ({
      key: field.key,
      label: field.label,
      value: toSafeString(values[field.key]),
    }));
}

/* ---------- 通知 ---------- */

function notify(source, document_) {
  if (typeof globalThis.document === 'undefined' || typeof CustomEvent !== 'function') {
    return;
  }

  globalThis.document.dispatchEvent(new CustomEvent(PROFILE_EVENT, {
    detail: { source, profile: document_ ?? null },
  }));
}

/* ---------- キャッシュ（localStorage） ---------- */

/*
 * 読み出す。
 * 形式違い・JSON破損・バージョン不一致は、その場で削除して null を返す。
 * 呼び出し側は「壊れたデータで画面が壊れる」ことを考えなくてよい。
 */
export function readCachedProfile() {
  const storage = getStorage();

  if (!storage) {
    return null;
  }

  let raw;

  try {
    raw = storage.getItem(PROFILE_CACHE_KEY);
  } catch {
    return null;
  }

  if (typeof raw !== 'string' || raw === '') {
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    clearCachedProfile();
    return null;
  }

  const document_ = parseProfileDocument(parsed);

  if (!document_) {
    clearCachedProfile();
    return null;
  }

  return document_;
}

/* 保存する。失敗しても例外を外へ出さない（保存できなくても表示は続行する）。 */
export function writeCachedProfile(document_, { source = PROFILE_SOURCE.CACHE } = {}) {
  const storage = getStorage();
  const valid = parseProfileDocument(document_);

  if (!storage || !valid) {
    return false;
  }

  try {
    storage.setItem(PROFILE_CACHE_KEY, JSON.stringify(valid));
  } catch {
    /* 容量超過・SecurityError など。 */
    return false;
  }

  notify(source, valid);
  return true;
}

/* 削除する。存在しない場合も成功扱い。 */
export function clearCachedProfile() {
  const storage = getStorage();

  if (!storage) {
    return false;
  }

  try {
    storage.removeItem(PROFILE_CACHE_KEY);
  } catch {
    return false;
  }

  notify(PROFILE_SOURCE.CLEARED, null);
  return true;
}

/*
 * 「初回ログインかどうか」の判定。
 *
 * 現在ログイン中のアカウント（sub）のキャッシュがあれば登録済みとみなす。
 * sub が一致しない＝別アカウントでログインした場合は未登録として扱う。
 *
 * キャッシュが消えている（iOS の保存期間制限など）場合も false になるため、
 * UI は「Driveから読み込む」導線を必ず用意すること。
 */
export function hasRegisteredProfile() {
  const cached = readCachedProfile();

  if (!cached) {
    return false;
  }

  const sub = getSignedInProfile()?.sub ?? null;

  if (sub && cached.sub && cached.sub !== sub) {
    return false;
  }

  return true;
}

/* 別アカウントのキャッシュが残っていたら捨てる。ログイン切り替え時に呼ぶ。 */
export function dropCacheForOtherAccount() {
  const cached = readCachedProfile();
  const sub = getSignedInProfile()?.sub ?? null;

  if (cached && sub && cached.sub && cached.sub !== sub) {
    clearCachedProfile();
    return true;
  }

  return false;
}

/* ---------- Drive 同期 ---------- */

/*
 * Drive から profile.json を読み込み、キャッシュを更新する。
 *
 * 戻り値: プロフィール（未登録なら null）
 *
 * **利用者の操作（ボタン押下）から呼ぶこと。**
 * 認可ポップアップを伴うため、ページ読み込み時に自動で呼んではならない。
 */
export async function loadProfileFromDrive({ signal } = {}) {
  const result = await withAccessToken(
    async (token) => {
      const folderId = await ensureFolderPath(PROFILE_FOLDER_PATH, { token, signal });

      return readJsonFile({
        token,
        name: PROFILE_FILE_NAME,
        parentId: folderId,
        signal,
      });
    },
    { shouldReauth: isUnauthorized },
  );

  if (!result) {
    /* ファイルが無い＝まだ登録していない。エラーではない。 */
    return null;
  }

  const document_ = parseProfileDocument(result.data);

  if (!document_) {
    /*
     * 壊れている、または旧バージョン。
     * 勝手に上書きせず、未登録として扱って入力し直してもらう。
     */
    return null;
  }

  writeCachedProfile(document_, { source: PROFILE_SOURCE.DRIVE });
  return document_;
}

/*
 * プロフィールを Drive へ保存し、キャッシュを更新する。
 *
 * 戻り値: { profile, file, created }
 * 検証に失敗した場合は { errors } を持つ Error を投げる。
 *
 * **利用者の操作（保存ボタン押下）から呼ぶこと。**
 */
export async function saveProfileToDrive(values, { signal } = {}) {
  const { values: safeValues, errors } = sanitizeProfileValues(values);

  if (hasValidationErrors(errors)) {
    const error = new Error('PROFILE_INVALID');
    error.name = 'ProfileValidationError';
    error.errors = errors;
    throw error;
  }

  const sub = getSignedInProfile()?.sub ?? null;
  const document_ = buildProfileDocument(safeValues, { sub });

  const written = await withAccessToken(
    async (token) => {
      const folderId = await ensureFolderPath(PROFILE_FOLDER_PATH, { token, signal });

      return writeJsonFile({
        token,
        name: PROFILE_FILE_NAME,
        parentId: folderId,
        data: document_,
        signal,
      });
    },
    { shouldReauth: isUnauthorized },
  );

  writeCachedProfile(document_, { source: PROFILE_SOURCE.DRIVE });

  return {
    profile: document_,
    file: written.file,
    created: written.created,
  };
}

/* 画面へ出す保存先の説明文。「マイドライブ / TSAM AI / マイページ / profile.json」 */
export function describeProfileLocation() {
  return `${formatPath(PROFILE_FOLDER_PATH)} / ${PROFILE_FILE_NAME}`;
}
