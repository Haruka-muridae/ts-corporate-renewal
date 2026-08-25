/*
 * Google OAuth（要件書 §FR-02 / §8.1）。
 *
 * ==================================================================
 * トークンはメモリだけ
 * ==================================================================
 * アクセストークンを localStorage / sessionStorage / Cookie / ログへ
 * 書かないこと。このモジュールのクロージャ変数 accessToken だけに置き、
 * ページを離れれば消える。
 *
 * refresh token は受け取らない（暗黙フローのため発行されない）。
 * client secret も使わない。静的サイトに秘密は置けないためである。
 *
 * スコープは drive.file のみ。ドライブ全体を読むスコープを要求しない。
 * ==================================================================
 *
 * 2 つの取得方式を持つ。
 *
 *   ポップアップ方式（既定・PC）
 *     Google Identity Services のトークンクライアント。画面を離れない。
 *
 *   リダイレクト方式（standalone PWA、ポップアップが開けないとき）
 *     ホーム画面に追加した PWA ではポップアップが別アプリで開き、
 *     トークンがこの画面へ戻ってこない。そこで同じ画面を Google へ遷移させ、
 *     戻り URL の fragment（#access_token=…）からトークンを受け取る。
 *     fragment はサーバーへ送られない。受け取った直後に URL から消す。
 *     state（乱数）を sessionStorage に置いて往復を突き合わせ、
 *     他所から貼り付けられた fragment は受け付けない。
 *
 *   リダイレクト方式には Google Cloud Console の「承認済みのリダイレクト URI」に
 *   redirectUri()（例: https://tsam-ai.com/meeting-assistant/）の登録が必要。
 *   未登録なら Google 側でエラー画面になるだけで、トークンが漏れることはない。
 *
 * public/production-app/receipt-ocr/oauth.js からの複製に、上記のリダイレクト方式と
 * 失敗理由の細分化（ポップアップ阻止・オリジン未登録・利用者による中断）を足したもの。
 *
 * Google Identity Services のスクリプトは Google のドメインから読む。
 * 第三者CDNではなく、認可そのものの提供元であるため許容する。
 */

import { OAUTH, isOauthConfigured } from './config.js';
import { AppError, ErrorCode } from './errors.js';
import { redirectUri } from './platform.js';

export { redirectUri };

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/* リダイレクト往復の突き合わせ用。トークンは入れない。 */
export const REDIRECT_STATE_KEY = 'meeting-assistant-oauth-state';

/* 往復に時間がかかりすぎた state は捨てる（古い戻り URL の再利用を防ぐ）。 */
const REDIRECT_STATE_TTL_MS = 10 * 60 * 1000;

/* location.assign のあと pagehide が来ないまま待つ上限。 */
const REDIRECT_NAVIGATION_TIMEOUT_MS = 20 * 1000;

/* **この2つを外へ出さないこと。** 参照を返す getter も作らない。 */
let accessToken = null;
let expiresAt = 0;
/* このページで一度でも連携したか。期限切れと未連携で案内を分けるため（forgetToken では消さない）。 */
let everLinked = false;

let gisPromise = null;

function loadGis() {
  if (gisPromise) {
    return gisPromise;
  }

  gisPromise = new Promise((resolve, reject) => {
    if (globalThis.google?.accounts?.oauth2) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => {
      /* 次回の押下でやり直せるよう、失敗した Promise を残さない。 */
      gisPromise = null;
      reject(new AppError(ErrorCode.OAUTH_SCRIPT_FAILED, 'gis_load_failed'));
    });
    document.head.append(script);
  });

  return gisPromise;
}

/*
 * 起動時に先読みする。
 * ボタン押下から Google の読み込みを始めると、読み込み待ちの間に
 * 利用者操作の猶予（transient activation）が切れてポップアップが阻止される。
 * 失敗は無視する（押下時に改めて読み、そこで案内する）。
 */
export function preloadGis() {
  loadGis().catch(() => {});
}

export function hasValidToken() {
  return typeof accessToken === 'string' && accessToken !== '' && Date.now() < expiresAt;
}

/* 表示用。残り秒数だけを返し、トークン自体は返さない。 */
export function tokenRemainingSeconds() {
  if (!hasValidToken()) {
    return 0;
  }

  return Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
}

/*
 * 保存前チェックポイント（auth-checkpoint.js）へ渡す状態。トークンの値は含めない。
 */
export function tokenState() {
  return {
    valid: hasValidToken(),
    remainingSeconds: tokenRemainingSeconds(),
    everLinked,
  };
}

/* 明示的に捨てる。401 を受けたときと、再連携の前に呼ぶ。 */
export function forgetToken() {
  accessToken = null;
  expiresAt = 0;
}

