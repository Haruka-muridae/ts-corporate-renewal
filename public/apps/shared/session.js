/*
 * TSAM AI のログインセッション。
 * ログイン状態の読み書きは、必ずこのモジュール経由で行う。
 *
 * ------------------------------------------------------------------
 * 保存するもの / 保存しないもの
 * ------------------------------------------------------------------
 * 保存する:
 *   userId / displayName / loginId / provider / aal / emailConfirmed /
 *   issuedAt / expiresAt / v(形式バージョン)
 *
 * 保存しない:
 *   パスワード / パスワードのハッシュ / アクセストークン /
 *   refresh token / IDトークン / Cookie / URLパラメータ
 *
 * ------------------------------------------------------------------
 * Supabase のセッションとの関係（Phase 3 以降）
 * ------------------------------------------------------------------
 * 本物のトークンは Supabase SDK が別のキー（tsam-ai-supabase-auth）で
 * 管理し、自動更新もそちらが行う。
 *
 * ここに置くのは **画面表示用の写し** である。
 * 二重管理に見えるが、次の理由で分けている。
 *   1. requireAuth() を同期関数のままにしたい
 *      （Supabase の getSession() は非同期。待つと未ログインの画面が一瞬見える）
 *   2. 認証プロバイダを差し替えても、画面側のコードを変えずに済む
 *
 * 写しは restoreSession() と onAuthStateChange で更新される。
 * 写しだけを書き換えてもトークンは手に入らないため、
 * 「写しを偽装すれば画面は開くが、APIは通らない」状態になる。
 * ------------------------------------------------------------------
 *
 * パスワードはこのモジュールへ渡らない。
 * 認証プロバイダ（shared/auth-providers/*.js）が受け取り、
 * 結果として得られた利用者情報だけがここへ来る。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * これはセキュリティ境界ではない（重要）
 * ------------------------------------------------------------------
 * 静的サイトにサーバーが無いため、ここに入っている「ログイン状態」は
 * 利用者のブラウザが自己申告している値にすぎない。
 * 開発者ツールから自由に書き換えられる。
 *
 * 使ってよい用途: 画面の出し分け / 表示名の表示 / 導線の制御 / 利便性向上
 * 使ってはいけない用途:
 *   アクセス制御 / 権限判定 / 課金判定 / 秘密情報の保護 /
 *   「このデータは他人に見えない」ことの根拠
 *
 * 本当に守るべきデータが出てきた時点で、サーバー側の検証が必須になる。
 * ------------------------------------------------------------------
 */

/*
 * 保存形式のバージョン。形式を変えたら +1 する（旧データは自動破棄される）。
 * v2: aal（二段階認証の到達段階）と emailConfirmed を追加。
 */
export const SESSION_SCHEMA_VERSION = 2;

/*
 * 認証の到達段階（Authenticator Assurance Level）。
 *   AAL1 … パスワードのみ
 *   AAL2 … パスワード＋二段階認証（TOTP）まで完了
 *
 * 二段階認証を登録していない利用者は AAL1 のままで正常。
 * 「登録済みなのに AAL1」は、まだコード入力が済んでいない状態を指す。
 */
export const AAL = Object.freeze({
  ONE: 'aal1',
  TWO: 'aal2',
});

export const SESSION_STORAGE_KEY = 'tsam-ai-session';

/* 状態変化の通知イベント。detail: { authenticated, session } */
export const SESSION_EVENT = 'tsam-session-change';

/*
 * セッションの既定の有効期間。
 * 期限が切れたら readSession() が null を返し、自動的にログアウト状態になる。
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/*
 * 保存先。
 *   'local'   … localStorage。タブを閉じても、期限内なら維持される
 *   'session' … sessionStorage。タブを閉じると消える（共有端末向け）
 *
 * ここを 'session' へ変えるだけで挙動が切り替わる。他の変更は要らない。
 */
export const SESSION_STORAGE_KIND = 'local';

/* 想定外に長い値でストレージを圧迫しないための上限。 */
const LIMITS = Object.freeze({
  userId: 128,
  displayName: 64,
  loginId: 128,
  provider: 32,
});

/* 極端に先の期限は壊れた値として扱う。 */
const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/* ---------- ストレージの安全な取得 ---------- */

/*
 * プライベートモードや設定によっては参照そのものが SecurityError を投げる。
 * 使用できない場合は null を返す。
 * そのときログイン状態は保持されない（ページ遷移で失われる）が、
 * 画面自体は壊れない。
 */
function getStorage() {
  try {
    const storage = SESSION_STORAGE_KIND === 'session'
      ? globalThis.sessionStorage
      : globalThis.localStorage;

    return storage ?? null;
  } catch {
    return null;
  }
}

/* この端末でログイン状態を保持できるか。画面の案内出し分けに使う。 */
export function isStorageAvailable() {
  return getStorage() !== null;
}

/* ---------- 検証（純関数） ---------- */

/*
 * 表示・保存に使える文字列へ整える。
 * 制御文字（タブ・改行・NUL・DELなど）を除去する。
 * 制御文字の正規表現リテラルを避け、文字コードで判定する。
 */
function toSafeString(value, maxLength) {
  if (typeof value !== 'string') {
    return null;
  }

  let cleaned = '';

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);

    if (code > 0x1f && code !== 0x7f) {
      cleaned += value[i];
    }
  }

  const trimmed = cleaned.trim();

  if (trimmed === '' || trimmed.length > maxLength) {
    return null;
  }

  return trimmed;
}

/*
 * セッションとして成立している形かを確認する。
 * 成立しなければ null を返す（例外は投げない）。
 */
