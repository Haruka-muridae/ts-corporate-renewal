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
    note: 'piper-plus 本体(ESM。相対importで同ディレクトリ内の他ファイルを参照するため単一ファイルではない。src/配下一式を静的配信する代表として登録)。' +
      '実行時のimportは同一オリジン再取得になる(独立レビュー指摘1対応。§4.4)。',
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
    id: 'onnxruntime-web.js',
    path: 'ort/ort.wasm.min.mjs',
    note: 'onnxruntime-webのグルーJS(ESM)。実行時のimportは同一オリジン再取得になる(独立レビュー指摘1対応。§4.4 M1の到達点)。',
  },
  {
    id: 'jassub.wasm',
    path: 'jassub/dist/wasm/jassub-worker.wasm',
    note: 'libassのwasm移植。modern(SIMD最適化)版は同梱せず標準版のみ採用(逸脱として報告)。',
  },
  {
    id: 'jassub.js',
    path: 'jassub/dist/jassub.js',
    note: 'JASSUB本体(ESM)。Worker生成とfont/wasmのURL解決を行う。実行時のimportは同一オリジン再取得になる(独立レビュー指摘1対応。§4.4)。',
  },
  {
    id: 'jassub.worker-js',
    path: 'jassub/dist/worker/worker.js',
    note: 'JASSUBのWorker本体(ESM)。同ディレクトリのrenderers/*.js・../wasm/jassub-worker.jsを相対importする一式の代表として登録' +
      '(piper-plus.jsと同じ扱い。§4.4)。',
  },
  {
    id: 'noto-sans-jp.font',
    path: 'fonts/NotoSansJP-Variable.ttf',
    note: 'Variable Font(1ウェイト運用。既定インスタンスがRegular)。10MB未満のためサブセット化しない(逸脱として報告)。',
  },
  {
    id: 'mediabunny.js',
    path: 'mediabunny/mediabunny.min.mjs',
    note: '単一バンドル。実行時のimportは同一オリジン再取得になる(独立レビュー指摘1対応。§4.4)。',
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

/**
 * 既に `*.part1` `*.part2` ... へ分割済み(元ファイルは削除済み)の場合に、
 * パートを読んで結合バイト数・SHA-256を再計算する。
 *
 * このスクリプトは新しいアセットを ASSETS に追加するたびに再実行する運用のため、
 * 既に分割済みのアセット(piper-plus.g2p-wasm)についても毎回 stat/readFile を通す
 * 必要がある。分割・削除は初回のみで、2回目以降はこちらの経路を通り、
 * 既存のパートファイルを再利用する(再分割・再削除はしない)。
 */
async function combineExistingParts(assetPath) {
  const parts = [];
  let partIndex = 1;
  for (;;) {
    const partPath = `${assetPath}.part${partIndex}`;
    const abs = join(vendorRoot, partPath);
    let info;
    try {
      info = await stat(abs);
    } catch {
      break;
    }
    const buf = await readFile(abs);
    parts.push({ path: partPath, bytes: info.size, sha256: sha256(buf), buf });
    partIndex += 1;
  }
  if (parts.length === 0) return null;

  const combined = Buffer.concat(parts.map((p) => p.buf));
  return {
    bytes: combined.length,
    sha256: sha256(combined),
    parts: parts.map((p) => ({ path: p.path, bytes: p.bytes, sha256: p.sha256 })),
  };
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
      // 元ファイルが無い場合、既に分割済み(*.part1 等)であることを期待して
      // パートファイルを走査する(再分割・再削除はしない。冪等な再実行のため)。
      result = await combineExistingParts(def.path);
      if (!result) {
        throw new Error(`${def.path} が見つかりません(未配置か、想定外の状態です)。`);
      }
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
