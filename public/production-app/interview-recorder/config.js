/*
 * 面談録音アプリ（本番）の設定値。
 *
 * 移植元: スタンドアロン版 interview-recorder リポジトリ
 * （/home/yuki9/projects/interview-recorder/public/app.js 冒頭の定数）。
 * 移植日 2026-08-18。
 *
 * app.js に直接埋め込まれていた定数をここへ集約した。
 *
 * v1.1（2026-08-19）で Google Drive 保存を追加し、保存形式をブラウザ録音アプリ
 * （production-app/voice-recorder/）へ揃えた。OAuth / DRIVE_NAMES / ファイル名の
 * 各定義は voice-recorder/config.js からの複製である（仕様書 §4 / §5）。
 *
 * ------------------------------------------------------------------
 * ここに秘密情報を入れないこと
 * ------------------------------------------------------------------
 * OAuth のアクセストークンはメモリだけで扱う（oauth.js）。
 * client secret / refresh token / APIキーは使わない。
 * 静的サイトへ配信されるファイルであり、書けば公開されるためである。
 *
 * OAuth クライアントIDは秘密ではない（ブラウザへ配信される公開値）。
 * 実質的な防御は Google Cloud 側の「承認済みの JavaScript 生成元」である。
 * ------------------------------------------------------------------
 */

/* サイトのルートから見た、このアプリの深さ（production-app/interview-recorder/ → 2）。 */
export const SCREEN_DEPTH = 2;

/*
 * MP3 エンコードのビットレート（kbps）。lamejs の Mp3Encoder へそのまま渡す。
 *
 * v1.0 は移植元と同じ 64kbps だったが、v1.1 で 128kbps へ引き上げた。
 * 同じ Drive フォルダへブラウザ録音アプリ（voice-recorder、§FR-06 で
 * モノラル128kbps）と並べて置くため、音質と1分あたりの容量を揃える
 * （揃えないと、同じフォルダの MP3 なのに音質が2種類混在し、
 * 文字起こしアプリ側の品質も録音元によって変わることになる）。
 *
 * チャンネル数は app.js の `new lamejs.Mp3Encoder(1, ...)` でモノラル固定。
 * ミックス済みの音声を pcm-capture-worklet.js が1チャンネルで渡すため、
 * ここを2にしてはならない。
 */
export const MP3_BITRATE_KBPS = 128;

/*
 * Google OAuth（voice-recorder/config.js の OAUTH からの複製）。
 *
 * **スコープは drive.file のみ。増やしてはならない。**
 * drive / drive.readonly を足すと利用者のドライブ全体が見える状態になる。
 * drive.file は「このアプリが作成した／利用者が明示的に開いたファイル」だけに届く。
 *
 * クライアントIDを voice-recorder と同一にしているのは意図的である。
 * drive.file はクライアントIDごとに見える範囲が分かれるため、IDを変えると
 * **同じ「Voice Recorder」フォルダを名前で探しても見つからず、別フォルダを
 * 新規作成してしまう**（card-mail と card-ocr が同じIDを共用しているのと同じ理由）。
 *
 * client secret はここへ貼らないこと（暗黙フローでは不要）。
 */
export const OAUTH = Object.freeze({
  clientId: '603018562548-j2he1aeo96p2igqfk65gaevj55pdaikc.apps.googleusercontent.com',
  scope: 'https://www.googleapis.com/auth/drive.file',
});

export function isOauthConfigured(clientId = OAUTH.clientId) {
  return typeof clientId === 'string' && clientId.trim().endsWith('.apps.googleusercontent.com');
}

/*
 * 保存先の名前（仕様書 §4。voice-recorder/config.js の DRIVE_NAMES からの複製）。
 *
 * ------------------------------------------------------------------
 * フォルダIDをここへ書かないこと
 * ------------------------------------------------------------------
 * フォルダIDは利用者ごとに異なる。固定値として書くと、他の利用者の
 * ドライブでは存在しないIDを参照することになり、必ず失敗する。
 * IDは毎回「名前と親の関係」から解決する（drive.js）。
 *
 * この名前はブラウザ録音アプリ（voice-recorder）が書き、音声文字起こし
 * アプリ（audio-transcriber）が読みに来る場所そのものである。
 * **3アプリのうち1つだけ変えないこと。**
 * 複製であって import ではないのは、本番アプリ間で相互参照しないという
 * 流儀（voice-recorder / audio-transcriber の同コメントを参照）による。
 * ------------------------------------------------------------------
 */
export const DRIVE_NAMES = Object.freeze({
  /* マイドライブ直下に置く最上位フォルダ。 */
  root: 'TSAM AI',

  /* TSAM AI 直下。録音（MP3）の保存先。 */
  app: 'Voice Recorder',
});

/* 画面に出す「マイドライブ ＞ TSAM AI ＞ Voice Recorder」形式の表示。 */
export function formatFolderPath(...names) {
  return ['マイドライブ', ...names].join(' ＞ ');
}

/*
 * ファイル名の接尾辞と拡張子（仕様書 §4）。
 *
 * voice-recorder は `_録音`。同じフォルダへ2つのアプリが書き込むため、
 * こちらは `_面談録音` にして、フォルダの一覧で区別できるようにする
 * （例: 20260819_143000_面談録音.mp3）。日時部分の書式は共通。
 *
 * WEBM / JSON は Drive へ上げず、ローカルダウンロードにのみ使う（§5）。
 * 拡張子だけを差し替えて同じベース名を共有し、あとから対応が分かるようにする。
 */
export const FILE_NAME_SUFFIX = '_面談録音';
export const FILE_EXTENSION = '.mp3';
export const WEBM_EXTENSION = '.webm';
export const JSON_EXTENSION = '.json';
export const MP3_MIME = 'audio/mpeg';

/* Google API のエンドポイント。当社ドメインは含まれない。 */
export const GOOGLE_API = Object.freeze({
  driveFiles: 'https://www.googleapis.com/drive/v3/files',
  driveUpload: 'https://www.googleapis.com/upload/drive/v3/files',
});

/* PCM 逐次キャプチャ用の AudioWorklet のURL（index.html からの相対パス）。 */
export const MP3_WORKLET_URL = 'pcm-capture-worklet.js';

/*
 * 1152 サンプル（MP3の1フレーム）×8 ≒ 0.21秒ぶんたまるごとにエンコードする。
 * 値を大きくするとエンコード呼び出し回数が減る一方、メモリ上に溜まる
 * PCM が増える。移植元の値をそのまま踏襲する。
 */
export const PCM_FLUSH_SAMPLES = 1152 * 8;

/*
 * タブ音声・マイクをミックスする際、各ソースに掛けるゲイン。
 * 素通しで混ぜると音量が重なってクリッピング（音割れ）しやすいため、
 * それぞれ弱めてから混ぜる（移植元と同一の値）。
 */
export const MIX_SOURCE_GAIN = 0.7;
