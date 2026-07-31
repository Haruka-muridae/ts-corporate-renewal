/*
 * Supabase Auth プロバイダ。
 * TSAM AI の本番用の認証実装。
 *
 * ------------------------------------------------------------------
 * 扱う範囲
 * ------------------------------------------------------------------
 *   メール＋パスワードでのログイン
 *   TOTP二段階認証（登録 / 解除 / ログイン時の確認）
 *   ログアウト
 *   セッション復元（トークン自動更新はSDKが行う）
 *   パスワード再設定（メール送信 → 新パスワード設定）
 *   メール確認（招待・登録・メール変更の確認リンク）
 *
 * 会員登録（サインアップ）画面は用意していない。
 * 利用者は Supabase ダッシュボードからの招待で作成する想定
 * （誰でも登録できる状態にしないため）。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * このファイルの約束
 * ------------------------------------------------------------------
 * 1. 例外を投げず、必ず Result を返す（shared/auth.js の契約）。
 *    成功 { ok: true,  ... }
 *    失敗 { ok: false, code, message }
 *
 * 2. パスワード・トークン・SDKの生エラーを
 *    ログ・戻り値・画面へ出さない。出すのは種別コードだけ。
 *
 * 3. Supabase のエラーメッセージ（英語・内部情報を含む）を
 *    そのまま画面へ出さない。必ず日本語の定型文へ写像する。
 *    「どのアカウントが存在するか」を推測させないため、
 *    ログイン失敗はすべて同じ文言にまとめる。
 * ------------------------------------------------------------------
 */

import { getAuthClient, SupabaseUnavailableError } from '../supabase-client.js';
import { AUTH_CALLBACK_PATH } from '../supabase-config.js';
import { resolveAppUrl } from '../app-paths.js';

export const PROVIDER_ID = 'supabase';

/*
 * 入力規則。
 * パスワードの下限は Supabase 側の設定（既定6文字）と合わせること。
 * ここを厳しくしても Supabase 側が緩ければ、他経路で弱いパスワードを設定できる。
 * SUPABASE_SETUP.md の手順でダッシュボード側も8文字にしている。
 */
export const INPUT_RULES = Object.freeze({
  loginIdMaxLength: 254,
  passwordMinLength: 8,
  passwordMaxLength: 72,
});

/* この プロバイダが対応している機能。画面はこれを見て導線を出し分ける。 */
export const CAPABILITIES = Object.freeze({
  mfa: true,
  passwordReset: true,
  emailVerification: true,
  passwordChange: true,
});

/* ---------- エラー写像 ---------- */

/*
 * Supabase のエラーを TSAM AI のコードへ写像する。
 *
 * ------------------------------------------------------------------
 * ログイン失敗の文言を1つにまとめる理由
 * ------------------------------------------------------------------
 * 「このメールアドレスは登録されていません」と
 * 「パスワードが違います」を区別して返すと、
 * 攻撃者が「どのメールアドレスが登録済みか」を総当たりで調べられる。
 * これをアカウント列挙（user enumeration）という。
 *
 * したがって、どちらの場合も INVALID_CREDENTIALS を返す。
 * ------------------------------------------------------------------
 */
function mapError(error) {
  /* SDKが付ける機械可読なコード。無ければHTTPステータスで見る。 */
  const code = String(error?.code ?? '');
  const status = Number(error?.status ?? 0);

  if (code === 'invalid_credentials' || code === 'invalid_grant') {
    return { code: 'INVALID_CREDENTIALS' };
  }

  if (code === 'email_not_confirmed') {
    return { code: 'EMAIL_NOT_CONFIRMED' };
  }

  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || status === 429) {
    return { code: 'RATE_LIMITED' };
  }

  if (code === 'weak_password') {
    return { code: 'WEAK_PASSWORD' };
  }

  if (code === 'same_password') {
    return { code: 'SAME_PASSWORD' };
  }

  if (code === 'mfa_verification_failed' || code === 'mfa_challenge_expired') {
    return { code: 'MFA_INVALID_CODE' };
  }

  if (code === 'otp_expired' || code === 'flow_state_expired' || code === 'flow_state_not_found') {
    return { code: 'LINK_EXPIRED' };
  }

  if (code === 'user_not_found' || code === 'session_not_found') {
    return { code: 'SESSION_EXPIRED' };
  }

  if (code === 'validation_failed' || status === 422) {
    return { code: 'INVALID_INPUT' };
  }

  /* 通信できていない（オフライン・DNS・遮断）。 */
  if (error?.name === 'AuthRetryableFetchError' || status === 0) {
    return { code: 'NETWORK' };
  }

  if (status === 401 || status === 403) {
    return { code: 'INVALID_CREDENTIALS' };
  }

  return { code: 'UNKNOWN' };
}

