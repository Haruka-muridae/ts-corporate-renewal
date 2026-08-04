/*
 * 画像の SHA-256（要件定義書 §11.2 の front_image_hash / back_image_hash、
 * FR-19 の同一画像判定）。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * ../receipt-ocr/hash.js（2026-08-04）。その元は
 * public/apps/card-scanner/metadata.js。**import はしない**
 * （docs/repository-structure.md §4-1）。
 *
 * 複製元から変えたところ:
 *   - 面ごとに2枚を扱うため、複数の Blob をまとめて計算する口を足した
 * ==================================================================
 *
 * crypto.subtle は**セキュアコンテキストでしか使えない。**
 * https と localhost では動くが、それ以外（file:// や生の http）では
 * undefined になる。そこで計算できない場合は null を返し、
 * **呼び出し側が「ハッシュ無し」として先へ進めるようにする。**
 * 重複判定はメール・電話でも行えるので、ここで止める必要はない。
 */

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/* 計算できる環境かどうか。画面の案内を分けるために公開する。 */
export function isHashAvailable() {
  return typeof globalThis.crypto?.subtle?.digest === 'function';
}

/*
 * ArrayBuffer から16進のハッシュを作る。
 * 計算できない環境では null を返す（例外にしない）。
 */
export async function sha256Hex(buffer) {
  if (!isHashAvailable()) {
    return null;
  }

  try {
    return toHex(await globalThis.crypto.subtle.digest('SHA-256', buffer));
  } catch {
    return null;
  }
}

/* Blob（選ばれた画像）から。 */
export async function sha256OfBlob(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') {
    return null;
  }

  return sha256Hex(await blob.arrayBuffer());
}

/*
 * 表面・裏面をまとめて計算する。
 *
 * 裏面が無ければ back は null。**「裏面が無い」と「計算できなかった」を
 * どちらも null で表すのは、台帳ではどちらも空欄になるためである。**
 * 区別が要る場面（裏面の有無）は has_back 列で表す（§11.2）。
 */
export async function hashBothSides({ front = null, back = null } = {}) {
  const [frontHash, backHash] = await Promise.all([
    sha256OfBlob(front),
    sha256OfBlob(back),
  ]);

  return { front: frontHash, back: backHash };
}
