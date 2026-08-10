/*
 * mobile-lab が同梱している第三者ライブラリの整合確認。
 * public/apps/vendor/check-updates.mjs と同じ流儀(確認のみ・自動更新しない)。
 *
 * 確認内容:
 *   1. vendor-manifest.json に書かれたSHA-256と実ファイルが一致するか
 *      (分割ファイルはパートごと・結合後の両方)
 *   2. npm 配布のものは、同梱している版がnpmの最新版と同じか
 *
 * このスクリプトが検証するのは manifest との自己整合(同梱ファイルの実バイトと
 * manifest記載のSHA-256が一致するか)と npm の最新版番号のみであり、
 * 「同梱している版のバイト列がnpm配布物そのものと一致するか」は検証しない
 * (npm配布物のダウンロード・ハッシュ比較は行っていない)。その一致確認は
 * 独立レビューで実施済み(2026-08-10)。
 *
 * 実行: node scripts/short-script-vendor/check-vendor.mjs
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vendorRoot = join(here, '../../public/production-app/short-script/vendor');

/* 同梱版とnpmパッケージ名の対応。npmに存在しないもの(モデル・フォント等)は含めない。 */
const NPM_PACKAGES = {
  'piper-plus.js': { name: 'piper-plus', version: '0.6.0' },
  'piper-plus.g2p-wasm': { name: 'piper-plus', version: '0.6.0' },
  'onnxruntime-web.wasm': { name: 'onnxruntime-web', version: '1.27.0' },
  'onnxruntime-web.js': { name: 'onnxruntime-web', version: '1.27.0' },
  'jassub.wasm': { name: 'jassub', version: '2.5.14' },
  'jassub.js': { name: 'jassub', version: '2.5.14' },
  'jassub.worker-js': { name: 'jassub', version: '2.5.14' },
  'mediabunny.js': { name: 'mediabunny', version: '1.53.0' },
};

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function main() {
  const manifest = JSON.parse(await readFile(join(vendorRoot, 'vendor-manifest.json'), 'utf8'));
  let ok = true;

  for (const asset of manifest.assets) {
    if (asset.unavailable) {
      console.log(`[skip] ${asset.id}: 未同梱(${asset.reason})`);
      continue;
    }

    const buffers = [];
    for (const part of asset.parts) {
      const buf = await readFile(join(vendorRoot, part.path));
      const partHash = sha256(buf);
      if (partHash !== part.sha256) {
        ok = false;
        console.log(`[NG] ${asset.id}: パート ${part.path} のSHA-256が不一致`);
      }
      buffers.push(buf);
    }
    const combined = Buffer.concat(buffers);
    const combinedHash = sha256(combined);
    const match = combinedHash === asset.sha256;
    if (!match) ok = false;
    console.log(`[${match ? 'ok' : 'NG'}] ${asset.id}: ${combined.length.toLocaleString()} バイト`);

    const npmInfo = NPM_PACKAGES[asset.id];
    if (npmInfo) {
      try {
        const res = await fetch(`https://registry.npmjs.org/${npmInfo.name}/latest`, {
          signal: AbortSignal.timeout(15000),
        });
        const latest = (await res.json()).version;
        if (latest === npmInfo.version) {
          console.log(`      npm(${npmInfo.name}) 同梱版=${npmInfo.version} … 最新です`);
        } else {
          console.log(`      npm(${npmInfo.name}) 同梱版=${npmInfo.version} ★最新版=${latest}`);
        }
      } catch (error) {
        console.log(`      npm(${npmInfo.name}) 最新版を取得できませんでした(${error?.name ?? 'Error'})`);
      }
    }
  }

  console.log(ok ? '\nSHA-256はすべて一致しています。' : '\n★ 不一致があります。vendor-manifest.json を作り直してください。');
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