/* Result の失敗形を作る。SDKのメッセージは載せない。 */
function fail(error) {
  if (error instanceof SupabaseUnavailableError) {
    return { ok: false, code: 'NOT_CONFIGURED', message: error.reason };
  }

  return { ok: false, code: mapError(error).code, message: null };
}

/*
 * クライアント取得と実行をまとめる。
 * 想定外の例外もここで Result へ落とし、呼び出し側へ投げない。
 */
async function run(fn) {
  let client;

  try {
    client = await getAuthClient();
  } catch (error) {
    return fail(error);
  }

  try {
    return await fn(client);
  } catch (error) {
    /* 例外の内容には入力値が混ざりうるため、種別名だけを見る。 */
    console.warn('[tsam-auth] Supabase 呼び出しで例外:', error?.name ?? 'Error');
    return fail(error);
  }
}

/* ---------- 利用者情報の取り出し ---------- */

/*
 * Supabase の user から、画面表示に必要な最小限だけを取り出す。
 * user_metadata は利用者が自由に書き換えられる領域なので、
 * 表示名以外は取り込まない（権限判定に使わない）。
 */
function toUser(user, aal) {
  if (!user) {
    return null;
  }

  const metadata = user.user_metadata ?? {};
  const email = typeof user.email === 'string' ? user.email : null;

  const displayName = pickString(metadata.display_name)
    ?? pickString(metadata.full_name)
    ?? pickString(metadata.name)
    ?? (email ? email.split('@')[0] : null);

  return {
    userId: String(user.id ?? ''),
    displayName,
    loginId: email,
    aal: aal ?? null,
    /* 未確認のまま使わせない判断に使う。既定は false。 */
    emailConfirmed: Boolean(user.email_confirmed_at || user.confirmed_at),
  };
}

function pickString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, 64);
}

/*
 * 二段階認証の到達段階を調べる。
 *
 * 戻り値: { current, next, mfaRequired }
 *   mfaRequired が true のとき、パスワードは通ったが
 *   TOTPコードの入力がまだ済んでいない。
 */
async function readAal(client) {
  try {
    const { data, error } = await client.mfa.getAuthenticatorAssuranceLevel();

    if (error || !data) {
      return { current: null, next: null, mfaRequired: false };
    }

    return {
      current: data.currentLevel ?? null,
      next: data.nextLevel ?? null,
      /* 「今は aal1 だが aal2 まで上げられる」＝二段階認証が登録済み。 */
      mfaRequired: data.currentLevel === 'aal1' && data.nextLevel === 'aal2',
    };
  } catch {
    return { current: null, next: null, mfaRequired: false };
  }
}

/* 未確認のTOTP要素を除いた、有効な要素だけを返す。 */
async function readVerifiedFactors(client) {
  const { data, error } = await client.mfa.listFactors();

  if (error) {
    return [];
  }

  const list = Array.isArray(data?.totp) ? data.totp : [];

  return list
    .filter((factor) => factor?.status === 'verified')
    .map((factor) => ({
      id: String(factor.id),
      friendlyName: pickString(factor.friendly_name) ?? 'TOTP',
      createdAt: factor.created_at ?? null,
    }));
}

/* ---------- ログイン ---------- */

/*
 * メール＋パスワードでログインする。
 *
 * 戻り値:
 *   { ok: true, status: 'signed-in',    user }
 *   { ok: true, status: 'mfa-required', user, factors }
 *   { ok: false, code, message }
 *
 * mfa-required の時点では、まだ本人確認は完了していない。
 * verifyMfa() が成功するまで保護対象の操作をさせないこと。
 */
export async function signIn({ loginId, password } = {}) {
  const email = typeof loginId === 'string' ? loginId.trim() : '';

  if (email === '' || !email.includes('@')) {
    return { ok: false, code: 'INVALID_INPUT', message: 'メールアドレスを入力してください。' };
  }

  if (typeof password !== 'string' || password === '') {
    return { ok: false, code: 'INVALID_INPUT', message: 'パスワードを入力してください。' };
  }

  return run(async (client) => {
    const { data, error } = await client.signInWithPassword({ email, password });

    if (error) {
      return fail(error);
    }

    const aal = await readAal(client);

    if (aal.mfaRequired) {
      const factors = await readVerifiedFactors(client);

      /*
       * 要素が登録済みなのに一覧が空＝一覧取得に失敗している。
       * このまま通すと二段階認証を素通りさせることになるため、
       * セッションを破棄して失敗にする。
       */
      if (factors.length === 0) {
        await client.signOut().catch(() => {});
        return { ok: false, code: 'UNKNOWN', message: null };
      }

      return {
        ok: true,
        status: 'mfa-required',
        user: toUser(data?.user, aal.current),
        factors,
      };
    }

    return {
      ok: true,
      status: 'signed-in',
      user: toUser(data?.user, aal.current),
    };
  });
}

