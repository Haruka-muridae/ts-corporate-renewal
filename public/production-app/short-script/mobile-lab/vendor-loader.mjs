/*
 * 分割ローダー(docs/specs/short-script-mobile-video-plan-v1.md §4.2/§4.4)。
 *
 * 流れ: vendor-manifest.json を読む → 各アセットのパートを fetch(進捗つき)
 *       → ArrayBuffer 結合 → SHA-256 検証(不一致は使わない) → Cache Storage
 *       (`short-script-vendor-v1`)へ保存。2回目以降はキャッシュから。
 *
 * ------------------------------------------------------------------
 * このファイルの構成
 * ------------------------------------------------------------------
 * 前半(純関数)はブラウザ専用APIに依存せず、Node（tests/unit）からそのまま
 * import して検証できる。後半(downloadAndCacheAsset 等)は fetch/caches を
 * 使う実処理で、これらは呼び出し側（mobile-lab/app.js）が実ブラウザで
 * 動かす前提。テストは前半だけを対象にする(§6「Node で検証できるもの」)。
 * ------------------------------------------------------------------
 */

/** マニフェストの形を最小限検証し、扱いやすい形にして返す。 */
export function parseManifest(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.assets)) {
    throw new Error('vendor-manifest.json の形式が不正です(assets配列がありません)');
  }
  if (typeof json.cacheName !== 'string' || !json.cacheName) {
    throw new Error('vendor-manifest.json の形式が不正です(cacheNameがありません)');
  }
  return json;
}

/** id からアセット定義を1件探す。無ければ null。 */
export function findAsset(manifest, id) {
  return manifest.assets.find((a) => a.id === id) ?? null;
}

/** 取得可能な(unavailableでない)アセットの合計バイト数。ダウンロード見積り表示に使う。 */
export function totalDownloadBytes(manifest) {
  return manifest.assets
    .filter((a) => !a.unavailable)
    .reduce((sum, a) => sum + (a.bytes || 0), 0);
}

/** 取得不能としてマークされているアセットの一覧(理由つき)。 */
export function unavailableAssets(manifest) {
  return manifest.assets.filter((a) => a.unavailable);
}

/** バイト数を「約XX MB」形式にする。表示用。 */
export function formatMegabytes(bytes) {
  const mb = bytes / (1024 * 1024);
  // 小数第1位まで。100MB以上は整数に丸める(表示の桁が揺れすぎないように)。
  const digits = mb >= 100 ? 0 : 1;
  return `${mb.toFixed(digits)}MB`;
}

/**
 * 複数の ArrayBuffer/Uint8Array を1本の Uint8Array へ結合する。
 * パートが1つ(分割なし)でも同じ経路を通ることで、呼び出し側の分岐を減らす。
 */
export function combineParts(buffers) {
  const chunks = buffers.map((b) => (b instanceof Uint8Array ? b : new Uint8Array(b)));
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/** Uint8Array を16進のSHA-256文字列にする。Node・ブラウザ双方の crypto.subtle で動く。 */
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 結合済みバイト列がマニフェストの期待値と一致するか検証する。
 * 不一致のときは例外を投げる(§4.2「SHA-256が合わないアセットは使わない」)。
 */
export async function verifyAsset(asset, combinedBytes) {
  if (combinedBytes.byteLength !== asset.bytes) {
    throw new Error(
      `${asset.id}: サイズが一致しません(期待 ${asset.bytes}、実際 ${combinedBytes.byteLength})`
    );
  }
  const actual = await sha256Hex(combinedBytes);
  if (actual !== asset.sha256) {
    throw new Error(
      `${asset.id}: SHA-256が一致しません(期待 ${asset.sha256}、実際 ${actual})。` +
        'ダウンロードが壊れています。作り直しません。'
    );
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* ここから先はブラウザ専用API(fetch のストリーム読み取り・Cache Storage)を使う。 */
/* ------------------------------------------------------------------ */

/**
 * 1パートを進捗つきで取得する。
 * onProgress は { loadedBytes } を都度受け取る(パート単位の累計ではなく、
 * このパート内での読み取り累計)。
 */
async function fetchPartWithProgress(url, onProgress, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`${url} の取得に失敗しました(${response.status})`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    // ReadableStreamが使えない環境向けの保険。進捗は出さずそのまま返す。
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (onProgress) onProgress({ loadedBytes: loaded });
  }
  return combineParts(chunks);
}

/**
 * 1アセット分を「パート取得→結合→SHA-256検証→Cache Storageへ保存」まで行う。
 *
 * @param {object} asset - manifest.assets の1件
 * @param {string} baseUrl - vendor/ ディレクトリの絶対URL(末尾スラッシュ)
 * @param {string} virtualUrl - Cache Storage に保存するキー(実URLでも仮想URLでも良い)
 * @param {Cache} cache - caches.open() 済みの Cache
 * @param {(info:{assetId:string, loadedBytes:number, totalBytes:number})=>void} onProgress
 * @param {typeof fetch} fetchImpl - 差し替え可能にしてテスト・フォールバックをしやすくする
 */
export async function downloadAndCacheAsset({ asset, baseUrl, virtualUrl, cache, onProgress, fetchImpl = fetch }) {
  if (asset.unavailable) {
    throw new Error(`${asset.id} は同梱されていません(${asset.reason || '理由不明'})`);
  }

  const cached = await cache.match(virtualUrl);
  if (cached) {
    // 既に検証済みのものをそのまま使う(2回目以降はネットワークへ行かない)。
    return cached;
  }

  let loadedSoFar = 0;
  const partBuffers = [];
  for (const part of asset.parts) {
    const partUrl = new URL(part.path, baseUrl).toString();
    const partBaseline = loadedSoFar;
    const bytes = await fetchPartWithProgress(
      partUrl,
      ({ loadedBytes }) => {
        if (onProgress) {
          onProgress({ assetId: asset.id, loadedBytes: partBaseline + loadedBytes, totalBytes: asset.bytes });
        }
      },
      fetchImpl
    );
    partBuffers.push(bytes);
    loadedSoFar += bytes.byteLength;
  }

  const combined = combineParts(partBuffers);
  await verifyAsset(asset, combined);

  const response = new Response(combined, { headers: { 'Content-Length': String(combined.byteLength) } });
  await cache.put(virtualUrl, response.clone());
  return response;
}

/**
 * マニフェストの全アセット(取得不能なものを除く)を、進捗つきで順に用意する。
 * 直列で行う理由: 同時多重fetchは進捗表示が合成しにくく、モバイル回線での
 * 帯域の奪い合いも避けたい(体感速度より「壊れない・分かりやすい」を優先)。
 */
export async function prepareAllAssets({ manifest, baseUrl, cache, onProgress, fetchImpl = fetch }) {
  const results = {};
  for (const asset of manifest.assets) {
    if (asset.unavailable) continue;
    const virtualUrl = new URL(asset.path, baseUrl).toString();
    results[asset.id] = await downloadAndCacheAsset({
      asset,
      baseUrl,
      virtualUrl,
      cache,
      onProgress,
      fetchImpl,
    });
  }
  return results;
}
