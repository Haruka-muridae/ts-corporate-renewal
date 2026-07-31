/*
 * 交流会アプリの環境変数を1か所で読む。
 *
 * サーバー専用。ここで読む値のうち NEXT_PUBLIC_ が付かないものは、
 * クライアントコンポーネントから触れてはならない。
 *
 * 値が無いときは「起動時に落とす」のではなく、使う時点で例外にする。
 * ビルドやページ表示の全体を巻き添えにせず、原因の分かるメッセージを出すため。
 */

function required(name) {
  const value = process.env[name];

  if (!value) {
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