/*
 * 二段階認証のコードを検証してログインを完了する。
 * challenge の作成と検証をまとめて行う。
 */
export async function verifyMfa({ factorId, code } = {}) {
  const digits = typeof code === 'string' ? code.replace(/\s+/g, '') : '';

  if (!/^\d{6}$/.test(digits)) {
    return { ok: false, code: 'MFA_INVALID_CODE', message: '6桁の数字を入力してください。' };
  }

  if (typeof factorId !== 'string' || factorId === '') {
    return { ok: false, code: 'INVALID_INPUT', message: null };
  }

  return run(async (client) => {
    const { error } = await client.mfa.challengeAndVerify({ factorId, code: digits });

    if (error) {
      return fail(error);
    }

    const { data: userData } = await client.getUser();
    const aal = await readAal(client);

    return {
      ok: true,
      status: 'signed-in',
      user: toUser(userData?.user, aal.current),
    };
  });
}

/* ---------- ログアウト / 復元 ---------- */

export async function signOut() {
  await run(async (client) => {
    /*
     * 'local' はこの端末のトークンだけを破棄する。
     * 他の端末のログインまで切らない（利用者の想定外を避ける）。
     */
    await client.signOut({ scope: 'local' });
    return { ok: true };
  });
}

/*
 * この端末以外のセッションを失効させる。
 *
 * パスワード変更の直後に呼ぶ。
 * 変更の目的が「他人に使われているかもしれないから」である場合、
 * 他端末のログインが生き残っていては意味がない。
 *
 * 失敗しても致命的ではないため、結果は返すが呼び出し側は続行してよい。
 */
export async function revokeOtherSessions() {
  return run(async (client) => {
    const { error } = await client.signOut({ scope: 'others' });

    if (error) {
      return fail(error);
    }

    return { ok: true };
  });
}

/*
 * 保存済みトークンからセッションを復元する。
 * 期限切れのアクセストークンは SDK が refresh token で更新する。
 *
 * 戻り値:
 *   { ok: true,  user }   … 復元できた
 *   { ok: false, code }   … 未ログイン、または復元できない
 */
export async function refresh() {
  return run(async (client) => {
    const { data, error } = await client.getSession();

    if (error) {
      return fail(error);
    }

    if (!data?.session) {
      return { ok: false, code: 'SESSION_EXPIRED', message: null };
    }

    const aal = await readAal(client);

    /*
     * 二段階認証が登録済みなのに aal1 のまま復元された場合は、
     * コード入力を終えていないセッションである。ログイン扱いにしない。
     */
    if (aal.mfaRequired) {
      return { ok: false, code: 'MFA_REQUIRED', message: null };
    }

    return {
      ok: true,
      status: 'signed-in',
      user: toUser(data.session.user, aal.current),
    };
  });
}

/*
 * ログイン状態の変化を購読する（別タブでのログアウト、トークン更新など）。
 * 戻り値: 解除する関数
 */
export async function subscribe(listener) {
  let client;

  try {
    client = await getAuthClient();
  } catch {
    return () => {};
  }

  const { data } = client.onAuthStateChange(async (event, session) => {
    if (!session) {
      listener({ event, user: null });
      return;
    }

    const aal = await readAal(client);
    listener({ event, user: toUser(session.user, aal.current) });
  });

  return () => {
    try {
      data?.subscription?.unsubscribe();
    } catch {
      /* 解除に失敗しても画面は壊さない。 */
    }
  };
}

/* ---------- パスワード再設定 ---------- */

/*
 * 再設定メールを送る。
 *
 * ------------------------------------------------------------------
 * 未登録のメールアドレスでも成功として返す。
 * 「送信しました／そのアドレスは存在しません」を区別すると、
 * 登録済みアドレスの総当たり調査を許すことになるため。
 * Supabase 側も既定でそのように振る舞う。
 * ------------------------------------------------------------------
 */
