/*
 * 静的アセット（PDF.js の補助データ、サイトのアイコン）を public/ へ複製する。
 *
 * ------------------------------------------------------------------
 * なぜ必要か（日本語PDFの実害）
 * ------------------------------------------------------------------
 * 日本語PDFの多くは CID フォント（Adobe-Japan1）と、
 * 90ms-RKSJ-H / UniJIS-UCS2-H といった「定義済みCMap」を使う。
 * PDF.js に cMapUrl を渡さないと、CID から Unicode への対応表を
 * 読み込めず、**テキスト抽出が空になるか文字化けする**。
 *
 * standard_fonts は標準14フォントの実体。テキスト抽出だけなら必須ではないが、
 * 未指定だと警告が出るうえ、一部のPDFで抽出精度が落ちる。
 * ------------------------------------------------------------------
 *
 * 読み込みは「そのPDFが必要とするファイルだけ」を実行時に取りに行くため、
 * 全部を先読みすることはない（初期表示は重くならない）。
 *
 * 複製先の public/ は Git 管理外。ビルドのたびに node_modules から作り直す。
 * 配信物（apps/knowledge/cmaps, apps/knowledge/standard_fonts）はコミットする。
 */

import { cp, mkdir, rm, readdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
/* リポジトリのルート（favicon の正本がある場所）。 */
const repoRoot = resolve(root, '../..');

const SOURCES = [
  { from: resolve(root, 'node_modules/pdfjs-dist/cmaps'), to: resolve(root, 'public/cmaps'), label: 'cmaps' },
  { from: resolve(root, 'node_modules/pdfjs-dist/standard_fonts'), to: resolve(root, 'public/standard_fonts'), label: 'standard_fonts' },
];

/*
 * アイコン。
 * 正本はリポジトリのルート（他ページと共用）。
 * ここへ複製することで、このアプリは配信ディレクトリだけで自己完結する。
 * サイトルート絶対パス（/favicon.ico）を参照すると、
 * プロジェクトPages のようなサブパス配信で 404 になり、コンソールにエラーが出る。
 */
const ICONS = ['favicon.ico', 'favicon-32x32.png', 'favicon-16x16.png', 'apple-touch-icon.png'];

await mkdir(resolve(root, 'public'), { recursive: true });

for (const icon of ICONS) {
  try {
    await copyFile(resolve(repoRoot, icon), resolve(root, 'public', icon));
  } catch {
    console.warn(`[copy-assets] アイコンを複製できませんでした（スキップ）: ${icon}`);
  }
}

console.log(`[copy-assets] icons: ${ICONS.length} ファイルを確認しました。`);

for (const source of SOURCES) {
  try {
    await readdir(source.from);
  } catch {
    console.error(`[copy-assets] 複製元が見つかりません: ${source.from}`);
    console.error('[copy-assets] npm install を先に実行してください。');
    process.exit(1);
  }

  /* 古いファイルを残さないよう、毎回作り直す。 */
  await rm(source.to, { recursive: true, force: true });
  await cp(source.from, source.to, { recursive: true });

  const files = await readdir(source.to);
  console.log(`[copy-assets] ${source.label}: ${files.length} ファイルを複製しました。`);
}
