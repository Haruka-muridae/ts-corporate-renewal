import type { NextConfig } from "next";

/*
 * 1リポジトリで、コーポレートサイト（静的HTML）と交流会申込アプリ（Next.js）の
 * 両方を配信する。
 *
 * - `/`              … public/index.html（現行のコーポレートサイトをそのまま配信）
 * - `/apps/`, `/legal/`, `/login/` など … public/ 配下の既存の静的ページ
 * - `/event/`        … public/event/index.html（交流会の詳細ページ。静的のまま）
 * - `/event/apply` 以降 … このNext.jsアプリのルート（app/event/ 配下）
 *
 * basePath は使わない。basePath は public/ 配下の静的ファイルにも適用されるため、
 * `basePath: "/event"` にするとルート（`/`）が404になり、
 * 「ルートは既存サイト、/event/ はアプリ」という構成が成立しないため。
 * 公開URLは basePath なしでも仕様どおり https://tsam-ai.com/event/... になる。
 *
 * output: "export" は使わない。Webhook受信とCheckout Session作成に
 * サーバー側の実行環境が必要なため。
 */
const nextConfig: NextConfig = {
  trailingSlash: true,
  reactStrictMode: true,
  turbopack: {
    root: process.cwd(),
  },
  /*
   * 配列で返す rewrites は「ファイルシステムとNextのルートを探したあと」に評価される
   * （afterFiles）。したがって app/ 配下のルートが常に優先され、
   * どこにも一致しなかったURLだけがここで public/ の index.html に落ちる。
   */
  async rewrites() {
    return [
      /*
       * Next.js は public/ 配下のディレクトリを index.html に割り当てないため、
       * 明示的に書き換える。これがないと `/` や `/apps/` が404になる。
       */
      { source: "/", destination: "/index.html" },
      { source: "/:path*/", destination: "/:path*/index.html" },
    ];
  },
};

export default nextConfig;
