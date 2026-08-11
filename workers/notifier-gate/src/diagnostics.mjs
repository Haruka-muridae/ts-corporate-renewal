/**
 * 失敗したときに何が起きたかを、運用者だけが読める形で残す。
 *
 * ==================================================================
 * 「要約1行」では足りなかった
 * ==================================================================
 * 当初は `notifier-gate error: <path>` の1行しか出していなかった。
 * 内部情報を返さない方針を、**ログにも適用してしまっていた**のが誤りである。
 *
 * 応答本文と実行ログでは、読む相手が違う。
 *   応答  … 誰でも受け取れる。定型文だけを返す（いまのまま）
 *   ログ  … `wrangler tail` を叩ける運用者だけが読む
 *
 * 実機で /v1/vapid が 500 になったとき、例外の種類も発生箇所も分からず、
 * 切り分けが完全に止まった（2026-08-11）。ログには残す。
 * ==================================================================
 *
 * ==================================================================
 * ただし秘密は絶対に出さない
 * ==================================================================
 * 例外のメッセージには、**入力の一部がそのまま混ざることがある。**
 * たとえば JSON.parse は「位置 N の予期しないトークン」とともに
 * 入力の断片を含めることがあり、秘密鍵を JWK で渡していれば
 * 鍵の中身がログへ出る。
 *
 * そこで、既知の秘密（VAPID の鍵・共有シークレット・ライセンスキー）を
 * **書き出す直前に伏せる。** 「気をつけて書く」ではなく、通り道で落とす。
 * ==================================================================
 */

/** 伏せ字。何が伏せられたかは分かるようにする（デバッグの手掛かりを残すため）。 */
const REDACTED = '[伏せ字]';

/** ログ1行の上限。長い例外メッセージで tail を埋めない。 */
const MAX_MESSAGE_LENGTH = 300;

/**
 * 文字列から既知の秘密を伏せる。
 *
 * 短すぎる値は伏せない（偶然の一致で本文が読めなくなるため）。
 * 秘密はいずれも20文字以上あるので、これで取りこぼさない。
 */
export function redactSecrets(text, secrets) {
  let out = String(text ?? '');

  for (const secret of secrets ?? []) {
    const value = String(secret ?? '');

    if (value.length < 8) {
      continue;
    }

    out = out.split(value).join(REDACTED);
  }

  return out;
}

/** env とライセンスキーから、伏せるべき値を集める。 */
export function collectSecrets(env, licenseKey = '') {
  return [
    env?.VAPID_PRIVATE_KEY,
    env?.VAPID_PUBLIC_KEY,
    env?.AUTH_GAS_SHARED_SECRET,
    licenseKey,
  ].filter((value) => typeof value === 'string' && value !== '');
}

/**
 * 例外に「どの段階で起きたか」を付ける。
 *
 * 段階が分かれば、鍵の読み込みで落ちたのか署名で落ちたのかを
 * ログ1行で見分けられる。原因の場所が最初から絞れる。
 */
export class PhaseError extends Error {
  constructor(phase, cause) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'PhaseError';
    this.phase = phase;
    this.cause = cause;
    this.causeName = cause instanceof Error ? cause.name : 'Error';
  }
}

/**
 * 段階を付けて実行する。中で投げられた例外に段階を貼って投げ直す。
 *
 * すでに段階が付いている例外はそのまま通す（内側の、より細かい段階を残す）。
 */
export async function inPhase(phase, run) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PhaseError) {
      throw error;
    }

    throw new PhaseError(phase, error);
  }
}

/**
 * 失敗を1行で残す。**ここが唯一の書き出し口**にしてある。
 *
 * 出すもの: path / 段階 / 例外の種類 / 伏せ字済みメッセージ
 * 出さないもの: 鍵・シークレット・ライセンスキー・スタックトレース
 */
export function logFailure({ path, error, secrets }) {
  const phase = error instanceof PhaseError ? error.phase : 'unknown';
  const name = error instanceof PhaseError
    ? error.causeName
    : (error?.name ?? 'Error');
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const message = redactSecrets(raw, secrets).slice(0, MAX_MESSAGE_LENGTH);

  console.error(
    `notifier-gate error: ${path} phase=${phase} name=${name} message=${message}`,
  );

  return { phase, name, message };
}
