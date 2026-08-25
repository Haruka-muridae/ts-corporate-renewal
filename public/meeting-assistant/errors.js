/*
 * 画面へ出す文言（要件書 §9）。
 *
 * ------------------------------------------------------------------
 * 「次に何をすればよいか」まで書く
 * ------------------------------------------------------------------
 * §9 は「各エラーは利用者が次の操作を判断できる文言とする」と定めている。
 * 原因だけを書いて終わらせないこと。
 *   ×「マイクを利用できません」
 *   ○「マイクを利用できません。ブラウザのアドレスバーの
 *      アイコンからマイクの使用を許可して、もう一度お試しください。」
 * ------------------------------------------------------------------
 *
 * 例外そのものの message は画面へ出さない。Google や DOM が返す英語文が
 * そのまま出てしまい、利用者には読めないためである。
 * 分岐に使うのは code だけにする。
 */

import { redirectUri } from './platform.js';

/* このアプリが投げる唯一の例外。code で分岐し、message は開発者向け。 */
export class AppError extends Error {
  constructor(code, message = code, cause = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.cause = cause;
  }
}

/*
 * エラーコード。
 * 画面文言は GUIDE 側に持ち、ここには識別子だけを置く。
 */
export const ErrorCode = Object.freeze({
  /* 認証・認可（§9） */
  PORTAL_UNAUTHENTICATED: 'PORTAL_UNAUTHENTICATED',
  PORTAL_SESSION_EXPIRED: 'PORTAL_SESSION_EXPIRED',
  OAUTH_NOT_CONFIGURED: 'OAUTH_NOT_CONFIGURED',
  OAUTH_SCRIPT_FAILED: 'OAUTH_SCRIPT_FAILED',
  OAUTH_POPUP_BLOCKED: 'OAUTH_POPUP_BLOCKED',
  OAUTH_POPUP_CLOSED: 'OAUTH_POPUP_CLOSED',
  OAUTH_EXPIRED: 'OAUTH_EXPIRED',
  OAUTH_REDIRECT_FAILED: 'OAUTH_REDIRECT_FAILED',
  OAUTH_STATE_MISMATCH: 'OAUTH_STATE_MISMATCH',
  /* 利用者の操作なしにはポップアップを開けない（ブロックではない）。ボタンの押下で再開する */
  OAUTH_USER_ACTION_REQUIRED: 'OAUTH_USER_ACTION_REQUIRED',

  /* 端末・マイク（§FR-04） */
  UNSUPPORTED_ENVIRONMENT: 'UNSUPPORTED_ENVIRONMENT',
  MIC_DENIED: 'MIC_DENIED',
  MIC_NOT_FOUND: 'MIC_NOT_FOUND',
  UNSUPPORTED_SAMPLE_RATE: 'UNSUPPORTED_SAMPLE_RATE',

  /* 容量・録音（§8.2） */
  STORAGE_LOW: 'STORAGE_LOW',
  STORAGE_EXHAUSTED: 'STORAGE_EXHAUSTED',
  ENCODE_FAILED: 'ENCODE_FAILED',
  SIZE_LIMIT_EXCEEDED: 'SIZE_LIMIT_EXCEEDED',

  /* 保存（§FR-03 / §FR-08） */
  FOLDER_FORBIDDEN: 'FOLDER_FORBIDDEN',
  DRIVE_API_DISABLED: 'DRIVE_API_DISABLED',
  DRIVE_QUOTA: 'DRIVE_QUOTA',
  DRIVE_RATE_LIMITED: 'DRIVE_RATE_LIMITED',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  NETWORK: 'NETWORK',
  /* Drive 保存済みなのに端末の録音が見つからない（議事録は Drive の一覧から作れる） */
  LOCAL_FILE_MISSING_DRIVE_SAVED: 'LOCAL_FILE_MISSING_DRIVE_SAVED',
  /* 保存先フォルダの検索・作成に失敗した（録音は端末に残っている） */
  DRIVE_FOLDER_UNAVAILABLE: 'DRIVE_FOLDER_UNAVAILABLE',
});

/*
 * 現在のオリジン。Google Cloud Console の「承認済みの JavaScript 生成元」に
 * 何を登録すべきかを、利用者が読める形で示すために使う。
 * 推測した固定文字列ではなく、実際に開いているオリジンを出す。
 */
const ORIGIN = globalThis.location?.origin ?? '（現在のURLのオリジン）';
const REDIRECT_URI = globalThis.location ? redirectUri(globalThis.location) : '（このアプリのURL）';

