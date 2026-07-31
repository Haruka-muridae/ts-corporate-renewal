/*
 * TSAM AI から外部サイトへ送り出すリンクの正本。
 *
 * ------------------------------------------------------------------
 * ここを1か所にする理由
 * ------------------------------------------------------------------
 * 同じURLをHTMLや複数のJSへ書き写すと、変更のとき必ずどこかが取り残される。
 * 紹介リンクの場合、取り残しは「紹介の帰属が失われる」という
 * 目に見えない形の不具合になり、気づくのが遅れる。
 *
 * したがって、URLを書いてよいのはこのファイルだけとする。
 * 画面側は import して使い、href へ直接URLを書かない。
 * ------------------------------------------------------------------
 *
 * ここに入れてよいもの:
 *   公開されている外部サービスのURL
 *
 * ここに入れてはならないもの:
 *   APIキー / アクセストークン / 個人の認証情報 /
 *   利用者ごとに変わる値（このファイルは全利用者へ同じ内容が配信される）
 */

/*
 * 通常のGoogleアカウント作成ページ。
 *
 * Google公式のヘルプ（アカウントの作成）が案内している入口。
 * 確認日 2026-07-28: https://support.google.com/accounts/answer/27441
 *
 * 無料で作成できる。TSAM AI の利用にはこれで足りる。
 * Google Workspace の契約は不要である。
 */
export const GOOGLE_ACCOUNT_CREATE_URL = 'https://accounts.google.com/signup';

/*
 * Google Workspace 紹介プログラム。
 *
 * ------------------------------------------------------------------
 * 短縮URLのままにしている理由（重要）
 * ------------------------------------------------------------------
 * このURLは 302 で次へ転送される（確認日 2026-07-28）。
 *
 *   https://workspace.google.com/pricing?utm_source=sign-up
 *     &utm_medium=affiliatereferral&utm_campaign=apps-referral-program
 *     &uj=ref.promo~save10&uj=ref.referrer~<紹介者ID>
 *
 * 転送先を直接書けば、終了済みドメイン系列（下記）への依存を外せる。
 * しかし **紹介の帰属が転送前の経路にも依存していないという確証が無い**。
 * 帰属が壊れても画面上は正常に見えるため、間違いに気づけない。
 *
 * 確証が取れるまでは短縮URLを維持する。
 * 置き換えるのは、紹介プログラム側の資料で
 * 「直リンクでも帰属する」と確認できてからにすること。
 *
 * ------------------------------------------------------------------
 * 把握しているリスク
 * ------------------------------------------------------------------
 * app.goo.gl は Firebase Dynamic Links のドメインであり、
 * 同サービスは 2025-08-25 に終了している。
 *   https://firebase.google.com/support/dynamic-links-faq
 *
 * 2026-07-28 時点でこのリンクは動作している。
 * Workspace 紹介プログラムが Google 自身の運用として
 * 別扱いで維持しているものと見られる。
 *
 * ただし予告なく停止する可能性を否定できない。
 * 停止するとボタンが行き先の無いリンクになるため、
 * 定期的に手で開いて確認すること（自動テストからは開かない。
 * 紹介プログラム側へ不要な通信を発生させないため）。
 * ------------------------------------------------------------------
 */
export const GOOGLE_WORKSPACE_REFERRAL_URL = 'https://referworkspace.app.goo.gl/2KTq';

/*
 * 遷移先として許可するホスト。
 *
 * 短縮URLは転送されるため、最終的な着地点（workspace.google.com）も
 * 併記しておく。将来 URL を直リンクへ置き換えたとき、
 * この一覧を直さずに済む。
 */
export const ALLOWED_HOSTS = Object.freeze([
  'accounts.google.com',
  'referworkspace.app.goo.gl',
  'workspace.google.com',
]);

/*
 * URLが「このファイルが配る値として妥当か」を検査する。
 *
 * ------------------------------------------------------------------
 * これは入力検証ではない
 * ------------------------------------------------------------------
 * 引数に外部からの値（URLパラメータ・利用者入力）を渡さないこと。
 * ここで検査しているのは、このファイルの定数を書き換えたときの
 * 打ち間違いを実行前に見つけることだけである。
 *
 * 実行時に任意のURLを受け取って開く経路は作らない。
 * 作ると、リンクの行き先を外から差し替えられる穴になる。
 * ------------------------------------------------------------------
 */
export function isAllowedExternalUrl(value) {
  if (typeof value !== 'string' || value.trim() !== value || value === '') {
    return false;
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  /* http は許可しない。転送の途中で内容を差し替えられる。 */
  if (url.protocol !== 'https:') {
    return false;
  }

  /*
   * ホストの完全一致だけを許す。
   * endsWith で判定すると evil-accounts.google.com.attacker.test が通る。
   */
  return ALLOWED_HOSTS.includes(url.hostname);
}

/*
 * 画面へ出すリンクの一覧。
 *
 * 文言もここに持つ。
 * 「有料である」「紹介リンクである」「外部サイトである」は
 * 表示から落ちてはならない項目なので、URLと同じ場所で管理し、
 * 片方だけ直して片方が古いままになる事故を防ぐ。
 */
export const ACCOUNT_LINKS = Object.freeze([
  Object.freeze({
    id: 'google-account',
    url: GOOGLE_ACCOUNT_CREATE_URL,
    label: 'Googleアカウントを作成',
    /* 通常のGoogleアカウントは無料。ここでだけ「無料」と書いてよい。 */
    lead: '無料のGoogleアカウントを作成すると、TSAM AI へログインできます。',
    note: 'Google LLC が提供する外部サイトへ移動します。',
  }),
  Object.freeze({
    id: 'workspace-referral',
    url: GOOGLE_WORKSPACE_REFERRAL_URL,
    label: 'Google Workspaceを始める',
    lead: '法人・チームでGoogleサービスを利用する方は、Google Workspace を紹介特典付きで始められます。',
    /*
     * 「無料」と書いてはならない。
     * 転送先は料金ページであり、無料で始められる案内ではない。
     */
    note: 'Google Workspace 紹介プログラムのリンクです。'
      + 'Google Workspace は有料サービスです。'
      + 'Google LLC が提供する外部サービスへ移動します。',
  }),
]);
