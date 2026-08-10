/*
 * 名刺メール配信API（card-mail）の環境変数を1か所で読む。
 *
 * サーバー専用。ここで読む値をクライアントコンポーネントから触れてはならない。
 *
 * ==================================================================
 * lib/event/config.mjs と同じ流儀にしてある理由
 * ==================================================================
 * 「値が無ければ使う時点で名前付きの例外にする」「BOM・前後空白を落とす」は
 * 交流会アプリで実際に効いた運用なので、そのまま踏襲する。
 * ただし **import はしない**（複製）。系をまたいで共有すると、
 * 片方の都合の変更がもう片方を壊すため（CLAUDE.md「共存している3つの系」）。
 *
 * ==================================================================
 * Gmail の資格情報を交流会アプリと同じ環境変数名で読む理由
 * ==================================================================
 * 送信元は同じアカウント（MAIL_FROM）で、デプロイ先も同じ Cloudflare
 * Workers 環境である。秘密情報を同じ内容で二重に登録すると、
 * ローテーション時に片方だけ更新されて壊れるため、名前を分けない。
 * コードの独立は「読み口をこのファイルに分ける」ことで保っている。
 * ==================================================================
 */

/* 登録経路によって紛れ込むBOM・前後空白を、意味を変えずに落とす。 */
function sanitize(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(new RegExp('^\\ufeff+'), '').trim();
}

function required(name) {
  const value = sanitize(process.env[name]);

  if (value === '') {
    /* 値そのものは出さない。名前だけで十分に原因が分かる。 */
    throw new Error(`環境変数 ${name} が設定されていません`);
  }

  return value;
}

/** 一斉送信メールの送信設定。 */
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
 * APIの呼び出しを許可するトークン。
 *
 * このAPIは「当社の名義でメールを一斉送信する」操作なので、
 * トークンが未設定のままでは動かさない（未設定＝全拒否）。
 */
export function apiToken() {
  return required('CARD_MAIL_API_TOKEN');
}
