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
  globalIgnores([
    ".next/**",
    "out/**",
    "next-env.d.ts",
    "public/**/vendor/**",
    "tests/e2e/.report/**",
    "tests/e2e/.artifacts/**",
  ]),
]);
