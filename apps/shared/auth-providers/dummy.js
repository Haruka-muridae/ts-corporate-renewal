/*
 * 動作確認用のダミー認証プロバイダ。**本物の認証ではない**
 *
 * ------------------------------------------------------------------
 * 何をしているか（誤解を避けるため明記する）
 * ------------------------------------------------------------------
 * このプロバイダは **パスワードを検証していない**。
 * 入力形式（空でない・長すぎない）だけを確認し、形式さえ整っていれば
 * 誰でもログインできる。照合先が存在しないためである。
 *
 * したがって次が成り立つ。
 *   - 誰でも任意のIDでログインできる
 *   - ログイン状態は開発者ツールから自由に作れる
 *   - これは画面遷移とセッション管理の土台を確認するための仮実装である
 *
 * **絶対にやってはいけないこと**
 *   - このファイルへ実在のIDやパスワードを書くこと
 *     （静的サイトのJSは全員が読める。ハードコードは公開と同じ）
 *   - この状態のまま、他人に見せたくないデータを扱う画面を作ること
 *   - パスワードを保存・送信・ログ出力すること
 *
 * 本物の認証は Firebase Auth / Supabase Auth / 自前API などの
 * 別プロバイダへ差し替えて実現する（shared/auth.js の setAuthProvider）。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * プロバイダのインターフェース（shared/auth.js と共通）
 * ------------------------------------------------------------------
 * PROVIDER_ID … 識別子
 * signIn({ loginId, password }) … Promise<Result>
 * signOut(session)              … Promise<void>
 * refresh(session)              … Promise<Result>
 *
 * Result:
 *   成功 { ok: true,  user: { userId, displayName, loginId } }
 *   失敗 { ok: false, code, message }
 *
 * code は shared/auth.js の AuthErrorCode と同じ文字列集合を使う。
 * ここから auth.js を import しないのは、循環参照を作らないため
 * （providers 側は「文字列で答える」だけにしてある）。
 * ------------------------------------------------------------------
 */

export const PROVIDER_ID = 'dummy';

/* 入力の上限・下限。実プロバイダ導入時は、その方針に合わせて置き換える。 */
export const INPUT_RULES = Object.freeze({
  loginIdMaxLength: 128,
  passwordMinLength: 8,
  passwordMaxLength: 256,
});

/*
 * このプロバイダが対応している機能。画面はこれを見て導線を出し分ける。
 * ダミーには送信先も保存先も無いため、すべて false。
 */
export const CAPABILITIES = Object.freeze({
  mfa: false,
  passwordReset: false,
  emailVerification: false,
  passwordChange: false,
});

let warned = false;

/*
 * ダミー実装であることを開発者へ1回だけ知らせる。
 * 利用者向けの文言は画面側に出す（このログは開発者向け）。
 */
function warnOnce() {
  if (warned) {
    return;
  }

  warned = true;

  try {
    console.warn(
      '[tsam-auth] ダミー認証プロバイダが有効です。パスワードは検証されていません。'
      + ' 本番運用の前に shared/auth.js の setAuthProvider() で実プロバイダへ差し替えてください。',
    );
  } catch {
    /* console が使えない環境。無視する。 */
  }
}

/* 制御文字を除去して前後の空白を落とす。 */
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
 * ログインIDから表示名を作る。
 * メールアドレス形式ならローカル部を、そうでなければIDをそのまま使う。
 */
function toDisplayName(loginId) {
  const at = loginId.indexOf('@');
  const name = at > 0 ? loginId.slice(0, at) : loginId;
  return name.slice(0, 64);
}

/*
 * 利用者IDを決める。
 *
 * 実プロバイダではサーバーが払い出した不変のIDを使う。
 * ここでは接頭辞付きのログインIDをそのまま用いる。
 * 「本物のIDではない」ことが一目で分かるようにするため、
 * ハッシュ化などで実IDらしく見せることは意図的に避けている。
 */
function toUserId(loginId) {
  return `${PROVIDER_ID}:${loginId}`.slice(0, 128);
}

/*
 * ログイン。
 *
 * **パスワードは検証していない**（照合先が無い）。
 * 受け取ったパスワードは、この関数の外へ出さず、保存もログ出力もしない。
 */
export async function signIn({ loginId, password } = {}) {
  warnOnce();

  const id = toSafeString(loginId);

  if (id === '') {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'ログインIDを入力してください。',
    };
  }

  if (id.length > INPUT_RULES.loginIdMaxLength) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `ログインIDは${INPUT_RULES.loginIdMaxLength}文字以内で入力してください。`,
    };
  }

  /*
   * パスワードは長さだけを見る。中身は照合しない。
   * ここで pass 変数を作るのは長さ判定のためだけで、どこへも渡さない。
   */
  const pass = typeof password === 'string' ? password : '';

  if (pass === '') {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'パスワードを入力してください。',
    };
  }

  if (pass.length < INPUT_RULES.passwordMinLength) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `パスワードは${INPUT_RULES.passwordMinLength}文字以上で入力してください。`,
    };
  }

  if (pass.length > INPUT_RULES.passwordMaxLength) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'パスワードが長すぎます。入力内容を確認してください。',
    };
  }

  return {
    ok: true,
    /* 二段階認証を持たないため、常に完了状態で返す。 */
    status: 'signed-in',
    user: {
      userId: toUserId(id),
      displayName: toDisplayName(id),
      loginId: id,
      aal: 'aal1',
      /* 確認する手段が無いため、確認済みとは名乗らない。 */
      emailConfirmed: false,
    },
  };
}

/*
 * ログアウト。
 * 手元のセッション破棄は shared/auth.js が行うため、ここでは何もしない。
 * 実プロバイダでは、ここでサーバー側のセッション失効を要求する。
 */
export async function signOut() {
  /* 破棄すべきサーバー側の状態が無い。 */
}

/*
 * セッションの更新。
 *
 * 実プロバイダでは、ここで refresh token を使って再発行する。
 * ダミーでは、既存セッションの利用者情報をそのまま返して期限だけ延ばす。
 */
export async function refresh(session) {
  const userId = toSafeString(session?.userId);

  if (userId === '') {
    return {
      ok: false,
      code: 'SESSION_EXPIRED',
      message: 'ログインの有効期限が切れました。もう一度ログインしてください。',
    };
  }

  return {
    ok: true,
    status: 'signed-in',
    user: {
      userId,
      displayName: toSafeString(session?.displayName) || null,
      loginId: toSafeString(session?.loginId) || null,
      aal: 'aal1',
      emailConfirmed: false,
    },
  };
}