/*
 * 画面文言。
 * 未知のコードにも必ず何か出す（黙って失敗するより、再試行を促すほうがよい）。
 */
const GUIDE = Object.freeze({
  [ErrorCode.PORTAL_UNAUTHENTICATED]:
    'TSAM AIポータルからログインしてください。',
  [ErrorCode.PORTAL_SESSION_EXPIRED]:
    'セッションの有効期限が切れました。ポータルから再度アクセスしてください。',
  [ErrorCode.OAUTH_NOT_CONFIGURED]:
    'Google連携の設定が未完了です。管理者にお問い合わせください。',
  [ErrorCode.OAUTH_SCRIPT_FAILED]:
    'Googleの認証機能を読み込めませんでした。ネットワーク接続を確認して、もう一度お試しください。',
  [ErrorCode.OAUTH_POPUP_BLOCKED]:
    'Googleの認証画面を開けませんでした。ブラウザのポップアップブロックを解除して、もう一度お試しください。',

  /*
   * ここに2つの原因が同居している（oauth.js の toErrorCode を参照）。
   * オリジン未登録のとき、Google はポップアップの中で 400 を出すだけで、
   * こちらのコールバックには「閉じられた」としか伝わらない。
   * 見分けられない以上、両方を案内して利用者が次を選べるようにする。
   */
  [ErrorCode.OAUTH_POPUP_CLOSED]:
    'Googleとの連携が完了しませんでした。認証画面を閉じた場合は、もう一度「連携する」をお試しください。'
    + `認証画面にエラーが出ていた場合は、Google Cloud Console の「承認済みの JavaScript 生成元」に ${ORIGIN} を追加してください`
    + '（追加した直後は反映まで時間がかかることがあります）。',

  /*
   * 押すべきボタンの名前を、画面に実際に出ているものと揃える。
   * 保存中に期限切れになった場合は「連携しなおす」が再試行導線として出る（app.js）。
   */
  [ErrorCode.OAUTH_EXPIRED]:
    'Googleの認証の有効期限が切れました。「連携しなおす」を押して認証してから、もう一度保存をお試しください。',

  /*
   * リダイレクト方式（standalone PWA）。戻り先 URL が未登録だと Google 側で
   * エラー画面になり、こちらには「戻ってこない」か error だけが返る。
   */
  [ErrorCode.OAUTH_REDIRECT_FAILED]:
    'Googleとの連携が完了しませんでした。もう一度「連携する」をお試しください。'
    + `Google 側にエラーが出ていた場合は、Google Cloud Console の「承認済みのリダイレクト URI」に ${REDIRECT_URI} を追加してください。`,
  [ErrorCode.OAUTH_USER_ACTION_REQUIRED]:
    'Google Drive との連携の更新が必要です。録音は端末に保存されています。ホームの一覧の「Driveへ保存」（または「議事録を作成」）を押すと、連携を更新して保存を続けます。',
  [ErrorCode.OAUTH_STATE_MISMATCH]:
    'Googleからの戻りを確認できませんでした（別の画面で開いた認証結果は使えません）。この画面から改めて「連携する」をお試しください。',

  [ErrorCode.UNSUPPORTED_ENVIRONMENT]:
    'お使いのブラウザではこのアプリを利用できません。パソコンの Google Chrome 最新版でお試しください。',
  [ErrorCode.MIC_DENIED]:
    'マイクの使用が許可されていません。ブラウザのアドレスバーのアイコンからマイクの使用を許可して、もう一度お試しください。',
  [ErrorCode.MIC_NOT_FOUND]:
    'マイクが見つかりません。マイクを接続してから、もう一度お試しください。',
  [ErrorCode.UNSUPPORTED_SAMPLE_RATE]:
    'お使いのマイクの設定にこのアプリが対応していません。OSのサウンド設定で44.1kHzまたは48kHzに変更してお試しください。',

  [ErrorCode.STORAGE_LOW]:
    '端末の空き容量が足りないため録音を開始できません。不要なファイルを削除してから、もう一度お試しください。',
  [ErrorCode.STORAGE_EXHAUSTED]:
    '端末の空き容量が不足したため録音を停止しました。ここまでの録音は保存できます。',
  [ErrorCode.ENCODE_FAILED]:
    '録音の処理に失敗しました。お手数ですが、録音をやり直してください。',
  [ErrorCode.SIZE_LIMIT_EXCEEDED]:
    '録音データが上限を超えています。録音を分けてお試しください。',

  [ErrorCode.FOLDER_FORBIDDEN]:
    '保存先フォルダを作成または利用できませんでした。Googleドライブの空き容量と権限をご確認ください。',
  [ErrorCode.DRIVE_API_DISABLED]:
    'Google Drive API が有効になっていません。管理者に、Google Cloud Console で Drive API を有効にするようご依頼ください。',
  [ErrorCode.DRIVE_QUOTA]:
    'Googleドライブの空き容量が足りません。不要なファイルを削除してから、もう一度保存をお試しください。',
  [ErrorCode.DRIVE_RATE_LIMITED]:
    'Googleへの要求が集中しています。少し時間をおいてから、もう一度保存をお試しください。',
  [ErrorCode.UPLOAD_FAILED]:
    '保存に失敗しました。録音は残っています。「Google Driveに保存」をもう一度お試しください。',
  [ErrorCode.NETWORK]:
    '通信が中断しました。録音は残っています。接続を確認して、もう一度保存をお試しください。',
  [ErrorCode.DRIVE_FOLDER_UNAVAILABLE]:
    'Google Driveの保存先を準備できませんでした。録音は端末に保存されています。Google Driveとの連携を確認して、もう一度お試しください。',
  [ErrorCode.LOCAL_FILE_MISSING_DRIVE_SAVED]:
    '端末に残っていた録音が見つかりませんでした。音声は Google Drive に保存済みなので、「Drive」の一覧から選んで議事録を作成してください。',
});

