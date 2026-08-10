/*
 * 経路選択・解像度ネゴシエーションの純関数。
 * docs/specs/short-script-mobile-video-plan-v1.md §2.2・§3。
 *
 * WebCodecs 本体(VideoEncoder等)には触れない。呼び出し側が機能検出の
 * 結果(真偽値)や isConfigSupported 相当の関数を渡し、ここでは
 * 「その結果からどの経路・解像度を選ぶか」だけを判定する。
 * こうすることで、実ブラウザが無いテスト環境(Node)でも検証できる。
 */

export const ROUTE_FAST = 'fast';
export const ROUTE_REALTIME = 'realtime';
export const ROUTE_UNSUPPORTED = 'unsupported';

/**
 * §3の対応環境マトリクスどおりに経路を選ぶ。
 *
 * @param {object} caps
 * @param {boolean} caps.hasVideoEncoder - `'VideoEncoder' in window` 相当
 * @param {boolean} caps.aacEncodeSupported - AudioEncoder.isConfigSupported(AAC) が通ったか
 * @returns {'fast'|'realtime'|'unsupported'}
 */
export function selectRoute({ hasVideoEncoder, aacEncodeSupported }) {
  if (!hasVideoEncoder) return ROUTE_UNSUPPORTED;
  return aacEncodeSupported ? ROUTE_FAST : ROUTE_REALTIME;
}

/**
 * 解像度ネゴシエーションの候補ラダー(§2.2)。
 * 1080x1920 は PlayRes(字幕・Ken Burnsの基準)そのものなので先頭に置く。
 */
export const RESOLUTION_LADDER = [
  { width: 1080, height: 1920, label: '1080x1920' },
  { width: 720, height: 1280, label: '720x1280' },
  { width: 540, height: 960, label: '540x960' },
];

/**
 * 候補を上から順に試し、最初に通った解像度を返す。
 * どれも通らなければ null(呼び出し側は非対応案内へ倒す)。
 *
 * @param {(candidate: {width:number, height:number}) => Promise<boolean>} isSupported
 *   VideoEncoder.isConfigSupported() 相当の非同期関数。テストではスタブを渡す。
 */
export async function negotiateResolution(isSupported) {
  for (const candidate of RESOLUTION_LADDER) {
    const ok = await isSupported(candidate);
    if (ok) return candidate;
  }
  return null;
}
