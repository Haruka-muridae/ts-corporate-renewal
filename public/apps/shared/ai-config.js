/*
 * AI利用モードとAPIキーの保存層。**雛形**
 *
 * ------------------------------------------------------------------
 * Phase 1 時点の状態
 * ------------------------------------------------------------------
 * 保存・検証・通知は実装済みだが、**設定画面（UI）は存在しない**。
 * モード選択とキー入力の画面は Phase 5 で apps/ai-settings.js として追加する。
 * 実際のAI呼び出しは ai-client.js / providers/ が担当する（未実装）。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * APIキーの取り扱い（重要）
 * ------------------------------------------------------------------
 * APIキーは **Google Drive へ保存しない**。
 * profile.json にも含めない（profile-store.js の PROFILE_FIELDS を参照）。
 *
 * 保存先はブラウザのみ。
 *   既定 … sessionStorage（タブを閉じれば消える）
 *   任意 … localStorage（利用者が「この端末に記憶する」を明示した場合のみ）
 *
 * 共有端末での残留を避けるため、既定は sessionStorage にしてある。
 * これを既定で localStorage へ変えないこと。
 *
 * キーは利用者自身のものであり、ブラウザから直接プロバイダへ送られる
 * （静的サイトのため中継サーバーが存在しない）。この事実は
 * 設定画面で必ず利用者へ明示すること。
 *
 * キーの実値をログ・エラーメッセージ・URL・外部送信へ載せないこと。
 * 画面へ出すときは maskApiKey() を通す。
 * ------------------------------------------------------------------
 */

/* AI利用モード。増やす場合は ai-client.js のプロバイダ対応表も更新する。 */
export const AI_MODE = Object.freeze({
  /* 無料モード: ブラウザ内で完結する処理のみ。外部へ送信しない。 */
  FREE: 'free',
  /* マイAPIキーモード: 利用者自身のGemini APIキーを使う。 */
  MY_KEY: 'my-key',
});

export const DEFAULT_AI_MODE = AI_MODE.FREE;

/* APIキーの保存先。 */
export const KEY_PERSIST = Object.freeze({
  SESSION: 'session',
  LOCAL: 'local',
});

export const DEFAULT_KEY_PERSIST = KEY_PERSIST.SESSION;

/* ストレージキー。 */
export const AI_STORAGE_KEYS = Object.freeze({
  mode: 'tsam-ai-mode',
  persist: 'tsam-ai-key-persist',
  geminiKey: 'tsam-ai-gemini-key',
});

/* 状態変化の通知イベント。detail: { mode, hasApiKey, persist } */
export const AI_CONFIG_EVENT = 'tsam-ai-config-change';

/*
 * Gemini APIキーの形式。
 * Google の APIキーは "AIza" で始まる39文字。
 * 将来の形式変更で弾かないよう、長さには幅を持たせている。
 */
const API_KEY_PATTERN = /^AIza[0-9A-Za-z_-]{20,60}$/;
const API_KEY_MAX_LENGTH = 200;

/* ---------- ストレージの安全な取得 ---------- */

/*
 * プライベートモードや設定によっては参照そのものが SecurityError を投げる。
 * 使用できない場合は null を返し、呼び出し側は保存なしで動作を継続する。
 */
function getStorage(kind) {
  try {
    const storage = kind === KEY_PERSIST.LOCAL
      ? globalThis.localStorage
      : globalThis.sessionStorage;

    return storage ?? null;
  } catch {
    return null;
  }
}

function readRaw(kind, key) {
  const storage = getStorage(kind);

  if (!storage) {
    return null;
  }

  try {
    const value = storage.getItem(key);
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

function writeRaw(kind, key, value) {
  const storage = getStorage(kind);

  if (!storage) {
    return false;
  }

  try {
    storage.setItem(key, value);
    return true;
  } catch {
    /* 容量超過・SecurityError など。 */
    return false;
  }
}

function removeRaw(kind, key) {
  const storage = getStorage(kind);

  if (!storage) {
    return false;
  }

  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/* ---------- 検証（純関数） ---------- */

export function isValidMode(mode) {
  return mode === AI_MODE.FREE || mode === AI_MODE.MY_KEY;
}

export function isValidPersist(persist) {
  return persist === KEY_PERSIST.SESSION || persist === KEY_PERSIST.LOCAL;
}

/*
 * APIキーの形式を確認する。
 * 戻り値: { ok, reason }
 *
 * ここで通っても、そのキーが有効である保証はない
 * （有効性の確認はプロバイダへの実際の呼び出しでしか行えない）。
 * 明らかな入力ミスを早く伝えるための検査である。
 */
export function validateApiKey(value) {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'APIキーを入力してください。' };
  }

  const key = value.trim();

  if (key === '') {
    return { ok: false, reason: 'APIキーを入力してください。' };
  }

  if (key.length > API_KEY_MAX_LENGTH) {
    return { ok: false, reason: 'APIキーが長すぎます。入力内容を確認してください。' };
  }

  if (!API_KEY_PATTERN.test(key)) {
    return { ok: false, reason: 'APIキーの形式が正しくありません。「AIza」で始まる文字列を貼り付けてください。' };
  }

  return { ok: true, reason: null };
}

/*
 * 画面表示用にキーを伏せる。
 * 末尾4文字だけを残す。**実値をそのまま画面へ出さないこと。**
 */
export function maskApiKey(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return '';
  }

  const key = value.trim();
  const tail = key.slice(-4);

  return `${'•'.repeat(8)}${tail}`;
}