const FALLBACK = '処理に失敗しました。お手数ですが、もう一度お試しください。';

/* 例外から画面文言を作る。message は使わない（英語文が漏れるため）。 */
export function describeError(error) {
  const code = error instanceof AppError ? error.code : null;
  return (code && GUIDE[code]) || FALLBACK;
}

/*
 * ------------------------------------------------------------------
 * Gemini（文字起こし・議事録）の失敗
 * ------------------------------------------------------------------
 * gemini-transcriber.js と gemini-minutes.js はそれぞれ GeminiError
 * （name === 'GeminiError'、code は下記）を投げる。ここに来る時点で音声は
 * Drive に保存済みであり、利用者が次に何をすればよいかはコードごとに違う。
 * すべてを「処理に失敗しました」に潰さない（2026-08-25 の障害で、原因が
 * 通信なのかキーなのか上限なのかを利用者も開発者も判別できなかった）。
 *
 * 同じ名前のコードが別の意味で使われる点に注意:
 *   PERMISSION_DENIED … Gemini では 403（キーの権限）。録音側ではマイク拒否。
 *                       GeminiError かどうかで先に振り分ける（describeAppError）。
 *   NETWORK / UPLOAD_FAILED … AppError（Drive）にも同名がある。
 */
const GEMINI_RETRY_HINT = '音声は Google Drive に保存済みです。';

const GEMINI_GUIDE = Object.freeze({
  /* キー */
  API_KEY_MISSING: 'Gemini APIキーを設定してください。',
  KEY_MISSING: 'Gemini APIキーを設定してください。',
  API_KEY_INVALID:
    `Gemini APIキーが無効です。設定の「Gemini APIキー」を確認して登録しなおしてください。${GEMINI_RETRY_HINT}`,
  KEY_REJECTED:
    `Gemini APIキーが拒否されました（無効または権限なし）。設定の「Gemini APIキー」を確認して登録しなおしてください。${GEMINI_RETRY_HINT}`,
  PERMISSION_DENIED:
    `Gemini API の利用が許可されていません（403）。APIキーの権限と Google AI Studio の設定を確認してください。${GEMINI_RETRY_HINT}`,

  /* 利用上限 */
  QUOTA_EXCEEDED:
    `Gemini API の利用上限に達しました（429）。時間をおいてから「議事録を作成」でやり直してください。${GEMINI_RETRY_HINT}`,
  RATE_LIMITED:
    `Gemini API の利用上限に達しました（429）。時間をおいてから「議事録を作成」でやり直してください。${GEMINI_RETRY_HINT}`,

  /* モデル・入力 */
  MODEL_NOT_FOUND:
    `Gemini のモデルが利用できませんでした。管理者にお問い合わせください。${GEMINI_RETRY_HINT}`,
  AUDIO_NOT_SUPPORTED:
    `この音声形式を Gemini が受け付けませんでした。管理者にお問い合わせください。${GEMINI_RETRY_HINT}`,
  BAD_REQUEST:
    `議事録の生成要求を Gemini が受け付けませんでした（400）。もう一度「議事録を作成」をお試しください。${GEMINI_RETRY_HINT}`,
  GENERATION_FAILED:
    `文字起こしの生成に失敗しました（400）。もう一度「議事録を作成」をお試しください。${GEMINI_RETRY_HINT}`,

  /* 音声の送信・処理 */
  UPLOAD_FAILED:
    `Gemini への音声の送信に失敗しました。もう一度「議事録を作成」をお試しください。${GEMINI_RETRY_HINT}`,
  FILE_PROCESSING_FAILED:
    `Gemini が音声を処理できませんでした。もう一度「議事録を作成」をお試しください。${GEMINI_RETRY_HINT}`,
  FILE_TIMEOUT:
    `Gemini の音声処理が時間内に終わりませんでした。時間をおいてから「議事録を作成」でやり直してください。${GEMINI_RETRY_HINT}`,

  /* 結果 */
  EMPTY_RESULT:
    `文字起こしの結果が空でした。音声に発話が含まれているか確認してください。${GEMINI_RETRY_HINT}`,
  BAD_JSON:
    `議事録を正しい形式で生成できませんでした。もう一度「議事録を作成」をお試しください。${GEMINI_RETRY_HINT}`,

  /* 通信・サーバー */
  NETWORK:
    `Gemini との通信に失敗しました。接続を確認して、もう一度「議事録を作成」をお試しください。${GEMINI_RETRY_HINT}`,
  SERVER_ERROR:
    `Gemini 側でエラーが起きました。時間をおいてから「議事録を作成」でやり直してください。${GEMINI_RETRY_HINT}`,
  CANCELLED: '議事録の処理を中止しました。',
  ABORTED: '議事録の処理を中止しました。',
});

