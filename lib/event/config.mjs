/*
 * 交流会アプリの環境変数を1か所で読む。
 *
 * サーバー専用。ここで読む値のうち NEXT_PUBLIC_ が付かないものは、
 * クライアントコンポーネントから触れてはならない。
 *
 * 値が無いときは「起動時に落とす」のではなく、使う時点で例外にする。
 * ビルドやページ表示の全体を巻き添えにせず、原因の分かるメッセージを出すため。
 */

/*
 * 環境変数の値をそのまま使わず、必ずここを通す。
 *
 * 登録の経路によっては、値の先頭にBOM（U+FEFF）や前後の空白・改行が
 * 紛れ込むことがある。BOMが付いたままHTTPヘッダーに入れると
 * 「Cannot convert argument to a ByteString」で失敗し、原因が分かりにくい。
 * 値の意味を変えずに落とせるものなので、読み取り時に取り除く。
 */
function sanitize(value) {
  if (typeof value !== 'string') {
    return '';
  }

  /* 先頭に複数付いている場合もまとめて落とす。 */
  return value.replace(new RegExp('^\ufeff+'), '').trim();
}

function required(name) {
  const value = sanitize(process.env[name]);

  if (value === '') {
    /* 値そのものは出さない。名前だけで十分に原因が分かる。 */
    throw new Error(`環境変数 ${name} が設定されていません`);
  }

  return value;
}

/** Supabase への接続設定（service role）。 */
export function supabaseConfig() {
  return {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  };
}

/**
 * 管理画面のログインに使う Supabase Auth の設定。
 * 認証は anon キーで行う（service role キーはブラウザ経由の認証に使わない）。
 */
export function supabaseAuthConfig() {
  return {
    url: required('SUPABASE_URL'),
    anonKey: required('SUPABASE_ANON_KEY'),
  };
}

/** Stripe のシークレットキー。 */
export function stripeSecretKey() {
  return required('STRIPE_SECRET_KEY');
}

/**
 * 公開URLの土台。決済後の戻り先URLを組み立てるのに使う。
 * 末尾のスラッシュは落として揃える。
 */
export function baseUrl() {
  return required('NEXT_PUBLIC_BASE_URL').replace(/\/+$/, '');
}

/** 参加確定メールの送信設定。 */
export function gmailConfig() {
  return {
    credentials: {
      clientId: required('GOOGLE_CLIENT_ID'),
      clientSecret: required('GOOGLE_CLIENT_SECRET'),
      refreshToken: required('GMAIL_REFRESH_TOKEN'),
    },
    from: required('MAIL_FROM'),
  };
}