export function sanitizeSession(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  if (raw.v !== SESSION_SCHEMA_VERSION) {
    return null;
  }

  const userId = toSafeString(raw.userId, LIMITS.userId);

  if (userId === null) {
    return null;
  }

  const expiresAt = raw.expiresAt;

  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return null;
  }

  if (expiresAt > Date.now() + MAX_LIFETIME_MS) {
    /* 期限が異常に先。壊れた値として扱う。 */
    return null;
  }

  const issuedAt = typeof raw.issuedAt === 'number' && Number.isFinite(raw.issuedAt)
    ? raw.issuedAt
    : null;

  /* 想定外の文字列を写しに入れない。既知の2値以外は AAL1 とみなす。 */
  const aal = raw.aal === AAL.TWO ? AAL.TWO : AAL.ONE;

  return {
    v: SESSION_SCHEMA_VERSION,
    userId,
    displayName: toSafeString(raw.displayName, LIMITS.displayName),
    loginId: toSafeString(raw.loginId, LIMITS.loginId),
    provider: toSafeString(raw.provider, LIMITS.provider),
    aal,
    /* 既定は false。「確認済み」は明示的に true のときだけ。 */
    emailConfirmed: raw.emailConfirmed === true,
    issuedAt,
    expiresAt,
  };
}

/* 期限切れ判定。壊れた値も「期限切れ」として扱い、削除対象にする。 */
export function isSessionExpired(session, now = Date.now()) {
  if (!session || typeof session !== 'object') {
    return true;
  }

  const { expiresAt } = session;

  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return true;
  }

  return expiresAt <= now;
}

/*
 * 新しいセッションを組み立てる。
 * パスワードは引数に取らない（受け取ってはならない）。
 */
export function createSession({
  userId,
  displayName = null,
  loginId = null,
  provider = null,
  aal = AAL.ONE,
  emailConfirmed = false,
  ttlMs = SESSION_TTL_MS,
  now = Date.now(),
}) {
  const lifetime = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : SESSION_TTL_MS;

  return sanitizeSession({
    v: SESSION_SCHEMA_VERSION,
    userId,
    displayName,
    loginId,
    provider,
    aal,
    emailConfirmed,
    issuedAt: now,
    expiresAt: now + Math.min(lifetime, MAX_LIFETIME_MS),
  });
}

/* 表示に使う名前。displayName が無ければ loginId、それも無ければ既定文言。 */
export function resolveDisplayName(session) {
  if (session?.displayName) {
    return session.displayName;
  }

  if (session?.loginId) {
    return session.loginId;
  }

  return 'ゲスト';
}

/* 残りの有効時間（ミリ秒）。セッションが無ければ 0。 */
export function getRemainingMs(session = readSession(), now = Date.now()) {
  if (!session || isSessionExpired(session, now)) {
    return 0;
  }

  return session.expiresAt - now;
}

/* ---------- 通知 ---------- */

function notify(session) {
  if (typeof globalThis.document === 'undefined' || typeof CustomEvent !== 'function') {
    return;
  }

  globalThis.document.dispatchEvent(new CustomEvent(SESSION_EVENT, {
    detail: {
      authenticated: session !== null,
      session,
    },
  }));
}

/* ---------- 読み書き ---------- */

/*
 * 読み出す。
 * 形式違い・JSON破損・バージョン不一致・期限切れは、
 * その場で削除して null を返す。
 * 呼び出し側は「壊れたデータで画面が壊れる」ことを考えなくてよい。
 */
export function readSession() {
  const storage = getStorage();

  if (!storage) {
    return null;
  }

  let raw;

  try {
    raw = storage.getItem(SESSION_STORAGE_KEY);
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
    clearSession();
    return null;
  }

  const session = sanitizeSession(parsed);

  if (!session) {
    clearSession();
    return null;
  }

  if (isSessionExpired(session)) {
    clearSession();
    return null;
  }

  return session;
}

/*
 * 保存する。
 * 保存できなかった場合は false を返す（例外は外へ出さない）。
 * 呼び出し側は「この端末ではログイン状態を保持できない」と案内できる。
 */
export function writeSession(session) {
  const storage = getStorage();
  const valid = sanitizeSession(session);

  if (!storage || !valid || isSessionExpired(valid)) {
    return false;
  }

  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(valid));
  } catch {
    /* 容量超過・SecurityError など。 */
    return false;
  }

  notify(valid);
  return true;
}

/* 削除する。存在しない場合も成功扱い。 */
export function clearSession() {
  const storage = getStorage();

  if (!storage) {
    notify(null);
    return false;
  }

  try {
    storage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    return false;
  }

  notify(null);
  return true;
}

/*
 * 期限を延長する。
 * 有効なセッションが無ければ何もしない（延長では復活させない）。
 */
export function touchSession({ ttlMs = SESSION_TTL_MS, now = Date.now() } = {}) {
  const current = readSession();

  if (!current) {
    return null;
  }

  const lifetime = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : SESSION_TTL_MS;

  const extended = {
    ...current,
    expiresAt: now + Math.min(lifetime, MAX_LIFETIME_MS),
  };

  return writeSession(extended) ? extended : current;
}

/*
 * セッション変化を購読する。
 * 登録直後に現在値で1回呼ばれる（初期描画のため）。
 * 戻り値を呼ぶと解除できる。
 */
export function subscribeSession(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }

  const emit = (detail) => {
    try {
      listener(detail);
    } catch {
      /* 購読者の例外でセッションの保存経路を壊さない。 */
    }
  };

  const current = readSession();
  emit({ authenticated: current !== null, session: current });

  if (typeof globalThis.document === 'undefined') {
    return () => {};
  }

  const handler = (event) => {
    emit(event.detail ?? { authenticated: false, session: null });
  };

  globalThis.document.addEventListener(SESSION_EVENT, handler);

  return () => {
    globalThis.document.removeEventListener(SESSION_EVENT, handler);
  };
}