const GEMINI_FALLBACK = `文字起こし・議事録の生成に失敗しました。もう一度「議事録を作成」をお試しください。${GEMINI_RETRY_HINT}`;

export function isGeminiError(error) {
  return error?.name === 'GeminiError';
}

export function describeGeminiError(error) {
  const code = String(error?.code ?? '');
  return GEMINI_GUIDE[code] || GEMINI_FALLBACK;
}

/*
 * 画面に出す文言をあらゆる例外から決める（app.js の唯一の入口）。
 *
 * 順序に意味がある:
 *   1. AppError（Drive / OAuth / 録音の容量など）は GUIDE
 *   2. GeminiError は GEMINI_GUIDE（PERMISSION_DENIED を録音側の文言にしない）
 *   3. 残りは録音・端末（recorder.js / mix.js）のコード
 */
export function describeAppError(error) {
  if (!error) {
    return '処理に失敗しました。';
  }

  if (error instanceof AppError) {
    return describeError(error);
  }

  if (isGeminiError(error)) {
    return describeGeminiError(error);
  }

  if (error.code === 'API_KEY_MISSING' || error.code === 'KEY_MISSING') {
    return 'Gemini APIキーを設定してください。';
  }

  if (error.code === 'DISPLAY_UNSUPPORTED') {
    return 'この端末ではオンライン録音を使えません。';
  }

  if (error.name === 'NotAllowedError' || error.code === 'PERMISSION_DENIED') {
    return '録音の許可が得られませんでした。画面共有またはマイクの許可を確認してください。';
  }

  if (error.code === 'NO_DEVICE') {
    return 'マイクが見つかりません。マイクを接続してから、もう一度お試しください。';
  }

  if (error.code === 'DEVICE_BUSY') {
    return 'マイクを他のアプリが使用しています。他のアプリを閉じてから、もう一度お試しください。';
  }

  if (error.code === 'UNSUPPORTED' || error.code === 'SYNC_ACCESS_UNSUPPORTED') {
    return 'このブラウザは録音に対応していません。最新の Chrome / Safari / Edge でお試しください。';
  }

  if (error.code === 'AUDIO_SUSPENDED') {
    return '音声の取り込みを開始できませんでした。画面を一度タップしてから、もう一度「録音開始」を押してください。';
  }

  if (error.code === 'INSUFFICIENT_STORAGE') {
    return '端末の空き容量が足りないため録音を開始できません。不要なファイルを削除してから、もう一度お試しください。';
  }

  if (error.code === 'FINALIZE_FAILED' || error.code === 'ENCODE_FAILED') {
    return '録音の確定に失敗しました。録音は台帳に残っています。ホームの一覧から保存をお試しください。';
  }

  return '処理に失敗しました。もう一度お試しください。';
}

/* 進捗の文言（§FR-08）。段階を分けて出す。 */
export const PROGRESS = Object.freeze({
  PREPARING: '保存の準備をしています',
  RESOLVING_FOLDER: '保存先フォルダを確認しています',
  UPLOADING: 'Google Drive へアップロードしています',
  FINISHING: '保存を確定しています',
});
