/*
 * Supabase Auth クライアント（GoTrueClient）の単一インスタンス。
 *
 * ------------------------------------------------------------------
 * なぜ1つに限定するのか
 * ------------------------------------------------------------------
 * GoTrueClient はトークンの自動更新タイマーと、タブ間ロックを内部に持つ。
 * 同じページで複数作ると、更新要求が競合して
 * 「片方が更新した直後にもう片方が古いトークンで上書きする」事故が起きる。
 * SDK自身も複数生成時に警告を出す。
 *
 * したがって生成はこのファイルだけで行い、他からは getAuthClient() を使う。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 読み込みの遅延
 * ------------------------------------------------------------------
 * SDK本体（約96KB）は動的 import で必要になったときだけ読み込む。
 * Supabase が未設定なら **一度も読み込まない**。
 *
 * 配信元はこのサイト自身（apps/vendor/）。第三者CDNは使わない。
 * 理由は apps/vendor/NOTICE-supabase-auth-js.md を参照。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * トークンの保存先
 * ------------------------------------------------------------------
 * SDK が localStorage へ保存する（キー: tsam-ai-supabase-auth）。
 * ここにはアクセストークンと refresh token が入る。
 *
 * これは「XSSがあれば盗まれる」場所である。静的サイトには
 * HttpOnly Cookie を設定できるサーバーが無いため、この構成では避けられない。
 * だからこそ、画面へ値を出すときは必ず textContent を使い、
 * innerHTML と外部CDNのスクリプトを持ち込まないこと。
 * ------------------------------------------------------------------
 */

import { SUPABASE_CONFIG, isSupabaseConfigured, describeConfig } from './supabase-config.js';

/* 同梱SDKの場所。更新時は NOTICE と .gitattributes も合わせて直す。 */
const VENDOR_PATH = '../vendor/supabase-auth-js-2.110.8.esm.js';

export class SupabaseUnavailableError extends Error {
  constructor(reason) {
    super('SUPABASE_UNAVAILABLE');
    this.name = 'SupabaseUnavailableError';
    this.reason = reason ?? null;
  }
}

let clientPromise = null;

/*
 * Supabase Auth クライアントを返す（初回のみ生成）。
 * 未設定なら SupabaseUnavailableError を投げ、SDKも読み込まない。
 */
export function getAuthClient() {
  if (clientPromise) {
    return clientPromise;
  }

  const status = describeConfig();

  if (!status.configured) {
    /* 失敗はキャッシュしない。設定を直して再読み込みすれば動く。 */
    return Promise.reject(new SupabaseUnavailableError(status.reason));
  }

  clientPromise = createClient();

  /* 読み込み失敗を握りつぶさず、再試行できるようにキャッシュだけ捨てる。 */
  clientPromise.catch(() => {
    clientPromise = null;
  });

  return clientPromise;
}

async function createClient() {
  let module;

  try {
    /*
     * 相対パスで指定する。サイト内絶対パス（/apps/vendor/…）にすると
     * プロジェクトPages（/リポジトリ名/…）配信で404になる。
     */
    module = await import(VENDOR_PATH);
  } catch (error) {
    throw new SupabaseUnavailableError(
      `認証ライブラリを読み込めませんでした（${error?.name ?? 'Error'}）。`,
    );
  }

  const { GoTrueClient } = module;

  if (typeof GoTrueClient !== 'function') {
    throw new SupabaseUnavailableError('認証ライブラリの形式が想定と異なります。');
  }

  /*
   * 設定値は貼り付けミス（前後の空白・改行・引用符）が起きやすい。
   * ヘッダーやURLへ入れる前にここで正規化する。
   * 空白入りのキーをそのまま送ると、原因の分かりにくい401になる。
   */
  const url = String(SUPABASE_CONFIG.url).trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  const anonKey = String(SUPABASE_CONFIG.anonKey).trim().replace(/^["']|["']$/g, '');

  return new GoTrueClient({
    /* GoTrue のエンドポイントは Project URL + /auth/v1。 */
    url: `${url}/auth/v1`,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },

    storageKey: SUPABASE_CONFIG.storageKey,

    /* タブを閉じても再ログインを求めないよう、保存して復元する。 */
    persistSession: true,
    autoRefreshToken: true,

    /*
     * メールリンクは PKCE で受ける。
     * URLのハッシュにトークンが直接載る implicit フローと違い、
     * 一度きりの code を交換する方式のため、リンクの再利用や
     * 履歴・リファラからの漏えいに強い。
     */
    flowType: 'pkce',

    /*
     * URL からのセッション検出は **自前で行う**（false）。
     * 自動検出だとどのページでも解釈されてしまうため、
     * apps/auth-callback/ でだけ明示的に処理する。
     */
    detectSessionInUrl: false,
  });
}

/* 設定済みかどうか。SDKを読み込まずに判定できる。 */
export { isSupabaseConfigured, describeConfig };

/*
 * テスト用。生成済みインスタンスを差し替える。
 * 本番コードから呼ばないこと。
 */
export function __setClientForTest(client) {
  clientPromise = client === null ? null : Promise.resolve(client);
}
