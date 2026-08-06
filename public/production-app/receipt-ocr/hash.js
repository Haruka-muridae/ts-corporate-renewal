/*
 * 画像の SHA-256（仕様書 §5-② / §10）。
 *
 * 計算はブラウザ内（Web Crypto API）で行い、画像そのものは当社側へ送らない（§15.3）。
 * 重複判定は、この値と自シートのハッシュ列との照合だけで行う（§10）。
 */

/*
 * バイト列の SHA-256 を小文字16進で返す。
 *
 * crypto.subtle は安全なコンテキスト（HTTPS / localhost）でしか存在しない。
 * 無い環境では例外にせず null を返し、呼び出し側が重複判定を諦められるようにする
 * （重複判定ができないことと、アプリが動かないことは別である）。
 */
export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;

  if (!subtle) {
    return null;
  }

  const buffer = await subtle.digest('SHA-256', bytes);

  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/* Blob / File から直接計算する。 */
export async function sha256OfBlob(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') {
    return null;
  }

  return sha256Hex(await blob.arrayBuffer());
}

/*
 * ハッシュ列の中から完全一致を探す（§10）。
 *
 * 引数は「シートから取った1列ぶんの値」と「いま計算した値」。
 * 戻り値は 0 始まりの位置（ヘッダー行を除いた並び）で、無ければ -1。
 * 大文字小文字は無視する（手で貼り直された値が混ざりうるため）。
 */
export function findDuplicateIndex(hashColumn, hash) {
  const target = String(hash ?? '').trim().toLowerCase();

  if (target === '') {
    return -1;
  }

  const list = Array.isArray(hashColumn) ? hashColumn : [];

  return list.findIndex((value) => String(value ?? '').trim().toLowerCase() === target);
}
