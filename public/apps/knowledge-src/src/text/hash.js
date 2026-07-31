/*
 * 内容ハッシュ。
 *
 * 用途は「前回と同じ内容か」の判定だけ。暗号学的な用途では使わない。
 * crypto.subtle はセキュアコンテキスト（https / localhost）でのみ使えるため、
 * 使えない環境では簡易ハッシュへフォールバックする（判定精度は落ちるが動く）。
 *
 * ウィンドウ／Worker のどちらからも呼べるよう、DOM に依存しない。
 */

const encoder = new TextEncoder();

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';

  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }

  return out;
}

/* FNV-1a 32bit。衝突しうるので、長さも併記して誤判定を減らす。 */
function fallbackHash(text) {
  let hash = 0x811c9dc5;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return `fnv1a-${hash.toString(16)}-${text.length}`;
}

export async function sha256Hex(text) {
  const source = String(text ?? '');

  if (globalThis.crypto?.subtle?.digest) {
    try {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(source));
      return `sha256-${toHex(digest)}`;
    } catch {
      /* セキュアコンテキストでない等。下のフォールバックへ。 */
    }
  }

  return fallbackHash(source);
}