export async function requestPasswordReset({ loginId, redirectTo } = {}) {
  const email = typeof loginId === 'string' ? loginId.trim() : '';

  if (email === '' || !email.includes('@')) {
    return { ok: false, code: 'INVALID_INPUT', message: 'メールアドレスを入力してください。' };
  }

  return run(async (client) => {
    const { error } = await client.resetPasswordForEmail(email, {
      redirectTo: redirectTo ?? buildCallbackUrl('recovery'),
    });

    /* 送信頻度の制限だけは伝える（総当たり調査には使えない情報のため）。 */
    if (error && mapError(error).code === 'RATE_LIMITED') {
      return fail(error);
    }

    return { ok: true };
  });
}

/*
 * 新しいパスワードを設定する。
 * 再設定リンクから復元したセッション、またはログイン中に呼ぶ。
 */
export async function updatePassword({ password } = {}) {
  if (typeof password !== 'string' || password.length < INPUT_RULES.passwordMinLength) {
    return {
      ok: false,
      code: 'WEAK_PASSWORD',
      message: `パスワードは${INPUT_RULES.passwordMinLength}文字以上で入力してください。`,
    };
  }

  if (password.length > INPUT_RULES.passwordMaxLength) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `パスワードは${INPUT_RULES.passwordMaxLength}文字以内で入力してください。`,
    };
  }

  return run(async (client) => {
    const { data, error } = await client.updateUser({ password });

    if (error) {
      return fail(error);
    }

    const aal = await readAal(client);
    return { ok: true, user: toUser(data?.user, aal.current) };
  });
}

/* ---------- メール確認 ---------- */

/* 確認メールを再送する。 */
export async function resendConfirmation({ loginId } = {}) {
  const email = typeof loginId === 'string' ? loginId.trim() : '';

  if (email === '' || !email.includes('@')) {
    return { ok: false, code: 'INVALID_INPUT', message: 'メールアドレスを入力してください。' };
  }

  return run(async (client) => {
    const { error } = await client.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: buildCallbackUrl('signup') },
    });

    if (error && mapError(error).code === 'RATE_LIMITED') {
      return fail(error);
    }

    return { ok: true };
  });
}

/*
 * メール内リンクから戻ってきたときの処理。
 *
 * PKCE フローでは URL に ?code=... が付く。
 * これを1回だけ交換してセッションにする（再利用はできない）。
 *
 * 戻り値: { ok, type, user }
 *   type … 'recovery'（パスワード再設定）/ 'invite'（招待）/
 *          'signup'（登録確認）/ 'email_change' / null
 */
export async function exchangeCallback({ code, type = null } = {}) {
  if (typeof code !== 'string' || code === '') {
    return { ok: false, code: 'LINK_EXPIRED', message: null };
  }

  return run(async (client) => {
    const { data, error } = await client.exchangeCodeForSession(code);

    if (error) {
      return fail(error);
    }

    const aal = await readAal(client);

    return {
      ok: true,
      type,
      user: toUser(data?.user ?? data?.session?.user, aal.current),
    };
  });
}

/* ---------- 二段階認証（TOTP）の管理 ---------- */

/* 登録済みの要素を一覧する。 */
export async function listMfaFactors() {
  return run(async (client) => {
    const factors = await readVerifiedFactors(client);
    return { ok: true, factors };
  });
}

/*
 * TOTP の登録を開始する。
 *
 * 戻り値: { ok, factorId, qrCode, secret, uri }
 *   qrCode … SVG の data URI。**そのまま img の src に入れてよい**
 *            （innerHTML では描画しないこと）
 *   secret … QRを読めない場合に手入力する文字列
 *
 * この時点ではまだ有効になっていない。
 * confirmMfaEnrollment() でコードを検証して初めて有効になる。
 */
export async function startMfaEnrollment({ friendlyName = null } = {}) {
  return run(async (client) => {
    /*
     * 未確認のまま放置された要素が溜まると、次回の登録が
     * 「同名の要素が既にある」で失敗する。先に掃除する。
     */
    await cleanupUnverifiedFactors(client);

    const { data, error } = await client.mfa.enroll({
      factorType: 'totp',
      friendlyName: friendlyName ?? `TSAM AI (${new Date().toISOString().slice(0, 10)})`,
    });

    if (error) {
      return fail(error);
    }

    return {
      ok: true,
      factorId: String(data?.id ?? ''),
      /*
       * img の src へ入れる値なので、SVGの data URI であることを確認する。
       * 応答が想定と違う形になっても、そのまま属性へ流し込まない。
       */
      qrCode: toSafeQrDataUri(data?.totp?.qr_code),
      secret: toSafeSecret(data?.totp?.secret),
      uri: typeof data?.totp?.uri === 'string' ? data.totp.uri : null,
    };
  });
}

