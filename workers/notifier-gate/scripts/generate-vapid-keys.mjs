/*
 * VAPID の鍵ペアを1組つくる。
 *
 *   node workers/notifier-gate/scripts/generate-vapid-keys.mjs
 *
 * ------------------------------------------------------------------
 * openssl を使わない理由
 * ------------------------------------------------------------------
 * VAPID の公開鍵は「非圧縮形式の生の楕円曲線点（0x04 + X + Y の65バイト）を
 * base64url にしたもの」で、これがブラウザの applicationServerKey になる。
 * openssl から取り出すには DER の中の BIT STRING を切り出す作業が要り、
 * 手順として書くと間違えやすい。WebCrypto の exportKey('raw') は
 * まさにこの65バイトを返すので、Node だけで完結させたほうが安全である。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 出力の扱い
 * ------------------------------------------------------------------
 * **秘密鍵をリポジトリへコミットしないこと。** 画面に出た値を
 * `wrangler secret put` へ貼るだけにして、ファイルに保存しない。
 * 鍵を差し替えると全利用者の購読が無効になる（README.md §4）。
 * ------------------------------------------------------------------
 */

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);

const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));

console.log('VAPID の鍵ペアを生成しました。');
console.log('この2つを wrangler secret put で登録してください（ファイルに保存しないこと）。\n');

console.log('--- VAPID_PRIVATE_KEY（PKCS#8 / base64。1行のまま貼る） ---');
console.log(toBase64(pkcs8));
console.log('');

console.log('--- VAPID_PUBLIC_KEY（base64url。ブラウザの applicationServerKey と同じ値） ---');
console.log(toBase64Url(raw));
console.log('');

console.log('登録コマンド:');
console.log('  wrangler secret put VAPID_PRIVATE_KEY --config workers/notifier-gate/wrangler.jsonc');
console.log('  wrangler secret put VAPID_PUBLIC_KEY  --config workers/notifier-gate/wrangler.jsonc');
