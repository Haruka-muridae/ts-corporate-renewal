import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/*
 * ビルド設定。
 *
 * このリポジトリは GitHub Pages でリポジトリ直下を静的配信している。
 * したがって「ソース」と「配信物」を分ける。
 *
 *   apps/knowledge-src/  … このViteプロジェクト（node_modules はコミットしない）
 *   apps/knowledge/      … `npm run build` の出力（コミットして配信する）
 *
 * base: './' にすることで、独自ドメイン（https://tsam-ai.com/apps/knowledge/）でも
 * プロジェクトPages（https://<user>.github.io/<repo>/apps/knowledge/）でも
 * 同じ成果物がそのまま動く。絶対パスにするとサブパス配信で404になる。
 */
export default defineConfig({
  base: './',

  build: {
    outDir: '../knowledge',
    /*
     * outDir がプロジェクトルート外のため、明示しないとViteが確認プロンプトを出す。
     * 出力先は専用ディレクトリであり、他の成果物と混在しない。
     */
    emptyOutDir: true,
    target: 'es2022',
    /*
     * CSPで script-src に 'unsafe-inline' を入れないため、
     * インライン化を禁止してすべて外部ファイルとして出力する。
     */
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: {
      /*
       * マルチページ構成。
       *
       *   index.html      → apps/knowledge/index.html        ナレッジ管理
       *   chat/index.html → apps/knowledge/chat/index.html   AIナレッジチャット
       *
       * チャットを別プロジェクトにしないのは次の理由による。
       *   1. このプロジェクトは emptyOutDir: true で ../knowledge を毎回空にする。
       *      別プロジェクトが ../knowledge/chat へ出力すると、ここのビルドで消える。
       *   2. IndexedDB スキーマ・検索サービス・DOMヘルパーをそのまま再利用したい。
       *      同一プロジェクトなら import するだけで済み、実装が二重化しない。
       *
       * WebLLM はチャット側からしか import しないため、Rollup が自動的に
       * チャット専用チャンクへ分離する。ナレッジ管理側の読み込み量は増えない。
       */
      input: {
        main: resolve(here, 'index.html'),
        chat: resolve(here, 'chat/index.html'),
      },

      output: {
        /*
         * ライブラリを分割しておくと、更新時のキャッシュ再取得量が減る。
         * MiniSearch と PDF.js は Worker 側だけで使うため、ここには入れない
         * （入れると本体側に空チャンクができる）。
         */
        manualChunks: {
          dexie: ['dexie'],
        },
      },
    },
  },

  /* Web Worker も ES モジュールとして出力する（Chrome前提）。 */
  worker: {
    format: 'es',
  },

  /*
   * 依存の事前バンドル。
   *
   * ------------------------------------------------------------------
   * Worker が掴む依存は必ず include すること（重要）
   * ------------------------------------------------------------------
   * Vite は初回アクセス時に依存を発見して事前バンドルし、URL に ?v=<hash> を付ける。
   * 途中で新しい依存が見つかると再バンドルが走り、hash が変わる。
   * ページ側は自動で再読み込みされるが、**すでに起動している Web Worker は
   * 古い hash を掴んだまま**になり、その依存が 504 になって Worker ごと落ちる。
   *
   * 実際、@mlc-ai/web-llm を追加した直後に
   *   /node_modules/.vite/deps/mammoth_mammoth__browser__js.js?v=... → 504
   * となり、解析ワーカーが WORKER_CRASHED で全ファイル失敗した。
   *
   * そこで、Worker が使う依存は起動時にまとめて確定させる。
   * ------------------------------------------------------------------
   */
  optimizeDeps: {
    include: [
      'dexie',
      'minisearch',
      'mammoth/mammoth.browser.js',
    ],
    /*
     * WebLLM は「モデルを準備する」を押したときだけ動的 import する。
     * 事前バンドルの対象にすると、初回アクセス時に巨大な依存を解析して
     * 再バンドルを誘発するため除外する。
     */
    exclude: ['@mlc-ai/web-llm'],
  },

  server: {
    port: 5173,
    strictPort: false,
  },
});
