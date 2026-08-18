/*
 * Google API への低レベル呼び出し（仕様書 §5 / §13）。
 *
 * ------------------------------------------------------------------
 * ここを通る通信の宛先は Google だけ
 * ------------------------------------------------------------------
 * §15.3 は「領収書画像・OCR文字列・抽出データ・キー・トークンが、
 * 当社ドメインへのいかなるリクエストにも含まれない」ことを求めている。
 * 宛先を1か所に集めておけば、通信内容の検証もここを読めば済む。
 *
 * アクセストークンは引数で受け取り、このモジュールに残さない。
 * 保持しているのは oauth.js のクロージャだけである（§4-2）。
 * ------------------------------------------------------------------
 *
 * 応答本文をそのまま画面へ出さないこと。
 * 外へ渡すのは HTTP ステータスと Google が返す reason だけにする（errors.js）。
 */

import { AppError, mapGoogleError } from './errors.js';

/* Google のエラー応答から reason を取り出す。無ければ空文字。 */
function reasonOf(body) {
  const errors = body?.error?.errors;

  if (Array.isArray(errors) && errors.length > 0) {
    return String(errors[0]?.reason ?? '');
  }

  return String(body?.error?.status ?? '');
}

/*
 * 認可付きで叩く。
 *
 * 成功したら JSON を返す（本文が空なら null）。
 * 失敗したら AppError を投げる。呼び出し側は code だけを見る。
 *
 * progress は「ここで失敗したとき、どこまで終わっているか」（§12）。
 */
export async function callGoogle(url, {
  accessToken,
  method = 'GET',
  headers = {},
  body = null,
  progress,
  signal,
} = {}) {
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new AppError('OAUTH-001', { progress, detail: 'no_token' });
  }

  let response;

  try {
    response = await globalThis.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...headers },
      body,
      signal,
    });
  } catch (error) {
    /*
     * 通信そのものが成立しなかった。トークンの正否は判定できない。
     * **シートの話にしない**（2026-08-18 修正。findings #5）。
     * 中断（利用者が離れた・取りやめた）は失敗と区別できるよう detail に残す。
     */
    const aborted = error?.name === 'AbortError' || signal?.aborted === true;

    throw new AppError('NET-001', { progress, detail: aborted ? 'aborted' : 'network' });
  }

  if (!response.ok) {
    let payload = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const reason = reasonOf(payload);

    /*
     * detail には**分類に使った識別子だけ**を残す。
     * reason は Google が定義した語彙（`userRateLimitExceeded` 等）であり、
     * 利用者のデータではない。error.message は取り込まない
     * （ファイル名などが混じりうるため。§13）。
     */
    throw new AppError(mapGoogleError(response.status, reason), {
      progress,
      detail: reason === '' ? `http_${response.status}` : `http_${response.status}_${reason}`,
    });
  }

  if (response.status === 204) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

/*
 * 本文をテキストとして受け取る呼び出し。
 * Drive の export（text/plain）だけがこれを使う。
 */
export async function callGoogleText(url, { accessToken, progress, signal } = {}) {
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new AppError('OAUTH-001', { progress, detail: 'no_token' });
  }

  let response;

  try {
    response = await globalThis.fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    });
  } catch (error) {
    const aborted = error?.name === 'AbortError' || signal?.aborted === true;

    throw new AppError('NET-001', { progress, detail: aborted ? 'aborted' : 'network' });
  }

  if (!response.ok) {
    /*
     * export はエラー時も JSON を返すが、本文の読み取りに失敗しても
     * ステータスだけで分類できるようにしてある（reason は空でよい）。
     */
    throw new AppError(mapGoogleError(response.status, ''), {
      progress,
      detail: `http_${response.status}`,
    });
  }

  return response.text();
}

/* JSON を送る呼び出し。 */
export function callGoogleJson(url, { body, ...options } = {}) {
  return callGoogle(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    body: JSON.stringify(body ?? {}),
  });
}

/*
 * 名前検索などで使うクエリの値を包む。
 *
 * Drive の q はシングルクォート囲みの文字列を取る。
 * フォルダ名は静的設定だが、将来利用者が名前を変えられるようにしたときに
 * ここが抜けていると q が壊れるので、最初から通しておく。
 */
export function quoteDriveQueryValue(value) {
  return `'${String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
