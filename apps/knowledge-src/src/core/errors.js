/*
 * エラーコードと利用者向け日本語メッセージ。
 *
 * 方針:
 *   - 画面に出すのは「日本語の要約」と「次にすべきこと」だけ。
 *   - スタックトレース、APIの生レスポンス、トークン等は画面に出さない。
 *     それらは logger.js の開発者向けログ（エラーログ画面／console）へ回す。
 */

export const ErrorCode = Object.freeze({
  /* 設定 */
  CLIENT_ID_MISSING: 'CLIENT_ID_MISSING',
  PICKER_KEY_MISSING: 'PICKER_KEY_MISSING',

  /* 認証・認可 */
  GIS_LOAD_FAILED: 'GIS_LOAD_FAILED',
  AUTH_POPUP_CLOSED: 'AUTH_POPUP_CLOSED',
  AUTH_POPUP_BLOCKED: 'AUTH_POPUP_BLOCKED',
  AUTH_ACCESS_DENIED: 'AUTH_ACCESS_DENIED',
  AUTH_SCOPE_NOT_GRANTED: 'AUTH_SCOPE_NOT_GRANTED',
  AUTH_FAILED: 'AUTH_FAILED',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  AUTH_TIMEOUT: 'AUTH_TIMEOUT',

  /* Drive API */
  DRIVE_API_ERROR: 'DRIVE_API_ERROR',
  DRIVE_API_DISABLED: 'DRIVE_API_DISABLED',
  DRIVE_PERMISSION_DENIED: 'DRIVE_PERMISSION_DENIED',
  DRIVE_RATE_LIMIT: 'DRIVE_RATE_LIMIT',
  DRIVE_NOT_FOUND: 'DRIVE_NOT_FOUND',
  DRIVE_FETCH_FAILED: 'DRIVE_FETCH_FAILED',
  DRIVE_EXPORT_TOO_LARGE: 'DRIVE_EXPORT_TOO_LARGE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVER_ERROR: 'SERVER_ERROR',

  /* 解析 */
  PDF_PARSE_FAILED: 'PDF_PARSE_FAILED',
  PDF_ENCRYPTED: 'PDF_ENCRYPTED',
  DOCX_PARSE_FAILED: 'DOCX_PARSE_FAILED',
  TEXT_DECODE_FAILED: 'TEXT_DECODE_FAILED',
  UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  EMPTY_TEXT: 'EMPTY_TEXT',

  /* 保存 */
  DB_OPEN_FAILED: 'DB_OPEN_FAILED',
  DB_QUOTA_EXCEEDED: 'DB_QUOTA_EXCEEDED',
  DB_WRITE_FAILED: 'DB_WRITE_FAILED',

  /* Worker */
  WORKER_CRASHED: 'WORKER_CRASHED',
  WORKER_TIMEOUT: 'WORKER_TIMEOUT',

  /* 検索 */
  INDEX_BUILD_FAILED: 'INDEX_BUILD_FAILED',
  SEARCH_FAILED: 'SEARCH_FAILED',

  /* 将来拡張 */
  WEBGPU_UNSUPPORTED: 'WEBGPU_UNSUPPORTED',

  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
});

