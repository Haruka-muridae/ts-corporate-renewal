import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  /*
   * 同梱している第三者ライブラリ（vendor/）は lint の対象外にする。
   *
   * これらは配布物をそのまま置いたものであり、NOTICE で「改変なし」を宣言している
   * （docs/external-dependency-approvals.md §2）。指摘が出ても直せないため、
   * 対象に含めると「直せない警告」だけが積み上がり、自分のコードの警告が埋もれる。
   *
   * 対象は public/ 配下の vendor ディレクトリのみ。
   * lamejs（voice-recorder）と supabase-auth-js がこれにあたる。
   */
  /*
   * Playwright の実行成果物。トレースには**表示したページの JS がそのまま入る**ため、
   * 対象に含めると vendor の中身が別経路で戻ってきて lint が汚れる。
   * .gitignore には入れてあるが、ESLint は .gitignore を見ない。
   */
  /*
   * docs/ は**配信もビルドもされない参照物**なので対象にしない。
   *
   * 仕様書・手順書のほかに、設計を参照するためのコード片も置いてある
   * （docs/pipeline/prototype/ の UI プロトタイプなど）。これらは
   * 動かすものではなく、**原本として手を入れない**方針のもの
   * （法務文書の生成物やアーカイブと同じ扱い）。
   *
   * 対象に含めると、直さない前提のファイルの警告が積み上がり、
   * 「自分が触った範囲に新しい警告を足さない」という基準が見えなくなる。
   */
  globalIgnores([
    ".next/**",
    "out/**",
    "next-env.d.ts",
    "docs/**",
    "public/**/vendor/**",
    "tests/e2e/.report/**",
    "tests/e2e/.artifacts/**",
  ]),
]);
