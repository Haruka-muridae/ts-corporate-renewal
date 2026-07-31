/*
 * OAuthクライアントIDの単一正本から、ビルド用の設定モジュールを生成する。
 *
 * ------------------------------------------------------------------
 * なぜ生成が必要か
 * ------------------------------------------------------------------
 * /apps/ 配下はビルド無しの素のESMで配信されており、
 * このナレッジアプリだけが Vite でバンドルされる。
 * 配信形態が違うため、実行時に同じファイルを読むことができない。
 *
 * そこで「ビルド前に正本から取り込む」方式にした。
 * クライアントIDを2か所へ手入力する運用は残さない。
 * ------------------------------------------------------------------
 *
 * 正本: apps/auth-config.js の GOOGLE_AUTH_CONFIG.clientId
 * 生成先: apps/knowledge-src/src/generated/google-config.js（Git管理外）
 *
 * 実行:
 *   npm run generate:config      （prebuild / predev から自動実行される）
 *
 * 秘密情報は扱わない。クライアントIDは公開情報であり、
 * 保護は「承認済みのJavaScript生成元」の制限で行う。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = resolve(here, '../../auth-config.js');
const OUTPUT_PATH = resolve(here, '../src/generated/google-config.js');

/* apps/auth-config.js はDOMに依存しない純粋なESMなので、Nodeから直接読める。 */
const source = await import(pathToFileURL(SOURCE_PATH).href).catch((error) => {
  console.error(`[generate-auth-config] 正本を読み込めませんでした: ${SOURCE_PATH}`);
  console.error(error.message);
  process.exit(1);
});

const clientId = source?.GOOGLE_AUTH_CONFIG?.clientId;
const placeholder = source?.CLIENT_ID_PLACEHOLDER ?? 'REPLACE_WITH_GOOGLE_CLIENT_ID';

if (typeof clientId !== 'string' || clientId.trim() === '') {
  console.error('[generate-auth-config] GOOGLE_AUTH_CONFIG.clientId が見つかりません。');
  process.exit(1);
}

/*
 * 生成物へ書き出すのは「文字列リテラル1つ」だけ。
 * 正本のコードをそのまま埋め込まない（意図しない値の混入を防ぐ）。
 */
const escaped = JSON.stringify(clientId.trim());
const escapedPlaceholder = JSON.stringify(placeholder);

const banner = `/*
 * 自動生成ファイル。直接編集しないこと。
 *
 * 生成元 : apps/auth-config.js（OAuthクライアントIDの正本）
 * 生成器 : apps/knowledge-src/scripts/generate-auth-config.mjs
 * 再生成 : npm run generate:config（npm run build / npm run dev で自動実行）
 *
 * このファイルはGit管理外。値を変えたいときは必ず正本を編集する。
 */
`;

const body = `${banner}
export const CLIENT_ID_PLACEHOLDER = ${escapedPlaceholder};

export const GOOGLE_CLIENT_ID = ${escaped};
`;

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, body, 'utf8');

const configured = clientId.trim() !== placeholder && clientId.trim().endsWith('.apps.googleusercontent.com');

console.log(`[generate-auth-config] 生成しました: src/generated/google-config.js`);
console.log(`[generate-auth-config] clientId: ${configured ? '設定済み' : '未設定（プレースホルダー）'}`);
