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
 * 容量不足だけは 403 のなかで別扱いにする（§9.3 最終行 / DRV-003）。
 * reason は Drive API が返す識別子で、利用者の入力ではない。
 */
export function mapGoogleError(status, reason = '') {
  const code = String(reason ?? '');

  if (status === 401) {
    return 'OAUTH-001';
  }

  if (status === 403) {
    return /storageQuotaExceeded|insufficientStorage|quotaExceeded/i.test(code)
      ? 'DRV-003'
      : 'OAUTH-001';
  }

  if (status === 404) {
    return 'DRV-001';
  }

  return 'SHEET-001';
}