function acceptToken(token, expiresIn) {
  accessToken = token;
  everLinked = true;

  /* 期限は少し手前で切る。境目で 401 を踏まないため。 */
  const lifetime = Number(expiresIn) || 3600;
  expiresAt = Date.now() + (lifetime - 60) * 1000;
}

/*
 * GIS の error_callback が返す type を、画面のエラーコードへ写す。
 *
 * ------------------------------------------------------------------
 * オリジン未登録は「見分けられない」
 * ------------------------------------------------------------------
 * 「承認済みの JavaScript 生成元」に現在のオリジンが無い場合、Google は
 * **ポップアップの中で** 400 エラーを表示する。トークンクライアントの
 * error_callback には専用の type が来ず、利用者がその画面を閉じた時点で
 * popup_closed（あるいは unknown）になる。
 *
 * つまり「利用者が自分でポップアップを閉じた」場合と区別がつかない。
 * そこで両方を1つのコードにまとめ、**文言の側で両方の可能性を案内する**
 * （errors.js の OAUTH_POPUP_CLOSED）。片方だけを断定して案内すると、
 * もう片方に当たった利用者が延々と同じ操作を繰り返すことになる。
 * ------------------------------------------------------------------
 */
function toErrorCode(type, userActivation = null) {
  if (type === 'popup_failed_to_open') {
    /*
     * 利用者の操作（クリック）の直後でなければ、ブラウザはポップアップを開かない。
     * それは「ブロックを解除して」ではなく「ボタンを押して連携を更新して」と案内すべき失敗。
     * userActivation が取れない環境（古いブラウザ）では従来どおりブロックとして扱う。
     */
    if (userActivation === false) {
      return ErrorCode.OAUTH_USER_ACTION_REQUIRED;
    }

    return ErrorCode.OAUTH_POPUP_BLOCKED;
  }

  /* popup_closed / unknown / それ以外。オリジン未登録もここへ落ちる。 */
  return ErrorCode.OAUTH_POPUP_CLOSED;
}

async function requestViaPopup(prompt) {
  await loadGis();

  /* 要求を出す時点で利用者操作の猶予があったか。失敗理由の切り分けに使う。 */
  const activation = globalThis.navigator?.userActivation;
  const userActivation = typeof activation?.isActive === 'boolean' ? activation.isActive : null;

  return new Promise((resolve, reject) => {
    const client = globalThis.google.accounts.oauth2.initTokenClient({
      client_id: OAUTH.clientId,
      scope: OAUTH.scope,
      prompt,
      callback: (response) => {
        if (!response?.access_token) {
          reject(new AppError(ErrorCode.OAUTH_POPUP_CLOSED, 'no_access_token'));
          return;
        }

        acceptToken(response.access_token, response.expires_in);
        resolve(true);
      },
      error_callback: (error) => {
        reject(new AppError(toErrorCode(error?.type, userActivation), `gis_${error?.type ?? 'unknown'}`));
      },
    });

    client.requestAccessToken();
  });
}

/* ---------- リダイレクト方式 ---------- */

function randomState() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function buildAuthorizationUrl({
  clientId = OAUTH.clientId,
  scope = OAUTH.scope,
  redirect,
  state,
  prompt = '',
} = {}) {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  /*
   * include_granted_scopes は付けない。
   * この clientId は兄弟アプリと共有しており、他アプリが将来広いスコープを
   * 求めたとき、そのスコープがこのアプリのトークンへ黙って乗るのを防ぐ。
   */

  if (prompt) {
    url.searchParams.set('prompt', prompt);
  }

  return url.href;
}

/*
 * 戻り URL の fragment を読む。
 * access_token も error も無ければ null（OAuth の戻りではない＝通常の #画面名）。
 */
export function parseRedirectFragment(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');

  if (raw === '' || !raw.includes('=')) {
    return null;
  }

  const params = new URLSearchParams(raw);
  const token = params.get('access_token');
  const error = params.get('error');

  if (!token && !error) {
    return null;
  }

  return {
    accessToken: token ?? '',
    expiresIn: Number(params.get('expires_in')) || 0,
    state: params.get('state') ?? '',
    error: error ?? '',
  };
}

function getSessionStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readRedirectState(storage) {
  try {
    const raw = storage?.getItem(REDIRECT_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/*
 * リダイレクト方式で認可を求める。この関数が戻ることは通常ない（画面が遷移する）。
 * resume には戻ってきたあとに再開したい画面・操作を入れる（トークンは入れない）。
 * 遷移が起きなかった場合だけ reject する。
 */
function requestViaRedirect({ prompt = '', resume = null } = {}) {
  const storage = getSessionStorage();

  if (!storage) {
    return Promise.reject(new AppError(ErrorCode.OAUTH_REDIRECT_FAILED, 'session_storage_unavailable'));
  }

  const state = randomState();

  try {
    storage.setItem(REDIRECT_STATE_KEY, JSON.stringify({
      state,
      createdAt: Date.now(),
      resume: resume ?? null,
    }));
  } catch {
    return Promise.reject(new AppError(ErrorCode.OAUTH_REDIRECT_FAILED, 'session_storage_write_failed'));
  }

  const url = buildAuthorizationUrl({ redirect: redirectUri(), state, prompt });

  return new Promise((_, reject) => {
    /*
     * 遷移が始まれば pagehide が来るので、タイマーを止める（低速回線で
     * 正常な遷移中に「失敗」と出さないため）。来ないまま時間が経ったら阻止と判断する。
     */
    const timer = globalThis.setTimeout(() => {
      reject(new AppError(ErrorCode.OAUTH_REDIRECT_FAILED, 'navigation_did_not_happen'));
    }, REDIRECT_NAVIGATION_TIMEOUT_MS);

    globalThis.addEventListener?.('pagehide', () => globalThis.clearTimeout(timer), { once: true });
    globalThis.location.assign(url);
  });
}

/*
 * 起動時に呼ぶ。Google からの戻りなら fragment を消化してトークンを受け取る。
 *
 * 戻り値:
 *   null                       … OAuth の戻りではない
 *   { ok: true,  resume }      … 連携成功。resume は往路で預けた再開情報
 *   { ok: false, code, resume }… 失敗（利用者の拒否・state 不一致・Google のエラー）
 *
 * 成否にかかわらず fragment は URL から消す（履歴にも残さない）。
 */
export function consumeRedirectResult({
  loc = globalThis.location,
  hist = globalThis.history,
  storage = getSessionStorage(),
  now = Date.now(),
} = {}) {
  const result = parseRedirectFragment(loc?.hash);

  if (!result) {
    return null;
  }

  const saved = readRedirectState(storage);

  try {
    storage?.removeItem(REDIRECT_STATE_KEY);
  } catch {
    /* noop */
  }

  try {
    hist?.replaceState(null, '', `${loc.pathname}${loc.search}`);
  } catch {
    /* noop */
  }

  const resume = saved?.resume ?? null;
  const age = saved ? now - Number(saved.createdAt) : NaN;
  const fresh = Number.isFinite(age) && age >= 0 && age <= REDIRECT_STATE_TTL_MS;

  if (!saved || !fresh || !result.state || result.state !== saved.state) {
    return { ok: false, code: ErrorCode.OAUTH_STATE_MISMATCH, resume: null };
  }

  if (result.error || !result.accessToken) {
    const code = result.error === 'access_denied'
      ? ErrorCode.OAUTH_POPUP_CLOSED
      : ErrorCode.OAUTH_REDIRECT_FAILED;
    return { ok: false, code, resume };
  }

  acceptToken(result.accessToken, result.expiresIn);
  return { ok: true, resume };
}

/* ---------- 入口 ---------- */

/*
 * 認可を求める。
 *
 * 利用者の操作（ボタン押下）から呼ぶこと。
 * ポップアップを開くため、読み込み直後に自動で呼ぶとブロックされる
 * （アプリを開いただけでは認可を要求しない、という §FR-02 の要件でもある）。
 *
 * options:
 *   prompt     … Google へ渡す prompt（'' / 'consent' / 'select_account'）
 *   redirect   … true ならリダイレクト方式を使う（standalone PWA 用）
 *   resume     … リダイレクト方式で戻ったあとの再開情報（画面名など）
 *   allowRedirectFallback … ポップアップを開けなかったときにリダイレクトへ切り替える
 */
export async function requestAccess({
  prompt = '',
  redirect = false,
  resume = null,
  allowRedirectFallback = false,
} = {}) {
  if (!isOauthConfigured()) {
    throw new AppError(ErrorCode.OAUTH_NOT_CONFIGURED, 'client_id_missing');
  }

  if (redirect) {
    return requestViaRedirect({ prompt, resume });
  }

  try {
    return await requestViaPopup(prompt);
  } catch (error) {
    if (allowRedirectFallback && error?.code === ErrorCode.OAUTH_POPUP_BLOCKED) {
      return requestViaRedirect({ prompt, resume });
    }

    throw error;
  }
}

/*
 * 通信のたびにトークンを取り出す口。
 *
 * 呼び出し側はこれを引数として渡すだけで、保持しない。
 * 期限切れなら OAUTH_EXPIRED を投げ、画面が再連携を案内する（§FR-02）。
 */
export function currentToken() {
  if (!hasValidToken()) {
    throw new AppError(ErrorCode.OAUTH_EXPIRED, 'expired');
  }

  return accessToken;
}
