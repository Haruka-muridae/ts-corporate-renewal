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

/**
 * 開催日の取得元になる Googleカレンダーの設定。
 *
 * OAuth クライアント（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）はメール送信と
 * 共用する。同じ Google Cloud プロジェクトの同じクライアントで発行するため。
 * リフレッシュトークンだけは別に持つ。メール送信は gmail.send、カレンダーは
 * calendar.readonly と必要なスコープが違い、1つのトークンにまとめると
 * 片方の用途に過剰な権限を与えることになるため。
 */
export function calendarConfig() {
  return {
    calendarId: required('GOOGLE_CALENDAR_ID'),
    credentials: {
      clientId: required('GOOGLE_CLIENT_ID'),
      clientSecret: required('GOOGLE_CLIENT_SECRET'),
      refreshToken: required('GOOGLE_CALENDAR_REFRESH_TOKEN'),
    },
  };
}

/**
 * 支払人数をカレンダーの説明欄へ書き戻すための設定。
 *
 * 読み取り用（calendarConfig）とリフレッシュトークンだけを分けている。
 * 同期の読み取りは calendar.readonly のままにして、書き込み権限を
 * 持たせないため（トークンが漏れたときに書き換えられる範囲を分ける）。
 * 発行手順は要件定義書 §9-1（scripts/get-calendar-refresh-token.mjs --write）。
 *
 * 未設定のときの扱いは calendarWriteConfigOrNull を使う。ここを
 * 「未設定を許す」形にしないのは、名前付きの例外を出す config.mjs の
 * 方針（どの変数が無いのかを1か所で分かるようにする）を崩さないため。
 */
export function calendarWriteConfig() {
  return {
    calendarId: required('GOOGLE_CALENDAR_ID'),
    credentials: {
      clientId: required('GOOGLE_CLIENT_ID'),
      clientSecret: required('GOOGLE_CLIENT_SECRET'),
      refreshToken: required('GOOGLE_CALENDAR_WRITE_REFRESH_TOKEN'),
    },
  };
}

/**
 * 書き戻し用の設定。未設定なら例外にせず null を返す。
 *
 * 書き戻しは主催者向けの補助表示であって、決済にも申込にも要らない。
 * 未設定の環境（開発中・トークン発行前）で決済やメールまで止めないよう、
 * 「無ければ機能ごと見送る」判断をここに1か所だけ置く。
 * 呼び出し側（Webhookのルート・管理画面のアクション）が個別に
 * try/catch を書くと、判断が散らばって片方だけ挙動が変わる。
 */
export function calendarWriteConfigOrNull() {
  try {
    return calendarWriteConfig();
  } catch {
    /* どの変数が足りないかは、設定した上で使えば例外として出る。 */
    return null;
  }
}
