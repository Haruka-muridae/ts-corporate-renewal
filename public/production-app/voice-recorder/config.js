/*
 * ブラウザ録音アプリの静的設定。
 * 値を書き換える場所は、このファイルの1か所だけにする。
 *
 * 要件: docs/requirements/mvp-requirements.md
 *
 * ------------------------------------------------------------------
 * ここに秘密情報を入れないこと
 * ------------------------------------------------------------------
 * OAuth のアクセストークンはメモリだけで扱う（要件書 §8.1）。
 * client secret / refresh token / APIキーは使わない。
 * 静的サイトへ配信されるファイルであり、書けば公開されるためである。
 *
 * OAuth クライアントIDは秘密ではない（ブラウザへ配信される公開値）。
 * 実質的な防御は Google Cloud 側の「承認済みの JavaScript 生成元」であり、
 * 本番オリジンと開発オリジンだけを登録すること。
 * ------------------------------------------------------------------
 */

/* サイトのルートから見た、このアプリの深さ（production-app/voice-recorder/ → 2）。 */
export const SCREEN_DEPTH = 2;

/*
 * Google OAuth（要件書 §FR-02）。
 *
 * **スコープは drive.file のみ。増やしてはならない。**
 * drive / drive.readonly を足すと利用者のドライブ全体が見える状態になり、
 * 「保存先以外の Google Drive データを読み取らない」（§8.1）が崩れる。
 *
 * drive.file は「このアプリが作成した／利用者が明示的に開いたファイル」だけに届く。
 * 保存先フォルダを ID で固定登録せず名前から解決・作成しているのは、この制約による
 * （アプリが作っていないフォルダへは書き込めない。§FR-03）。
 */
export const OAUTH = Object.freeze({
  /*
   * Google Cloud Console で発行したウェブアプリ用クライアントID。
   * 領収書スキャナ（production-app/receipt-ocr/config.js）と同一のものを使う。
   *
   * client secret はここへ貼らないこと（暗黙フローでは不要）。
   */
  clientId: '603018562548-j2he1aeo96p2igqfk65gaevj55pdaikc.apps.googleusercontent.com',
  scope: 'https://www.googleapis.com/auth/drive.file',
});

export function isOauthConfigured(clientId = OAUTH.clientId) {
  return typeof clientId === 'string' && clientId.trim().endsWith('.apps.googleusercontent.com');
}

/*
 * 録音の上限（要件書 §10-5 / §FR-04）。
 *
 * 上限 90分・残り5分で予告。テスト環境の長時間モード（60分 / 55分予告）から
 * 引き上げてある。この2つは必ず「予告 = 上限 - 5分」の関係を保つこと。
 */
const DEFAULT_MAX_SECONDS = 90 * 60;
const DEFAULT_WARNING_LEAD_SECONDS = 5 * 60;

/*
 * ------------------------------------------------------------------
 * 上限値のテスト用上書き（自動テスト専用）
 * ------------------------------------------------------------------
 * 上限90分・予告85分をそのまま自動テストで確認しようとすると、1件に90分かかる。
 * かといってテストのたびに上の定数を書き換えるのは、戻し忘れが本番へ出る。
 *
 * そこで **localhost からの表示に限り** クエリパラメータでの上書きを許す。
 *   ?testMaxSeconds=20&testWarningSeconds=10
 *
 * **本番では到達しない。** tsam-ai.com（および Vercel のプレビュー）では
 * isTestOrigin() が false を返すため、下の2つは常に既定値そのものになる。
 * 上書き値も 0 < 値 <= 既定値 に丸めるので、上限を90分より延ばすことはできない。
 * ------------------------------------------------------------------
 */
function isTestOrigin() {
  const host = globalThis.location?.hostname ?? '';
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function overrideSeconds(paramName, fallback) {
  if (!isTestOrigin()) {
    return fallback;
  }

  const raw = new URLSearchParams(globalThis.location?.search ?? '').get(paramName);
  const value = Number(raw);

  /* 数値でない・0以下・既定値より大きい、はすべて無視して既定値に戻す。 */
  if (!Number.isFinite(value) || value <= 0 || value > fallback) {
    return fallback;
  }

  return Math.floor(value);
}

export const MAX_SECONDS = overrideSeconds('testMaxSeconds', DEFAULT_MAX_SECONDS);

/*
 * 予告は既定では「上限 - 5分」。
 * 上限を短く上書きしたときは差が負になるため、予告側も上書きできるようにする
 * （上書きしない場合は 0 に丸められ、録音開始と同時に予告が出る）。
 */
export const WARNING_SECONDS = overrideSeconds(
  'testWarningSeconds',
  Math.max(0, MAX_SECONDS - DEFAULT_WARNING_LEAD_SECONDS),
);

/*
 * MP3 の出力仕様（要件書 §FR-06 / §10-6）。
 *
 * 128kbps モノラルは要件書の指定。テスト環境は 96kbps だったため、
 * 1分あたり約0.70MB → 約0.96MB、90分で約86MB に増える。
 * 下の空き容量の下限は、この 86MB を前提に決めてある。
 */
export const BITRATE_KBPS = 128;
export const MP3_BYTES_PER_SECOND = (BITRATE_KBPS * 1000) / 8; // 16,000 bytes/s ≒ 0.96 MB/分

/*
 * 長時間モードが対応するサンプルレート。
 * 規格外の端末ではリサンプリングせず、録音を開始しない（MVPの割り切り）。
 */
export const SUPPORTED_SAMPLE_RATES = Object.freeze([44100, 48000]);

/*
 * OPFS（端末内の一時保存領域）の空き容量。
 *
 * MIN_FREE_BYTES … 録音開始前に要求する空き。90分ぶん約86MB の約3倍。
 *                  navigator.storage.estimate() は推定値でしかなく、
 *                  実際に書き込める量と一致しない。余裕を持たせている。
 * SAFE_MIN_BYTES … 録音中に下回ったら自動停止して確定する安全下限。
 */
export const MIN_FREE_BYTES = 250 * 1024 * 1024;
export const SAFE_MIN_BYTES = 100 * 1024 * 1024;

/*
 * 保存先の名前（要件書 §FR-03）。
 *
 * ------------------------------------------------------------------
 * フォルダIDをここへ書かないこと
 * ------------------------------------------------------------------
 * フォルダIDは利用者ごとに異なる。固定値として書くと、他の利用者の
 * ドライブでは存在しないIDを参照することになり、必ず失敗する。
 * IDは毎回「名前と親の関係」から解決する。
 *
 * この名前は音声文字起こしアプリも読みに来る（public/apps/drive-folders.js の
 * 同名定義がテスト環境側の正）。**片方だけ変えないこと。**
 * 複製であって import ではないのは、本番アプリからテスト環境を参照しない
 * という境界（docs/repository-structure.md §1）による。
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

/* ファイル名の生成に使う時間帯（要件書 §FR-07 は「ブラウザ日時基準」）。 */
export const TIME_ZONE = 'Asia/Tokyo';

/* ファイル名の既定の接尾辞と拡張子（§FR-07: YYYYMMDD_HHmmss_録音.mp3）。 */
export const FILE_NAME_SUFFIX = '_録音';
export const FILE_EXTENSION = '.mp3';
export const MP3_MIME = 'audio/mpeg';

/* Google API のエンドポイント。当社ドメインは含まれない。 */
export const GOOGLE_API = Object.freeze({
  driveFiles: 'https://www.googleapis.com/drive/v3/files',
  driveUpload: 'https://www.googleapis.com/upload/drive/v3/files',
});
