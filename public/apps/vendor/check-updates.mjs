/*
 * 同梱している認証ライブラリに更新が無いかを確認する。
 *
 * 自己ホストしているため package.json に載っておらず、
 * Dependabot 等の自動追跡が効かない。手動で確認するための補助。
 *
 * 実行: node apps/vendor/check-updates.mjs
 *
 * ------------------------------------------------------------------
 * このスクリプトは確認だけを行う。
 * 勝手に更新しない（挙動が変わるため、更新は人の判断で行う）。
 * 更新手順は NOTICE-supabase-auth-js.md を参照。
 * ------------------------------------------------------------------
 */

import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/* 同梱ファイルを名前から特定する（ファイル名にバージョンを含めている）。 */
const files = await readdir(here);
const bundle = files.find((f) => /^supabase-auth-js-.*\.esm\.js$/.test(f));

if (!bundle) {
  console.error('同梱ファイルが見つかりません。');
  process.exit(1);
}

const localVersion = bundle.replace(/^supabase-auth-js-/, '').replace(/\.esm\.js$/, '');
const content = await readFile(join(here, bundle));
const sha256 = createHash('sha256').update(content).digest('hex');

console.log(`同梱版      : ${localVersion}`);
console.log(`SHA-256     : ${sha256}`);
console.log(`サイズ      : ${content.length} バイト`);

/* NOTICE の記載と実ファイルが一致しているか。 */
const notice = await readFile(join(here, 'NOTICE-supabase-auth-js.md'), 'utf8');
const noticeOk = notice.includes(sha256) && notice.includes(localVersion);
console.log(`NOTICE整合  : ${noticeOk ? '一致' : '★不一致（NOTICEを更新すること）'}`);

/* バンドルの中に埋め込まれた版と、ファイル名の版が一致しているか。 */
const embedded = content.toString('utf8').match(/var \w+="(\d+\.\d+\.\d+)"/);
console.log(`埋込版      : ${embedded ? embedded[1] : '不明'}${
  embedded && embedded[1] !== localVersion ? ' ★ファイル名と不一致' : ''}`);

/* npm の最新版を問い合わせる。 */
let latest = null;

try {
  const res = await fetch('https://registry.npmjs.org/@supabase/auth-js/latest', {
    signal: AbortSignal.timeout(15000),
  });
  latest = (await res.json()).version;
} catch (error) {
  console.log(`最新版      : 取得できませんでした（${error?.name ?? 'Error'}）`);
}

/*
 * process.exit() は使わない。
 * fetch 直後に強制終了すると、Windows の Node で
 * 内部ハンドルの後始末に失敗して警告が出るため、自然終了に任せる。
 */
if (latest === null) {
  /* オフライン等。ローカルの情報だけ表示して終わる。 */
} else if (latest === localVersion) {
  console.log(`最新版(npm) : ${latest}`);
  console.log('\n最新です。対応は不要です。');
} else {
  console.log(`最新版(npm) : ${latest}`);
  console.log(`\n★ 更新があります: ${localVersion} → ${latest}`);
  console.log('更新する場合は NOTICE-supabase-auth-js.md の「再生成の手順」に従い、');
  console.log('更新後に認証まわりのテストを再実行してください。');
  console.log('※ 自動更新はしません。挙動が変わる可能性があるため人が判断してください。');
}