const MESSAGES = Object.freeze({
  [ErrorCode.CLIENT_ID_MISSING]: {
    title: 'Googleログインは現在準備中です。',
    hint: '管理者にOAuthクライアントIDの設定をご確認ください。',
  },
  [ErrorCode.PICKER_KEY_MISSING]: {
    title: 'フォルダ選択ダイアログを利用できません。',
    hint: 'APIキーが未設定のため、一覧から選ぶ方式に切り替えます。',
  },

  [ErrorCode.GIS_LOAD_FAILED]: {
    title: 'Googleの認証機能を読み込めませんでした。',
    hint: 'ネットワーク接続、拡張機能によるブロックをご確認のうえ、再度お試しください。',
  },
  [ErrorCode.AUTH_POPUP_CLOSED]: {
    title: '認証画面が閉じられたため、処理を中止しました。',
    hint: 'もう一度お試しください。',
  },
  [ErrorCode.AUTH_POPUP_BLOCKED]: {
    title: '認証画面を開けませんでした。',
    hint: 'ブラウザのポップアップブロックを解除してください。',
  },
  [ErrorCode.AUTH_ACCESS_DENIED]: {
    title: 'Googleアカウントへのアクセスが許可されませんでした。',
    hint: '同意画面で「許可」を選んでください。テスト公開中の場合はテストユーザー登録が必要です。',
  },
  [ErrorCode.AUTH_SCOPE_NOT_GRANTED]: {
    title: 'Google Driveの読み取り権限が許可されませんでした。',
    hint: '同意画面でDriveのチェックを外さずに「許可」を選んでください。',
  },
  [ErrorCode.AUTH_FAILED]: {
    title: 'Google認証に失敗しました。',
    hint: '時間をおいて、もう一度お試しください。',
  },
  [ErrorCode.AUTH_EXPIRED]: {
    title: '認証の有効期限が切れました。',
    hint: 'もう一度ログインしてください。',
  },
  [ErrorCode.AUTH_TIMEOUT]: {
    title: '認証の応答がありませんでした。',
    hint: '認証画面が開いたままになっていないかご確認のうえ、もう一度お試しください。',
  },

  [ErrorCode.DRIVE_API_ERROR]: {
    title: 'Google Driveの操作に失敗しました。',
    hint: '時間をおいて、もう一度お試しください。',
  },
  [ErrorCode.DRIVE_API_DISABLED]: {
    title: 'Google Drive APIが有効になっていません。',
    hint: '管理者にGoogle Cloud側の設定をご確認ください。',
  },
  [ErrorCode.DRIVE_PERMISSION_DENIED]: {
    title: 'このフォルダまたはファイルを参照する権限がありません。',
    hint: 'Drive上で閲覧権限が付与されているかご確認ください。',
  },
  [ErrorCode.DRIVE_RATE_LIMIT]: {
    title: 'Google Drive APIの利用上限に達しました。',
    hint: 'しばらく時間をおいてから、再度同期してください。',
  },
  [ErrorCode.DRIVE_NOT_FOUND]: {
    title: '対象のファイルまたはフォルダが見つかりませんでした。',
    hint: 'Drive上で削除または移動された可能性があります。',
  },
  [ErrorCode.DRIVE_FETCH_FAILED]: {
    title: 'ファイルの取得に失敗しました。',
    hint: '再同期でやり直せます。繰り返す場合はファイル単位で除外してください。',
  },
  [ErrorCode.DRIVE_EXPORT_TOO_LARGE]: {
    title: 'Googleドキュメントの書き出しサイズが上限を超えました。',
    hint: 'ドキュメントを分割してください（Google側の10MB制限です）。',
  },
  [ErrorCode.NETWORK_ERROR]: {
    title: '通信に失敗しました。',
    hint: 'ネットワーク接続をご確認ください。',
  },
  [ErrorCode.SERVER_ERROR]: {
    title: 'Google側で問題が発生しています。',
    hint: '時間をおいて、もう一度お試しください。',
  },

  [ErrorCode.PDF_PARSE_FAILED]: {
    title: 'PDFの解析に失敗しました。',
    hint: 'ファイルが破損しているか、テキストを含まない可能性があります。',
  },
  [ErrorCode.PDF_ENCRYPTED]: {
    title: 'パスワード保護されたPDFは解析できません。',
    hint: '保護を解除したファイルをDriveへ置いてください。',
  },
  [ErrorCode.DOCX_PARSE_FAILED]: {
    title: 'DOCXの解析に失敗しました。',
    hint: '旧形式（.doc）は対象外です。DOCX形式で保存し直してください。',
  },
  [ErrorCode.TEXT_DECODE_FAILED]: {
    title: 'テキストの読み取りに失敗しました。',
    hint: 'UTF-8で保存されたファイルをご利用ください。',
  },
  [ErrorCode.UNSUPPORTED_TYPE]: {
    title: 'このファイル形式は現在の版では対象外です。',
    hint: '対応形式はGoogleドキュメント／PDF／DOCX／TXT／Markdownです。',
  },
  [ErrorCode.FILE_TOO_LARGE]: {
    title: 'ファイルサイズが上限を超えています。',
    hint: '設定画面で上限を変更するか、ファイルを分割してください。',
  },
  [ErrorCode.EMPTY_TEXT]: {
    title: '抽出できるテキストがありませんでした。',
    hint: '画像のみのPDFなどが考えられます（OCRは現在の版では対象外です）。',
  },

  [ErrorCode.DB_OPEN_FAILED]: {
    title: 'ブラウザ内データベースを開けませんでした。',
    hint: 'プライベートモードや、サイトデータのブロック設定をご確認ください。',
  },
  [ErrorCode.DB_QUOTA_EXCEEDED]: {
    title: 'ブラウザの保存容量が不足しています。',
    hint: 'ストレージ画面から不要なファイルのキャッシュを削除してください。',
  },
  [ErrorCode.DB_WRITE_FAILED]: {
    title: 'ブラウザ内データベースへの保存に失敗しました。',
    hint: '再同期でやり直せます。繰り返す場合は全キャッシュ削除をお試しください。',
  },

  [ErrorCode.WORKER_CRASHED]: {
    title: 'バックグラウンド処理が異常終了しました。',
    hint: 'ページを再読み込みしてから、再同期してください。',
  },
  [ErrorCode.WORKER_TIMEOUT]: {
    title: 'バックグラウンド処理が時間内に終わりませんでした。',
    hint: 'ファイルサイズが大きすぎる可能性があります。',
  },

  [ErrorCode.INDEX_BUILD_FAILED]: {
    title: '検索インデックスの構築に失敗しました。',
    hint: 'ストレージ画面の「検索インデックス再構築」をお試しください。',
  },
  [ErrorCode.SEARCH_FAILED]: {
    title: '検索に失敗しました。',
    hint: '検索インデックスを再構築してください。',
  },

  [ErrorCode.WEBGPU_UNSUPPORTED]: {
    title: 'このブラウザはWebGPUに対応していません。',
    hint: '最新のChromeをご利用ください。この機能を使わなくても検索は利用できます。',
  },

  [ErrorCode.CANCELLED]: {
    title: '処理を中止しました。',
    hint: '',
  },
  [ErrorCode.UNKNOWN]: {
    title: '予期しないエラーが発生しました。',
    hint: 'エラーログ画面の内容を管理者へお知らせください。',
  },
});

