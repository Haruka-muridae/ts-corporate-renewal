/*
 * 偽の GoTrueClient。
 *
 * ------------------------------------------------------------------
 * これで確認できること / できないこと
 * ------------------------------------------------------------------
 * できる:
 *   こちらのコードが、応答の各パターンをどう扱うか
 *   （MFA未完了・失効・オフライン・不正コード など）
 *
 * できない:
 *   Supabase が実際に返す値との一致
 *   エラーコードの綴り、TOTPのQR形式、共有鍵の文字種、
 *   メールリンクの挙動、レート制限の実挙動
 *
 * つまり **「モックが通った＝安全」ではない**。
 * 実接続で確認すべき項目は apps/SUPABASE_CONNECTION_TEST.md にまとめてある。
 * ------------------------------------------------------------------
 */

const DEFAULT_EMAIL = 'taro@example.com';
const DEFAULT_PASSWORD = 'correct-password';

/*
 * options:
 *   factors        … [{ id, status, friendly_name }]
 *   aal            … 'aal1' | 'aal2'
 *   emailConfirmed … メール確認済みかどうか
 *   session        … 初期セッション
 */
export function createFakeGoTrue(options = {}) {
  const state = {
    session: options.session ?? null,
    factors: options.factors ?? [],
    aalCurrent: options.aal ?? 'aal1',
    emailConfirmed: options.emailConfirmed ?? true,
    /* 次の1回だけ返すエラー。テストから差し込む。 */
    nextError: null,
    /* listFactors を失敗させる。 */
    listFactorsFails: false,
    /* 呼び出し履歴。scope 付きで記録する。 */
    calls: [],
    passwords: options.passwords ?? { [DEFAULT_EMAIL]: DEFAULT_PASSWORD },
  };

  const ok = (data) => ({ data, error: null });
  const err = (code, status = 400) => ({
    data: null,
    error: { code, status, name: 'AuthApiError' },
  });

  const takeError = () => {
    if (!state.nextError) {
      return null;
    }
    const e = state.nextError;
    state.nextError = null;
    return err(e.code, e.status);
  };

  const verified = () => state.factors.filter((f) => f.status === 'verified');

  const buildUser = (email = DEFAULT_EMAIL) => ({
    id: 'user-1',
    email,
    email_confirmed_at: state.emailConfirmed ? '2026-01-01T00:00:00Z' : null,
    user_metadata: { display_name: '太郎' },
  });

  return {
    _state: state,

    async signInWithPassword({ email, password }) {
      state.calls.push('signInWithPassword');
      const failure = takeError();
      if (failure) return failure;

      if (state.passwords[email] !== password) {
        return err('invalid_credentials', 400);
      }

      state.session = { user: buildUser(email) };
      state.aalCurrent = 'aal1';
      return ok({ user: state.session.user, session: state.session });
    },

    async signOut(opts) {
      state.calls.push(`signOut:${opts?.scope ?? 'local'}`);
      /* scope:'others' は自分のセッションを消さない。 */
      if (opts?.scope !== 'others') {
        state.session = null;
        state.aalCurrent = 'aal1';
      }
      return { error: null };
    },

    async getSession() {
      const failure = takeError();
      if (failure) return failure;
      return ok({ session: state.session });
    },

    async getUser() {
      return ok({ user: state.session?.user ?? null });
    },

    async resetPasswordForEmail(email) {
      state.calls.push(`resetPasswordForEmail:${email}`);
      const failure = takeError();
      if (failure) return failure;
      return ok({});
    },

    async updateUser({ password }) {
      state.calls.push('updateUser');
      const failure = takeError();
      if (failure) return failure;
      if (!state.session) return err('session_not_found', 401);
      state.passwords[state.session.user.email] = password;
      return ok({ user: state.session.user });
    },

    async resend({ email }) {
      state.calls.push(`resend:${email}`);
      const failure = takeError();
      if (failure) return failure;
      return ok({});
    },

    async exchangeCodeForSession(code) {
      state.calls.push('exchangeCodeForSession');
      if (code !== 'good-code') {
        return err('flow_state_not_found', 404);
      }
      state.session = { user: buildUser() };
      return ok({ user: state.session.user, session: state.session });
    },

    onAuthStateChange() {
      return {
        data: {
          subscription: {
            unsubscribe() { state.calls.push('unsubscribe'); },
          },
        },
      };
    },

    mfa: {
      async getAuthenticatorAssuranceLevel() {
        return ok({
          currentLevel: state.aalCurrent,
          nextLevel: verified().length > 0 ? 'aal2' : 'aal1',
        });
      },

      async listFactors() {
        if (state.listFactorsFails) {
          return err('unknown', 500);
        }
        const failure = takeError();
        if (failure) return failure;
        return ok({ all: state.factors, totp: state.factors });
      },

      async challengeAndVerify({ code }) {
        state.calls.push('challengeAndVerify');
        if (code !== '123456') {
          return err('mfa_verification_failed', 400);
        }
        state.aalCurrent = 'aal2';
        state.factors.forEach((f) => { f.status = 'verified'; });
        return ok({ access_token: 'x' });
      },

      async enroll({ friendlyName } = {}) {
        state.calls.push('enroll');
        const factor = { id: 'factor-new', status: 'unverified', friendly_name: friendlyName };
        state.factors.push(factor);

        return ok({
          id: factor.id,
          totp: {
            qr_code: 'data:image/svg+xml;utf-8,<svg/>',
            /*
             * 実際の共有鍵は Base32（A-Z と 2-7）。
             * 実装がこれを検証するため、テストでも正しい文字種を使う。
             */
            secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
            uri: 'otpauth://totp/x',
          },
        });
      },

      async unenroll({ factorId }) {
        state.calls.push(`unenroll:${factorId}`);
        state.factors = state.factors.filter((f) => f.id !== factorId);
        return ok({});
      },
    },
  };
}

export const FAKE_EMAIL = DEFAULT_EMAIL;
export const FAKE_PASSWORD = DEFAULT_PASSWORD;
