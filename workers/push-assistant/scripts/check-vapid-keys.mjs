/*
 * VAPID の鍵ペアを、**登録する前に**手元で確かめる。
 *
 *   node workers/push-assistant/scripts/check-vapid-keys.mjs
 *   （1行目に秘密鍵、2行目に公開鍵を貼って Enter、最後に Ctrl+Z → Enter）
 *
 * ------------------------------------------------------------------
 * 複製元
 * ------------------------------------------------------------------
 * workers/notifier-gate/scripts/check-vapid-keys.mjs（2026-08-26 に複製）。
 * docs/repository-structure.md §4-1 に従い、共通層を作らず写した。
 * 変えたのは参照先の config パスと、署名の試し打ちに使う sub だけ。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * なぜ要るのか
 * ------------------------------------------------------------------
 * 鍵は `wrangler secret put` で登録したあと、**中身を読み返せない。**
 * そのため貼り付けを1文字でも誤ると、気づけるのが「本番で 500 が出たとき」に
 * なる。実機でまさにそうなった（2026-08-11）。
 *
 * ここでは Worker と**同じコード**（src/vapid.mjs）で読み込み・署名を行い、
 * さらに公開鍵で署名を検証する。通れば、その2つは
 *   - 形式が正しく
 *   - 互いに対になっている
 * ことが確定する。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 鍵を引数に渡さない
 * ------------------------------------------------------------------
 * コマンドライン引数はシェルの履歴とプロセス一覧に残る。
 * 標準入力から読むのはそのため。**この出力にも鍵は出さない。**
 * ------------------------------------------------------------------
 */

import { describeKeyMaterial, importVapidPrivateKey, base64ToBytes, normalizeBase64Url, signJwt } from '../src/vapid.mjs';

const SAMPLE_AUDIENCE = 'https://fcm.googleapis.com';
const SAMPLE_SUBJECT = 'https://tsam-ai.com/push-assistant/';

function fail(message) {
  console.error(`  NG   ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`  ok   ${message}`);
}

async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

const input = (await readStdin()).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');

if (input.length < 2) {
  console.error(
    'VAPID の鍵を2行で貼ってください。\n'
    + '  1行目: VAPID_PRIVATE_KEY（PKCS#8 / base64）\n'
    + '  2行目: VAPID_PUBLIC_KEY（base64url）\n'
    + '入力を終えるには Ctrl+Z → Enter（PowerShell）／Ctrl+D（bash）。',
  );
  process.exit(1);
}

const [privateText, publicText] = input;

console.log('VAPID の鍵を確認します（値そのものは表示しません）。\n');

/* ---------- 1. 形式 ---------- */

const shape = describeKeyMaterial(privateText);

console.log(`  秘密鍵の形式: ${shape.kind}（${shape.length} 文字）`);

if (shape.kind === 'unknown') {
  fail('base64 以外の文字が混ざっています。見出し行ごと貼っていませんか。');
}

const publicVariant = /[+/=]/.test(publicText) ? 'base64（素）' : 'base64url';

console.log(`  公開鍵の形式: ${publicVariant}（${publicText.length} 文字）\n`);

if (publicVariant === 'base64（素）') {
  console.log(
    '  注意: 公開鍵は base64url で登録するのが正です。\n'
    + '        Worker 側は素の base64 でも直して使いますが、揃えておくほうが安全です。\n',
  );
}

/* ---------- 2. 秘密鍵を読めるか（Worker と同じコード） ---------- */

let privateKey = null;

try {
  privateKey = await importVapidPrivateKey(privateText);
  pass('秘密鍵を読み込めました（PKCS#8 / P-256）');
} catch (error) {
  fail(`秘密鍵を読み込めません: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

/* ---------- 3. 公開鍵の形（非圧縮の65バイト） ---------- */

let publicBytes = null;

try {
  publicBytes = base64ToBytes(normalizeBase64Url(publicText));
} catch {
  fail('公開鍵を base64 として読めません。');
  process.exit(1);
}

if (publicBytes.length !== 65) {
  fail(`公開鍵が ${publicBytes.length} バイトです。非圧縮形式の65バイトである必要があります。`);
} else if (publicBytes[0] !== 0x04) {
  fail('公開鍵の先頭が 0x04 ではありません（非圧縮形式ではありません）。');
} else {
  pass('公開鍵の形が正しい（非圧縮 65 バイト）');
}

/* ---------- 4. 署名して、公開鍵で検証する（＝対になっているか） ---------- */

const jwt = await signJwt({
  privateKey,
  audience: SAMPLE_AUDIENCE,
  subject: SAMPLE_SUBJECT,
  nowMs: Date.now(),
});

const [header, claims, signature] = jwt.split('.');

pass('ES256 で署名できました');

try {
  const verifyKey = await crypto.subtle.importKey(
    'raw',
    publicBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );

  const verified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    base64ToBytes(signature),
    new TextEncoder().encode(`${header}.${claims}`),
  );

  if (verified) {
    pass('★この2つは対になっています（公開鍵で署名を検証できました）');
  } else {
    fail('★秘密鍵と公開鍵が対になっていません。別々に生成した値を混ぜていませんか。');
  }
} catch (error) {
  fail(`公開鍵で検証できません: ${error instanceof Error ? error.message : error}`);
}

console.log(
  process.exitCode
    ? '\n問題があります。上の NG を直してから登録してください。'
    : '\nこの2つはそのまま登録して構いません。'
    + '\n  npx wrangler secret put VAPID_PRIVATE_KEY --config workers/push-assistant/wrangler.jsonc'
    + '\n  npx wrangler secret put VAPID_PUBLIC_KEY  --config workers/push-assistant/wrangler.jsonc',
);
