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
});

const FALLBACK = '処理に失敗しました。お手数ですが、もう一度お試しください。';

/* 例外から画面文言を作る。message は使わない（英語文が漏れるため）。 */
export function describeError(error) {
  const code = error instanceof AppError ? error.code : null;
  return (code && GUIDE[code]) || FALLBACK;
}

/* 進捗の文言（§FR-08）。段階を分けて出す。 */
export const PROGRESS = Object.freeze({
  PREPARING: '保存の準備をしています',
  RESOLVING_FOLDER: '保存先フォルダを確認しています',
  UPLOADING: 'Google Drive へアップロードしています',
  FINISHING: '保存を確定しています',
});
