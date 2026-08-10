/*
 * スマホ完結版(mobile-lab)が同梱する重量級アセットの分割・マニフェスト生成。
 *
 * なぜ要るか(docs/specs/short-script-mobile-video-plan-v1.md §4.2 案a):
 *   Cloudflare Workers の静的アセットは1ファイル25MiB(26,214,400バイト)が上限。
 *   piper-plus の日本語G2P wasm(OpenJTalk+NAIST-JDIC同梱)は約58MBあり、
 *   そのままでは配置できない。機械的なバイト分割(*.part1, *.part2, ...)で
 *   同一オリジンのまま置き、ブラウザ側の結合ローダー(vendor-loader.mjs)が
 *   fetch→結合→SHA-256検証まで行う。
 *
 * このスクリプトは「分割」と「マニフェスト生成」だけを行う。
 * 分割済みファイルの結合・検証はブラウザ側(vendor-loader.mjs)の役目で、
 * ロジックを重複させないためにここでは行わない。
 *
 * 実行: node scripts/short-script-vendor/build-manifest.mjs
 */

import { readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vendorRoot = join(here, '../../public/production-app/short-script/vendor');

/* Cloudflare Workers 静的アセットの1ファイル上限(25MiB)。 */
const MAX_ASSET_BYTES = 25 * 1024 * 1024; // 26,214,400
/* 分割時の1パートサイズ。上限ぎりぎりを避け、20MiBで機械的に切る。 */
const PART_BYTES = 20 * 1024 * 1024;

/*
 * 同梱・配信する「実行時に読み込む」アセットの一覧。
 * LICENSE/NOTICE/.d.ts など実行時に読まないファイルはここに含めない
 * (それらは check:vendor の対象ではなく、目視レビューの対象)。
 *
 * unavailable:true は「取得できなかった」ことを正直に記録する印。
 * 偽のSHA-256やダミーバイト列を作らない(CLAUDE.mdの「推測・改変しない」原則)。
 */
const ASSETS = [
  {
    id: 'piper-plus.js',
    path: 'piper/src/index.js',
    note: 'piper-plus 本体(ESM。相対importで同ディレクトリ内の他ファイルを参照するため単一ファイルではない。src/配下一式を静的配信する代表として登録)',
  },
  {
    id: 'piper-plus.g2p-wasm',
    path: 'piper/dist/rust-wasm/piper_plus_wasm_bg.wasm',
    note: 'Rust製G2P(OpenJTalk+NAIST-JDIC同梱)。25MiB超のため分割対象。',
  },
  {
    id: 'onnxruntime-web.wasm',
    path: 'ort/ort-wasm-simd-threaded.wasm',
    note: '単スレッドで動作可(§2.2)。COOP/COEP不要。',
  },
  {
    id: 'jassub.wasm',
    path: 'jassub/dist/wasm/jassub-worker.wasm',
    note: 'libassのwasm移植。modern(SIMD最適化)版は同梱せず標準版のみ採用(逸脱として報告)。',
  },
  {
    id: 'noto-sans-jp.font',
    path: 'fonts/NotoSansJP-Variable.ttf',
    note: 'Variable Font(1ウェイト運用。既定インスタンスがRegular)。10MB未満のためサブセット化しない(逸脱として報告)。',
  },
  {
    id: 'mediabunny.js',
    path: 'mediabunny/mediabunny.min.mjs',
    note: '単一バンドル。',
  },
  {
    id: 'tsukuyomi.model',
    path: 'model/tsukuyomi-chan-6lang-fp16.onnx',
    unavailable: true,
    reason:
      'つくよみちゃんONNXモデルの配布元は Hugging Face(ayousanz/piper-plus-tsukuyomi-chan)のみ。' +
      'このセッションの egress ポリシーが huggingface.co を全面遮断しており(403 policy denial)、' +
      '代替配布元(GitHub Releases等)も確認できなかった。偽のバイト列は置かない。',
  },
  {
    id: 'tsukuyomi.model-config',
    path: 'model/config.json',
    unavailable: true,
    reason: 'tsukuyomi.model と同じ理由(同一リポジトリの config.json)。',
  },
];

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function splitIfNeeded(assetPath) {
  const abs = join(vendorRoot, assetPath);
  const info = await stat(abs);

  if (info.size <= MAX_ASSET_BYTES) {
    const buf = await readFile(abs);
    return {
      bytes: info.size,
      sha256: sha256(buf),
      parts: [{ path: assetPath, bytes: info.size, sha256: sha256(buf) }],
    };
  }

  // 25MiB超。機械的なバイト分割を行い、元ファイルは置き換える。
  const buf = await readFile(abs);
  const combinedSha256 = sha256(buf);
  const parts = [];
  let partIndex = 1;
  for (let offset = 0; offset < buf.length; offset += PART_BYTES) {
    const chunk = buf.subarray(offset, Math.min(offset + PART_BYTES, buf.length));
    const partPath = `${assetPath}.part${partIndex}`;
    await writeFile(join(vendorRoot, partPath), chunk);
    parts.push({ path: partPath, bytes: chunk.length, sha256: sha256(chunk) });
    partIndex += 1;
  }
  // 分割済みなので元の巨大ファイルは配信物として残さない
  // (残すと Cloudflare Workers の25MiB上限にそのまま抵触する)。
  await unlink(abs);

  return { bytes: buf.length, sha256: combinedSha256, parts };
}

async function main() {
  const assets = [];

  for (const def of ASSETS) {
    if (def.unavailable) {
      assets.push({
        id: def.id,
        path: def.path,
        unavailable: true,
        reason: def.reason,
      });
      console.log(`[skip] ${def.id}: 取得不能のため未同梱(${def.reason.slice(0, 40)}...)`);
      continue;
    }

    const abs = join(vendorRoot, def.path);
    let already;
    try {
      already = await stat(abs);
    } catch {
      already = null;
    }

    let result;
    if (already) {
      result = await splitIfNeeded(def.path);
    } else {
      // 既に分割済み(*.part1 等)で元ファイルが無いケース。
      // part ファイルを走査して結合サイズ・ハッシュを出す。
      throw new Error(`${def.path} が見つかりません(未配置か、既に分割済みで再実行が必要)。`);
    }

    assets.push({
      id: def.id,
      path: def.path,
      note: def.note,
      bytes: result.bytes,
      sha256: result.sha256,
      parts: result.parts,
    });

    const splitNote = result.parts.length > 1 ? `(${result.parts.length}分割)` : '';
    console.log(`[ok] ${def.id}: ${result.bytes.toLocaleString()} バイト ${splitNote}`);
  }

  const manifest = {
    cacheName: 'short-script-vendor-v1',
    generatedAt: new Date().toISOString(),
    maxAssetBytes: MAX_ASSET_BYTES,
    assets,
  };

  const manifestPath = join(vendorRoot, 'vendor-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const totalBytes = assets.reduce((sum, a) => sum + (a.bytes || 0), 0);
  console.log(`\nvendor-manifest.json を書き出しました: ${manifestPath}`);
  console.log(`合計(取得可能分): ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  const missing = assets.filter((a) => a.unavailable);
  if (missing.length > 0) {
    console.log(`\n★ 未取得のアセットがあります: ${missing.map((a) => a.id).join(', ')}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