export class AppError extends Error {
  /*
   * detail には利用者へ出さない補助情報だけを入れる。
   * アクセストークン・認証情報・本文全体は入れない。
   */
  constructor(code, detail = null, cause = undefined) {
    super(code);
    this.name = 'AppError';
    this.code = ErrorCode[code] ? code : ErrorCode.UNKNOWN;
    this.detail = detail;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }

  get userMessage() {
    return messageFor(this.code);
  }
}

export function messageFor(code) {
  const entry = MESSAGES[code] ?? MESSAGES[ErrorCode.UNKNOWN];
  return entry.hint ? `${entry.title} ${entry.hint}` : entry.title;
}

export function titleFor(code) {
  return (MESSAGES[code] ?? MESSAGES[ErrorCode.UNKNOWN]).title;
}

export function hintFor(code) {
  return (MESSAGES[code] ?? MESSAGES[ErrorCode.UNKNOWN]).hint;
}

/* 任意の例外を AppError へ正規化する。 */
export function toAppError(error, fallbackCode = ErrorCode.UNKNOWN) {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof DOMException) {
    if (error.name === 'QuotaExceededError') {
      return new AppError(ErrorCode.DB_QUOTA_EXCEEDED, error.name, error);
    }
    if (error.name === 'AbortError') {
      return new AppError(ErrorCode.CANCELLED, error.name, error);
    }
  }

  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return new AppError(ErrorCode.NETWORK_ERROR, error.message, error);
  }

  return new AppError(fallbackCode, error?.message ?? String(error), error);
}

/*
 * Drive API のHTTPステータスとエラーボディから、対応するコードを決める。
 * body は Google のエラーJSON（{ error: { errors: [{ reason }] } }）を想定。
 */
export function driveErrorCode(status, body) {
  const reasons = [];
  const errors = body?.error?.errors;

  if (Array.isArray(errors)) {
    errors.forEach((e) => {
      if (typeof e?.reason === 'string') {
        reasons.push(e.reason);
      }
    });
  }

  if (typeof body?.error?.status === 'string') {
    reasons.push(body.error.status);
  }

  const has = (name) => reasons.includes(name);

  if (status === 401) {
    return ErrorCode.AUTH_EXPIRED;
  }

  if (status === 403) {
    if (has('accessNotConfigured') || has('SERVICE_DISABLED')) {
      return ErrorCode.DRIVE_API_DISABLED;
    }
    if (has('rateLimitExceeded') || has('userRateLimitExceeded') || has('RESOURCE_EXHAUSTED')) {
      return ErrorCode.DRIVE_RATE_LIMIT;
    }
    if (has('exportSizeLimitExceeded')) {
      return ErrorCode.DRIVE_EXPORT_TOO_LARGE;
    }
    return ErrorCode.DRIVE_PERMISSION_DENIED;
  }

  if (status === 404) {
    return ErrorCode.DRIVE_NOT_FOUND;
  }

  if (status === 429) {
    return ErrorCode.DRIVE_RATE_LIMIT;
  }

  if (status >= 500) {
    return ErrorCode.SERVER_ERROR;
  }

  return ErrorCode.DRIVE_API_ERROR;
}
