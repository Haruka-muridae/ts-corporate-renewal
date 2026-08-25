/*
 * Drive 保存で使う例外と、画面へ出す文言（仕様書 §4 / §5）。
 *
 * ------------------------------------------------------------------
 * 移植元と複製の理由
 * ------------------------------------------------------------------
 * public/production-app/voice-recorder/errors.js からの複製（2026-08-19）。
 * import ではなく複製にしているのは、本番アプリ同士を相互参照しないという
 * 流儀（voice-recorder/config.js の DRIVE_NAMES コメント、
 * docs/repository-structure.md §1）による。片方を直したら、もう片方も
 * 直すか「直さない」と判断すること。
 *
 * このアプリは oauth.js / drive.js を動かすためだけにこのファイルを持つ。
 * そのため複製元から次を削っている。
 *   - MIC_DENIED / MIC_NOT_FOUND / UNSUPPORTED_SAMPLE_RATE …
 *     マイク取得と対応サンプルレートの判定は app.js 側の既存の状態機械が
 *     自前の文言で扱っており（「マイクを取得できませんでした」等）、
 *     ここへ持ってくると同じ事象の文言が2か所に増えるため。
 *   - STORAGE_LOW / STORAGE_EXHAUSTED / SIZE_LIMIT_EXCEEDED …
 *     OPFS へ書き出す長時間録音の仕組みは本アプリに無い（メモリ上で
 *     逐次エンコードする方式）。使う場所が無い。
 *   - ENCODE_FAILED / UNSUPPORTED_ENVIRONMENT …
 *     MP3 生成の失敗は WebM 安全網へ落ちるだけで、エラー表示にしない（§4）。
 *   - PORTAL_UNAUTHENTICATED / PORTAL_SESSION_EXPIRED …
 *     ポータル認証は guardPage がログイン画面への遷移まで面倒を見るため、
 *     この画面が文言を出す場面が無い。
 * 残したのは OAuth・Drive・通信のコードだけである。
 * ------------------------------------------------------------------
 *
 * 例外そのものの message は画面へ出さない。Google や DOM が返す英語文が
 * そのまま出てしまい、利用者には読めないためである。
 * 分岐に使うのは code だけにする。
 */

/* Drive 保存まわりが投げる唯一の例外。code で分岐し、message は開発者向け。 */
export class AppError extends Error {
  constructor(code, message = code, cause = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.cause = cause;
  }
}

export const ErrorCode = Object.freeze({
  /* 認証・認可 */
  OAUTH_NOT_CONFIGURED: 'OAUTH_NOT_CONFIGURED',
  OAUTH_SCRIPT_FAILED: 'OAUTH_SCRIPT_FAILED',
  OAUTH_POPUP_BLOCKED: 'OAUTH_POPUP_BLOCKED',
  OAUTH_POPUP_CLOSED: 'OAUTH_POPUP_CLOSED',
  OAUTH_EXPIRED: 'OAUTH_EXPIRED',

  /* 保存 */
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

/*
 * 画面文言。
 *
 * ------------------------------------------------------------------
 * 「次に何をすればよいか」まで書く
 * ------------------------------------------------------------------
 * このアプリでは、Drive 保存に失敗しても録音そのものは手元に残っており、
 * 「音声をダウンロード」で保存できる。**その退避手段を必ず添える**こと。
 * 保存の失敗と録音の消失は別物であり、混同させない。
 * ------------------------------------------------------------------
 */
const GUIDE = Object.freeze({
  [ErrorCode.OAUTH_NOT_CONFIGURED]:
    'Google連携の設定が未完了です。管理者にお問い合わせください。'
    + '録音は「音声をダウンロード」でこの端末へ保存できます。',
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
    'Googleとの連携が完了しませんでした。認証画面を閉じた場合は、もう一度「Googleドライブへ保存」をお試しください。'
    + `認証画面にエラーが出ていた場合は、Google Cloud Console の「承認済みの JavaScript 生成元」に ${ORIGIN} を追加してください`
    + '（追加した直後は反映まで時間がかかることがあります）。',

  [ErrorCode.OAUTH_EXPIRED]:
    'Googleの認証の有効期限が切れました。「連携しなおして保存」を押して認証してから、もう一度お試しください。',

  [ErrorCode.FOLDER_FORBIDDEN]:
    '保存先フォルダを作成または利用できませんでした。Googleドライブの空き容量と権限をご確認ください。'
    + '録音は「音声をダウンロード」でこの端末へ保存できます。',
  [ErrorCode.DRIVE_API_DISABLED]:
    'Google Drive API が有効になっていません。管理者に、Google Cloud Console で Drive API を有効にするようご依頼ください。'
    + '録音は「音声をダウンロード」でこの端末へ保存できます。',
  [ErrorCode.DRIVE_QUOTA]:
    'Googleドライブの空き容量が足りません。不要なファイルを削除してから、もう一度保存をお試しください。',
  [ErrorCode.DRIVE_RATE_LIMITED]:
    'Googleへの要求が集中しています。少し時間をおいてから、もう一度保存をお試しください。',
  [ErrorCode.UPLOAD_FAILED]:
    '保存に失敗しました。録音はこの画面に残っています。もう一度保存をお試しになるか、「音声をダウンロード」でこの端末へ保存してください。',
  [ErrorCode.NETWORK]:
    '通信が中断しました。録音はこの画面に残っています。接続を確認して、もう一度保存をお試しください。',
});

const FALLBACK =
  '保存に失敗しました。録音はこの画面に残っています。'
  + 'もう一度お試しになるか、「音声をダウンロード」でこの端末へ保存してください。';

/* 例外から画面文言を作る。message は使わない（英語文が漏れるため）。 */
export function describeError(error) {
  const code = error instanceof AppError ? error.code : null;
  return (code && GUIDE[code]) || FALLBACK;
}

/*
 * 進捗の文言。
 * 複製元（voice-recorder）の段階名をそのまま使う。同じ保存先へ同じ手順で
 * 書くため、利用者が見る言葉まで揃えておく。
 */
export const PROGRESS = Object.freeze({
  PREPARING: '保存の準備をしています',
  CONNECTING: 'Googleと連携しています',
  RESOLVING_FOLDER: '保存先フォルダを確認しています',
  UPLOADING: 'Google Drive へアップロードしています',
  FINISHING: '保存を確定しています',
});
