/*
 * 保存前の Google 認証チェックポイント（純ロジック。DOM・oauth.js の状態を持たない）。
 *
 * ------------------------------------------------------------------
 * 認証を確定するのは「Drive へ保存する直前」
 * ------------------------------------------------------------------
 * 録音開始時には Google 連携を求めない。録音は端末（OPFS）へ確定してから、
 * Drive へ上げる直前にトークンを見る。
 *
 *   有効で、残り時間が SAVE_TOKEN_MIN_SECONDS 以上 … そのまま保存へ
 *   それ以外（未連携・期限切れ・残りが足りない）    … 利用者の押下で連携を更新してから保存
 *
 * 「残り時間」を見るのは、Drive へのアップロード → Gemini → Markdown 保存
 * まで同じトークンで通すため。90 分の録音（約 86MB）のアップロードと文字起こしに
 * 数分かかることがあり、境目で 401 を踏むと Gemini をやり直す羽目になる。
 *
 * 暗黙フロー（refresh token 無し）なので、更新は必ず利用者の操作を伴う。
 * 将来 Authorization Code Flow + PKCE + サーバー側 refresh token に移行しても、
 * この判定（有効か・十分か）はそのまま使える。
 * ------------------------------------------------------------------
 */

export const AuthCheck = Object.freeze({
  OK: 'ok',
  NEVER_LINKED: 'never-linked',
  EXPIRED: 'expired',
  INSUFFICIENT: 'insufficient',
});

/*
 * 引数:
 *   valid            … いま有効なトークンがあるか（oauth.js の hasValidToken）
 *   remainingSeconds … 残り秒数（oauth.js の tokenRemainingSeconds）
 *   everLinked       … このページで一度でも連携したか（期限切れと未連携を分けて案内する）
 *   minSeconds       … 保存に必要とみなす残り秒数（config.js の SAVE_TOKEN_MIN_SECONDS）
 *
 * 戻り値: { status, needsUserAction }
 */
export function evaluateSaveAuth({
  valid = false,
  remainingSeconds = 0,
  everLinked = false,
  minSeconds = 0,
} = {}) {
  const remaining = Number(remainingSeconds) || 0;
  const minimum = Math.max(0, Number(minSeconds) || 0);

  if (valid && remaining >= minimum) {
    return { status: AuthCheck.OK, needsUserAction: false };
  }

  if (valid) {
    return { status: AuthCheck.INSUFFICIENT, needsUserAction: true };
  }

  return {
    status: everLinked ? AuthCheck.EXPIRED : AuthCheck.NEVER_LINKED,
    needsUserAction: true,
  };
}
