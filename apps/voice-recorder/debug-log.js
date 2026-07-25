/*
 * 開発者向けデバッグログ。
 *
 * 既定では何も出力しない（本番で常時大量のログを出さないため）。
 * 次のいずれかで有効化する。
 *   - URL に ?debug=1 を付ける（モバイルでの調査に便利）
 *   - window.__TSAM_VR_DEBUG__ = true をコンソールで設定する
 *
 * ------------------------------------------------------------------
 * 絶対にログへ出してはならないもの（呼び出し側の責任）
 *   アクセストークン / IDトークン / Authorization ヘッダー /
 *   メールアドレス / 録音内容 / OAuthレスポンス全体
 * 出してよいもの
 *   ライフサイクルイベント名 / トークンの有無・期限判定 /
 *   認証や送信の開始・成功・キャンセル・失敗 / 401再試行の有無 /
 *   Blob・File の有無・サイズ・MIME / OPFSファイルの有無
 * ------------------------------------------------------------------
 *
 * この方針を守るため、logger には生の値ではなく要約だけを渡すこと。
 * localStorage / sessionStorage などのストレージには一切書かない。
 */

let cached = null;

export function isDebugEnabled() {
  if (cached !== null) {
    return cached;
  }

  cached = false;

  try {
    if (typeof window !== 'undefined') {
      if (window.__TSAM_VR_DEBUG__ === true) {
        cached = true;
      } else {
        const search = window.location?.search ?? '';
        if (new URLSearchParams(search).get('debug') === '1') {
          cached = true;
        }
      }
    }
  } catch {
    /* location が読めない等。無効のままにする。 */
  }

  return cached;
}

/* 有効時のみ console.debug へ出す。data には要約だけを渡すこと。 */
export function debugLog(event, data) {
  if (!isDebugEnabled()) {
    return;
  }

  try {
    if (data === undefined) {
      console.debug(`[vr-drive] ${event}`);
    } else {
      console.debug(`[vr-drive] ${event}`, data);
    }
  } catch {
    /* console が使えない環境。無視する。 */
  }
}

/*
 * Blob / File を、内容を含めずに要約する。
 * サイズと MIME タイプだけを出し、中身（録音音声）は出さない。
 */
export function describeBlob(blob) {
  if (!blob) {
    return { present: false };
  }

  return {
    present: true,
    size: typeof blob.size === 'number' ? blob.size : null,
    type: blob.type || null,
  };
}
