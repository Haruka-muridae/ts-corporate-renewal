/*
 * 表示用エラーコード（仕様書 §12）。
 *
 * サーバーが存在しないため、すべてブラウザ内での表示コードである。
 * 名刺OCR v3.0 と共通の体系を用いる。
 *
 * ------------------------------------------------------------------
 * 「どこまで完了しているか」を必ず添える
 * ------------------------------------------------------------------
 * §12 の末尾が要求している。原本だけ保存されてシートに残らなかった場合、
 * それを言わないと利用者は同じ画像をもう一度上げ、原本だけが二重になる。
 * progress の既定値は null（未着手）とし、呼び出し側が段階を渡す。
 * ------------------------------------------------------------------
 *
 * キーの実値・トークン・OCR原文をここへ載せないこと。
 * 画面に出る文字列を作る場所であり、外部の応答本文をそのまま流さない。
 */

/* 処理の到達点。エラー表示に添える（§12）。 */
export const PROGRESS = Object.freeze({
  NONE: 'none',
  ORIGINAL_SAVED: 'original-saved',
  SHEET_SAVED: 'sheet-saved',
});

const PROGRESS_TEXT = Object.freeze({
  [PROGRESS.NONE]: '原本の保存前に中断したため、ドライブには何も保存されていません。',
  [PROGRESS.ORIGINAL_SAVED]: '原本画像は保存済みです。シートへのデータ保存は完了していません。',
  [PROGRESS.SHEET_SAVED]: '原本画像とシートへの保存は完了しています。',
});

/*
 * 誘導先。画面側がリンクを組み立てるための区分であり、URLはここに持たない
 * （相対パスの解決は auth/config.js の screenPath が行う）。
 */
export const GUIDE = Object.freeze({
  NONE: 'none',
  LOGIN: 'login',
  PORTAL_KEY: 'portal-key',
  REAUTH: 'reauth',
});

export const ERRORS = Object.freeze({
  'AUTH-001': {
    message: 'TSAM AI にログインしていません。ログイン画面へ移動します。',
    guide: GUIDE.LOGIN,
  },
  'OAUTH-001': {
    message: 'Google との連携が切れています。もう一度連携してください。',
    guide: GUIDE.REAUTH,
  },
  /*
   * 同意画面でスコープのチェックを外された（2026-08-18 追加）。
   *
   * OAUTH-001 と分けるのは、利用者がすべき操作が違うためである。
   * 「連携が切れた」なら押し直せば済むが、こちらは**同じ画面で
   * 同じチェックを外すと何度でも失敗する。** 外さないでほしいことを
   * 言わなければ、利用者は同じ操作を繰り返す
   * （docs/receipt-ocr-findings-20260804.md #4）。
   */
  'OAUTH-002': {
    message: 'Google ドライブへのアクセスが許可されていません。連携の画面でチェックを外さずに「続行」してください。',
    guide: GUIDE.REAUTH,
  },
  'KEY-001': {
    message: 'Gemini APIキーが設定されていません。ポータルの「APIキー」から登録してください。',
    guide: GUIDE.PORTAL_KEY,
  },
  'KEY-002': {
    message: 'Gemini APIキーが無効か、権限が足りません。ポータルでキーを確認してください。',
    guide: GUIDE.PORTAL_KEY,
  },
  'AI-002': {
    message: 'Gemini の利用上限に達しました。無料枠の場合は時間をおくか、有料枠をご検討ください。',
    guide: GUIDE.NONE,
  },
  /*
   * Gemini が 400 を返した（2026-08-18 追加）。
   *
   * **キーを疑わせない。** 400 は「送った要求の形が不正」という意味で、
   * こちら側の組み立て（responseSchema・generationConfig・モデル名）が原因である。
   * 名刺OCRのフェーズ0では、これをキーの問題として案内したために
   * 利用者がキーを作り直しても直らない状態になった
   * （docs/receipt-ocr-findings-20260804.md #3）。
   */
  'AI-003': {
    message: 'AI への送信内容に問題がありました。アプリ側の不具合の可能性があります。APIキーの再設定では直りません。',
    guide: GUIDE.NONE,
  },
  'DRV-001': {
    message: '保存先が見つかりませんでした。新しく作り直します。過去のデータは復元されません。',
    guide: GUIDE.NONE,
  },
  'DRV-002': {
    message: 'シートの列が変更されています。データを壊さないため、書き込みを停止しました。',
    guide: GUIDE.NONE,
  },
  'DRV-003': {
    message: 'Google ドライブの空き容量が足りません。整理してから、もう一度お試しください。',
    guide: GUIDE.NONE,
  },
  /*
   * ドライブ側が操作を拒んだ（2026-08-18 追加）。403 のうち容量不足でも
   * レート制限でもないもの。**OAUTH-001 と分ける。**
   *
   * 認可自体は生きているが、その操作に必要な許可が無い状態である。
   * 誘導は再連携（スコープを外している場合はこれで直る）だが、
   * 組織のポリシーで止められている場合は直らないため、その旨も書く。
   */
  'DRV-004': {
    message: 'Google ドライブへの操作が許可されませんでした。連携をやり直すか、組織の管理者にご確認ください。',
    guide: GUIDE.REAUTH,
  },
  /*
   * レート制限（2026-08-18 追加）。429 と、403 のうち rateLimitExceeded 系。
   *
   * **ここでトークンを捨ててはならない。** 待てば直る問題を
   * 「再連携しても直らない問題」に変えてしまう
   * （docs/receipt-ocr-findings-20260804.md #2）。guide は NONE。
   */
  'RATE-001': {
    message: 'Google 側の利用制限に達しました。少し時間をおいてから、もう一度お試しください。',
    guide: GUIDE.NONE,
  },
  /*
   * Google 側の一時的な障害（2026-08-18 追加）。500番台。
   * **待てば直ることが伝わる文言にする**（同 #5）。
   */
  'SRV-001': {
    message: 'Google 側で一時的なエラーが発生しています（混雑の可能性）。時間をおいてお試しください。',
    guide: GUIDE.NONE,
  },
  /*
   * 通信そのものが成立しなかった（2026-08-18 追加）。
   * 「シートへの書き込みに失敗しました」と言うべき場面ではない（同 #5）。
   */
  'NET-001': {
    message: '通信できませんでした。ネットワークの状態を確かめて、もう一度お試しください。',
    guide: GUIDE.NONE,
  },
  /*
   * こちらの要求が不正（2026-08-18 追加）。Google API の 400。
   * 利用者の操作では直らない種類なので、再試行を促さない。
   */
  'SYS-001': {
    message: 'アプリからの要求に問題がありました。繰り返す場合は、お手数ですがお問い合わせください。',
    guide: GUIDE.NONE,
  },
  'OCR-001': {
    message: '文字を読み取れませんでした。「要確認」として保存するか選んでください。',
    guide: GUIDE.NONE,
  },
  'SHEET-001': {
    message: 'シートへの書き込みに失敗しました。もう一度お試しください。',
    guide: GUIDE.NONE,
  },
  'DUP-001': {
    message: 'この画像はすでに登録されています。',
    guide: GUIDE.NONE,
  },
});

