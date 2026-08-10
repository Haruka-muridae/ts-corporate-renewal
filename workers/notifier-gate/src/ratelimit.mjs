/**
 * レート制限（KV の固定窓カウンタ）。
 *
 * ------------------------------------------------------------------
 * 厳密さより「暴走を止めること」を優先している
 * ------------------------------------------------------------------
 * KV は結果整合であり、read → write の間に別のリージョンからの要求が
 * 入れば数え落とす。したがって「1分に2回」は上限として厳密ではない。
 *
 * それでよいと判断した理由は、ここで防ぎたいのが不正利用ではなく
 * **壊れたテンプレートや無限ループが認証系 GAS を叩き続けること**だからである。
 * 桁を1つ違える暴走は確実に止まり、境界の1回は取りこぼしてよい。
 * 厳密な制限が要る用途が出たら Durable Object へ移すこと。
 * ------------------------------------------------------------------
 */

/**
 * 1回消費する。戻り値は { allowed, count }。
 *
 * bucket は「窓の開始時刻」で、これをキーへ含めることで期限切れの
 * 数え直しが自動的に起きる（TTL に頼らず、値の側で窓を区切る）。
 */
export async function consumeRateLimit({ kv, scope, hash, limit, windowSec, nowMs }) {
  if (!kv) {
    /* KV が無い環境（テストの一部）では素通しにする。判定の本筋ではない。 */
    return { allowed: true, count: 0 };
  }

  const bucket = Math.floor(nowMs / (windowSec * 1000));
  const key = `rl:${scope}:${hash}:${bucket}`;

  let count = 0;

  try {
    const raw = await kv.get(key);
    count = Number(raw) || 0;
  } catch {
    /* 読めないときは通す。制限のために本来の機能を止めない。 */
    return { allowed: true, count: 0 };
  }

  if (count >= limit) {
    return { allowed: false, count };
  }

  try {
    /* TTL は窓の2倍。窓の終わり際に書いた値がすぐ消えないようにする。 */
    await kv.put(key, String(count + 1), { expirationTtl: Math.max(60, windowSec * 2) });
  } catch {
    /* 書けなくても通す（上と同じ理由）。 */
  }

  return { allowed: true, count: count + 1 };
}
