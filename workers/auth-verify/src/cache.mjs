/*
 * 検証結果のキャッシュ（KV）。
 *
 * ==================================================================
 * 生のセッショントークンを KV へ一切残さない
 * ==================================================================
 * トークンはそれ自体が資格証明である。キー名にも値にも入れない。
 * キーは SHA-256（16進）にする。notifier-gate の licenseCacheKey と
 * 同じ考え方（あちらはライセンスキー、こちらはセッショントークン）。
 *
 * ダッシュボードから KV を覗ける運用者に見えるのは、
 * 「あるハッシュに対して、この公開ユーザー情報が有効だった」までとする。
 * ==================================================================
 */

import { RECORD_TTL_SECONDS } from './constants.mjs';

/* トークンの SHA-256（16進）。 */
export async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/*
 * KV のキー。
 * 接頭辞を付けるのは、将来この namespace を他の用途と共有したときに
 * 衝突させないため（notifier-gate の checkout_count_ と同じ流儀）。
 */
export function cacheKey(hash) {
  return `vs_${hash}`;
}

/*
 * 記録を読む。
 * 壊れた値・古い形式は「無かったこと」にする（例外にしない）。
 * KV 自体が使えないときも null を返し、呼び出し側は GAS へ直行する。
 */
export async function readRecord(kv, key) {
  if (!kv) {
    return null;
  }

  try {
    const raw = await kv.get(key);

    if (typeof raw !== 'string' || raw === '') {
      return null;
    }

    const record = JSON.parse(raw);

    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

/*
 * 記録を書く。
 *
 * 失敗しても呼び出し側の処理は止めない（遅くなるだけで、判定は正しい）。
 * KV の書き込みは無料枠が 1,000/日と小さいため、呼ぶ場所を絞ること。
 * いま呼んでいるのは「GAS へ実際に照会した直後」だけ。
 */
export async function writeRecord(kv, key, record) {
  if (!kv) {
    return false;
  }

  try {
    await kv.put(key, JSON.stringify(record), { expirationTtl: RECORD_TTL_SECONDS });
    return true;
  } catch {
    return false;
  }
}
