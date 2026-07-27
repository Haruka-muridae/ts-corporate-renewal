import { defineConfig } from 'vite';

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

  server: {
    port: 5173,
    strictPort: false,
  },
});
