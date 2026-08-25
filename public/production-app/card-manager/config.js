/*
 * 名刺管理アプリ（card-manager）の静的設定。**設定値を変えるのはこのファイルだけ。**
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * ../card-mail/config.js の構成に合わせて作った（2026-08-20）。
 * **import はしない。** 本番アプリどうしでも共通層を作らず複製する
 * （docs/repository-structure.md §4-1）。
 *
 * **使わない値をここへ置かない。秘密情報を置かない**（複製元と同じ方針）。
 * ==================================================================
 */

/* ================================================================
 * Google OAuth
 * ================================================================ */

/* 未設定の目印。この値のままなら連携を開始しない。 */
export const CLIENT_ID_PLACEHOLDER = 'REPLACE_WITH_GOOGLE_CLIENT_ID';

/*
 * **card-ocr / card-mail と同じクライアントIDを使う（意図的な共用）。**
 *
 * drive.file は「そのクライアントIDで作成したファイルだけ」を見せる
 * 権限である。名刺台帳「名刺管理」は card-ocr のIDで作られているため、
 * **同じIDでなければ台帳が見えない。** このアプリは card-ocr が作った
 * 台帳を読み書きするのが目的そのものなので、card-mail と同じ理由で
 * 例外として共用する（ルート CLAUDE.md「名刺メール配信アプリ」節、
 * card-mail の config.js と同じ判断）。
 *
 * **Google Cloud 側の設定を変えると card-ocr / card-mail にも及ぶ。**
 * 片方の都合で生成元やスコープをいじらないこと。
 *
 * **クライアントIDは秘密ではない。** リポジトリに入れてよい。
 * クライアントシークレットは使わない（静的サイトに置けないため）。
 */
export const GOOGLE_CLIENT_ID = '603018562548-6653ifft0dji8g93m9sba919rn0nv4li.apps.googleusercontent.com';

/*
 * 要求するスコープは drive.file のみ。**増やさないこと。**
 *
 * 台帳（名刺管理）を読み書きするためだけに使う。card-ocr が作った
 * ファイルだけが対象で、ドライブ全体は読めない。gmail 等は不要
 * （このアプリはメールを送らない。それは card-mail の役割）。
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/*
 * GIS の公式配信URL。
 *
 * docs/external-dependency-approvals.md で承認済みの読み込み先であり、
 * **ここ以外へ向けてはならない**（card-ocr / card-mail と同じ）。
 */
export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

/* 読み込みの打ち切り。通信が滞ったまま画面が固まるのを防ぐ。 */
export const GIS_LOAD_TIMEOUT_MS = 10000;

/* 期限ぎりぎりのトークンを使わない。手前で切り上げる幅。 */
export const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

/*
 * クライアントIDが設定済みか。
 *
 * **未設定なら GIS を読み込まない。** 画面を開いただけで外部通信を
 * 発生させないため、判定を先に行う（card-ocr と同じ）。
 */
export function isClientIdConfigured(clientId = GOOGLE_CLIENT_ID) {
  if (typeof clientId !== 'string') {
    return false;
  }

  const value = clientId.trim();

  return value !== '' && value !== CLIENT_ID_PLACEHOLDER;
}

/* ================================================================
 * Google API のエンドポイント
 * ================================================================
 *
 * このアプリが通信してよいのは次の2系統だけ
 * （＋TSAM AI 認証系。index.html の CSP と揃えること）。
 */
export const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
export const SHEETS_ENDPOINT = 'https://sheets.googleapis.com/v4/spreadsheets';

/* ================================================================
 * 台帳の場所（card-ocr の保存構造。card-ocr 要件書 §FR-07 と同じ）
 * ================================================================
 *
 *   マイドライブ
 *   └─ TSAM AI
 *      └─ 名刺データ
 *         └─ 名刺管理（Googleスプレッドシート）
 *
 * **このアプリはフォルダも台帳も作らない。** 無ければ「先に名刺OCRで
 * 登録してください」と案内する。作ってしまうと、空の台帳が正本として
 * card-ocr に拾われる事故になる（card-mail と同じ理由）。
 */
export const ROOT_FOLDER_NAME = 'TSAM AI';
export const APP_FOLDER_NAME = '名刺データ';
export const SPREADSHEET_NAME = '名刺管理';

/* タブ名（card-ocr の schema.js・card-ocr 要件書 §11.2/§11.3 と同じ）。 */
export const TABS = Object.freeze({
  data: '名刺データ',
  history: '変更履歴',
});

/* ================================================================
 * キャッシュの保存キー（localStorage）
 * ================================================================
 *
 * **入るのは台帳の場所（ファイルID）だけ。** 名刺の中身もトークンも
 * 入れない。card-ocr / card-mail のキーとは分ける（あちらの検証ロジックと
 * 状態を共有しない）。
 */
export const STORAGE_KEYS = Object.freeze({
  rootFolder: 'tsam-card-manager-root-folder-id',
  appFolder: 'tsam-card-manager-app-folder-id',
  spreadsheet: 'tsam-card-manager-spreadsheet-id',
});

/* ================================================================
 * MIME タイプ
 * ================================================================ */

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