/* ---------- モード ---------- */

export function getAiMode() {
  const stored = readRaw(KEY_PERSIST.LOCAL, AI_STORAGE_KEYS.mode);
  return isValidMode(stored) ? stored : DEFAULT_AI_MODE;
}

export function setAiMode(mode) {
  if (!isValidMode(mode)) {
    return false;
  }

  const saved = writeRaw(KEY_PERSIST.LOCAL, AI_STORAGE_KEYS.mode, mode);
  notify();
  return saved;
}

/* ---------- APIキーの保存先 ---------- */

export function getKeyPersist() {
  const stored = readRaw(KEY_PERSIST.LOCAL, AI_STORAGE_KEYS.persist);
  return isValidPersist(stored) ? stored : DEFAULT_KEY_PERSIST;
}

/* ---------- APIキー ---------- */

/*
 * 保存済みのAPIキーを返す。
 * 保存先の記録に関わらず両方を探す（記録だけが消えても取り出せるように）。
 *
 * 戻り値は実値。画面へ出す場合は必ず maskApiKey() を通すこと。
 */
export function getApiKey() {
  return readRaw(KEY_PERSIST.SESSION, AI_STORAGE_KEYS.geminiKey)
    ?? readRaw(KEY_PERSIST.LOCAL, AI_STORAGE_KEYS.geminiKey);
}

export function hasApiKey() {
  return getApiKey() !== null;
}

/*
 * APIキーを保存する。
 *
 * options.persist:
 *   'session' … sessionStorage（既定。タブを閉じれば消える）
 *   'local'   … localStorage（利用者が明示的に選んだ場合のみ）
 *
 * 戻り値: { ok, reason }
 * 形式が不正な場合は保存しない。
 */
export function setApiKey(value, { persist = DEFAULT_KEY_PERSIST } = {}) {
  const validation = validateApiKey(value);

  if (!validation.ok) {
    return validation;
  }

  const target = isValidPersist(persist) ? persist : DEFAULT_KEY_PERSIST;
  const key = value.trim();

  /* 保存先を変えたときに、前の場所へ残さない。 */
  removeRaw(KEY_PERSIST.SESSION, AI_STORAGE_KEYS.geminiKey);
  removeRaw(KEY_PERSIST.LOCAL, AI_STORAGE_KEYS.geminiKey);

  const saved = writeRaw(target, AI_STORAGE_KEYS.geminiKey, key);

  if (!saved) {
    return { ok: false, reason: 'このブラウザではAPIキーを保存できませんでした。プライベートモードを解除してお試しください。' };
  }

  writeRaw(KEY_PERSIST.LOCAL, AI_STORAGE_KEYS.persist, target);
  notify();

  return { ok: true, reason: null };
}

/* APIキーを消す。両方の保存先から確実に消す。 */
export function clearApiKey() {
  removeRaw(KEY_PERSIST.SESSION, AI_STORAGE_KEYS.geminiKey);
  removeRaw(KEY_PERSIST.LOCAL, AI_STORAGE_KEYS.geminiKey);
  removeRaw(KEY_PERSIST.LOCAL, AI_STORAGE_KEYS.persist);
  notify();
  return true;
}

/* ---------- まとめて取得 / 通知 ---------- */

/*
 * 現在のAI設定。**APIキーの実値は含めない。**
 * 画面や他モジュールへ渡してよいのはこの形だけにする。
 */
export function getAiConfig() {
  return {
    mode: getAiMode(),
    hasApiKey: hasApiKey(),
    persist: getKeyPersist(),
  };
}

/*
 * マイAPIキーモードとして実際に使える状態かどうか。
 * モードが my-key でもキー未登録なら false。
 */
export function isMyKeyReady() {
  return getAiMode() === AI_MODE.MY_KEY && hasApiKey();
}

function notify() {
  if (typeof globalThis.document === 'undefined' || typeof CustomEvent !== 'function') {
    return;
  }

  globalThis.document.dispatchEvent(new CustomEvent(AI_CONFIG_EVENT, {
    detail: getAiConfig(),
  }));
}

/*
 * 設定変更を購読する。
 * 登録直後に現在値で1回呼ばれる（初期描画のため）。
 * 戻り値を呼ぶと解除できる。
 */
export function subscribeAiConfig(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }

  const handler = (event) => {
    try {
      listener(event.detail ?? getAiConfig());
    } catch {
      /* 購読者の例外で設定の保存経路を壊さない。 */
    }
  };

  try {
    listener(getAiConfig());
  } catch {
    /* 同上。 */
  }

  if (typeof globalThis.document === 'undefined') {
    return () => {};
  }

  globalThis.document.addEventListener(AI_CONFIG_EVENT, handler);

  return () => {
    globalThis.document.removeEventListener(AI_CONFIG_EVENT, handler);
  };
}