export class AppError extends Error {
  constructor(code, { progress = PROGRESS.NONE, detail = '' } = {}) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.progress = progress;
    /* 原因の分類だけを持つ。外部の応答本文をそのまま入れないこと。 */
    this.detail = detail;
  }
}

export function isKnownCode(code) {
  return Object.hasOwn(ERRORS, String(code ?? ''));
}

/*
 * 画面に出す形へ変える。
 * 未知のコードでも例外を投げず、汎用の文言へ落とす
 * （表示できないより、コードだけでも出したほうが問い合わせに答えられる）。
 */
export function describeError(code, { progress = PROGRESS.NONE } = {}) {
  const known = ERRORS[String(code ?? '')];
  const step = PROGRESS_TEXT[progress] ?? PROGRESS_TEXT[PROGRESS.NONE];

  return {
    code: isKnownCode(code) ? String(code) : 'UNKNOWN',
    message: known?.message ?? '処理を続けられませんでした。時間をおいてお試しください。',
    guide: known?.guide ?? GUIDE.NONE,
    progressText: step,
  };
}

/*
 * Google API の応答からコードを決める。
 *
 * reason は Drive / Sheets API が返す識別子（`userRateLimitExceeded` 等）で、
 * 利用者の入力ではない。応答本文そのものはここへ持ち込まない。
 *
 * ==================================================================
 * 中身の違う失敗を、1つの文言にまとめないこと（2026-08-18 改訂）
 * ==================================================================
 * 改訂前は 401 と 403 をまとめて OAUTH-001 にし、それ以外
 * （429・500番台・通信断を含む）をすべて SHEET-001 にしていた。
 *
 * 前者は**まだ有効なトークンを捨てて再連携を促す**（OAUTH-001 は
 * GUIDE.REAUTH を持ち、app.js が forgetToken() を呼ぶ）。Drive は
 * レート制限を 403 で返すため、待てば直る問題が
 * 「連携し直しても直らない問題」になっていた。
 *
 * 後者は画像アップロードの失敗でも「シートへの書き込みに失敗しました」と
 * 表示していた。名刺OCRのフェーズ0では、同種の潰し込みが原因で
 * 503（混雑）を「不明なエラー」として何時間も誤診している。
 *
 * 分ける基準は**利用者が次に何をすればよいか**に置く。
 *   待てば直る（RATE-001 / SRV-001）／通信を確かめる（NET-001）／
 *   容量を空ける（DRV-003）／連携し直す（OAUTH-001 / DRV-004）／
 *   利用者にできることが無い（SYS-001）
 * 参照: docs/receipt-ocr-findings-20260804.md #2・#5
 * ==================================================================
 */
export function mapGoogleError(status, reason = '') {
  const code = String(reason ?? '');

  if (status === 400) {
    /* こちらの組み立てが不正。利用者の操作では直らない。 */
    return 'SYS-001';
  }

  if (status === 401) {
    return 'OAUTH-001';
  }

  if (status === 403) {
    /*
     * 容量不足を先に見る。`storageQuotaExceeded` は下の `quotaExceeded` にも
     * 一致してしまうため、**順序に意味がある。**
     */
    if (/storageQuotaExceeded|insufficientStorage/i.test(code)) {
      return 'DRV-003';
    }

    /*
     * `rateLimitExceeded` は `userRateLimitExceeded` /
     * `sharingRateLimitExceeded` にも一致する。単独の `quotaExceeded` は
     * API 側のクォータであって容量ではない（容量不足は
     * `storageQuotaExceeded` として返る）。
     *
     * 改訂前の正規表現は `quotaExceeded` を容量不足側に入れており、
     * かつ `userRateLimitExceeded` には一致しなかった。
     */
    if (/rateLimitExceeded|dailyLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED/i.test(code)) {
      return 'RATE-001';
    }

    return 'DRV-004';
  }

  if (status === 404) {
    return 'DRV-001';
  }

  if (status === 429) {
    return 'RATE-001';
  }

  if (Number(status) >= 500) {
    return 'SRV-001';
  }

  /* 分類できないもの。既存の受け皿を残す（§12 SHEET-001）。 */
  return 'SHEET-001';
}