/*
 * QRコードの data URI を検証する。
 *
 * img の src は javascript: を実行しないが、
 * 想定外のスキーム（外部URLなど）を通すと、
 * この画面から第三者へ通信が飛ぶ（利用者の存在が漏れる）。
 * SVGの data URI 以外は受け付けない。
 */
function toSafeQrDataUri(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const raw = value.trim();

  if (!/^data:image\/svg\+xml[,;]/i.test(raw) || raw.length > 200000) {
    return null;
  }

  return raw;
}

/* TOTPの共有鍵。Base32 の範囲だけを受け付ける。 */
function toSafeSecret(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const raw = value.trim().toUpperCase();

  return /^[A-Z2-7=]{16,128}$/.test(raw) ? raw : null;
}

/* 登録を確定する。認証アプリに表示された6桁を渡す。 */
export async function confirmMfaEnrollment({ factorId, code } = {}) {
  const digits = typeof code === 'string' ? code.replace(/\s+/g, '') : '';

  if (!/^\d{6}$/.test(digits)) {
    return { ok: false, code: 'MFA_INVALID_CODE', message: '6桁の数字を入力してください。' };
  }

  return run(async (client) => {
    const { error } = await client.mfa.challengeAndVerify({ factorId, code: digits });

    if (error) {
      return fail(error);
    }

    return { ok: true };
  });
}

/*
 * 二段階認証を解除する。
 *
 * 解除は保護を弱める操作なので、AAL2（コード入力済み）でのみ許す。
 * そうしないと、パスワードだけを知っている人が二段階認証を外せてしまう。
 */
export async function disableMfa({ factorId } = {}) {
  if (typeof factorId !== 'string' || factorId === '') {
    return { ok: false, code: 'INVALID_INPUT', message: null };
  }

  return run(async (client) => {
    const aal = await readAal(client);

    if (aal.current !== 'aal2') {
      return {
        ok: false,
        code: 'MFA_REQUIRED',
        message: '解除するには、二段階認証のコードを入力した状態で操作してください。一度ログインし直してからお試しください。',
      };
    }

    const { error } = await client.mfa.unenroll({ factorId });

    if (error) {
      return fail(error);
    }

    return { ok: true };
  });
}

/* 未確認のまま残った要素を消す。失敗しても続行する。 */
async function cleanupUnverifiedFactors(client) {
  try {
    const { data } = await client.mfa.listFactors();
    const all = Array.isArray(data?.all) ? data.all : [];

    const pending = all.filter((factor) => factor?.status === 'unverified');

    for (const factor of pending) {
      /* 逐次実行。件数は多くても数件で、並列にする利点が無い。 */
      /* eslint-disable-next-line no-await-in-loop */
      await client.mfa.unenroll({ factorId: factor.id }).catch(() => {});
    }
  } catch {
    /* 掃除に失敗しても登録自体は試す。 */
  }
}

/* ---------- URL ---------- */

/*
 * メールリンクの戻り先URLを組み立てる。
 *
 * このURLは Supabase ダッシュボードの Redirect URLs にも
 * 登録されていなければならない（未登録だと Site URL へ飛ばされる）。
 *
 * ------------------------------------------------------------------
 * flow を付ける理由
 * ------------------------------------------------------------------
 * PKCE フローで戻ってくるURLには `?code=` しか付かず、
 * 「パスワード再設定なのか、メール確認なのか」が判別できない。
 * 送信時にこちらで種別を埋め込んでおき、戻り先の画面で読む。
 *
 * この値は利用者が書き換えられる（URLを手で直せる）。
 * 行き先の出し分けにだけ使い、権限の判定には使わないこと。
 * ------------------------------------------------------------------
 */
export function buildCallbackUrl(flow = null) {
  /*
   * ベースパスの解決は shared/app-paths.js に集約している。
   * 独自ドメインでもプロジェクトPages（/リポジトリ名/apps/）でも
   * 正しい絶対URLになる。
   */
  const base = resolveAppUrl(AUTH_CALLBACK_PATH);

  if (!base) {
    return null;
  }

  const target = new URL(base);

  if (typeof flow === 'string' && flow !== '') {
    target.searchParams.set('flow', flow);
  }

  return target.href;
}
