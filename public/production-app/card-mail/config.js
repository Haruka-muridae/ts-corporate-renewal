/*
 * 名刺メール配信アプリ（card-mail）の静的設定。**設定値を変えるのはこのファイルだけ。**
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * ../card-ocr/config.js の構成に合わせて作った（2026-08-10）。
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
 * **card-ocr と同じクライアントIDを使う（意図的な共用）。**
 *
 * drive.file は「そのクライアントIDで作成したファイルだけ」を見せる
 * 権限である。名刺台帳「名刺管理」は card-ocr のIDで作られているため、
 * **同じIDでなければ台帳が見えない。** アプリごとにIDを分けて見える
 * 範囲を切るのが本来の方針（card-ocr の config.js）だが、このアプリは
 * 「card-ocr が作った台帳を読む」のが目的そのものなので、例外として
 * 共用する（要件定義書 card-mail-requirements-v1.md §12）。
 *
 * **Google Cloud 側の作業（コードには現れない）:**
 * このクライアントの OAuth 同意画面に gmail.send スコープを追加し、
 * 公開前に Google の審査を受けること（gmail.send は制限付きスコープ）。
 * 審査が通るまでは「確認されていないアプリ」の警告が出る。
 */
export const GOOGLE_CLIENT_ID = '603018562548-6653ifft0dji8g93m9sba919rn0nv4li.apps.googleusercontent.com';

/*
 * 要求するスコープはこの2つだけ。**増やさないこと。**
 *
 *   - drive.file  … 台帳（名刺管理）を読むため。card-ocr が作った
 *                    ファイルだけが対象で、ドライブ全体は読めない
 *   - gmail.send  … 利用者自身のGmailから送信するため。**送信のみ**の
 *                    権限で、受信箱の閲覧・検索はできない
 *
 * gmail.readonly 等を足さないのは、宛先の取得が Sheets 経由で足りる
 * ためと、権限が広がるほど審査と利用者の不安が重くなるため。
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const REQUIRED_SCOPES = Object.freeze([DRIVE_SCOPE, GMAIL_SEND_SCOPE]);

/*
 * GIS の公式配信URL。
 *
 * docs/external-dependency-approvals.md で承認済みの読み込み先であり、
 * **ここ以外へ向けてはならない**（card-ocr と同じ）。
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
 * このアプリが通信してよいのは次の3系統だけ
 * （＋TSAM AI 認証系。index.html の CSP と揃えること）。
 */
export const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
export const SHEETS_ENDPOINT = 'https://sheets.googleapis.com/v4/spreadsheets';
export const GMAIL_SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/* ================================================================
 * 台帳の場所（card-ocr の保存構造。こちらからは**読むだけ**）
 * ================================================================
 *
 *   マイドライブ
 *   └─ TSAM AI
 *      └─ 名刺データ
 *         └─ 名刺管理（Googleスプレッドシート）
 *
 * **このアプリはフォルダも台帳も作らない。** 無ければ「先に名刺OCRで
 * 登録してください」と案内する。作ってしまうと、空の台帳が正本として
 * card-ocr に拾われる事故になる。
 */
export const ROOT_FOLDER_NAME = 'TSAM AI';
export const APP_FOLDER_NAME = '名刺データ';
export const SPREADSHEET_NAME = '名刺管理';

/* 台帳のタブ名と、宛先を読む列の見出し（card-ocr の schema.js と揃える）。 */
export const DATA_TAB_NAME = '名刺データ';
export const EMAIL_COLUMN_HEADER = 'メールアドレス';

/* ================================================================
 * 送信
 * ================================================================ */

/*
 * 1通あたりのBCC宛先数（要件: 100件ずつ）。
 *
 * 無償の Gmail アカウントは1通あたり100宛先までという制限がある。
 * **To を付けない**（宛先はBCCのみ）ことで、100件がちょうど上限に
 * 収まる。101件目からは次の1通になる。
 */
export const BCC_BATCH_SIZE = 100;

/* 件名・本文の上限。誤操作で巨大な本文を送る事故の歯止め。 */
export const MAX_SUBJECT_LENGTH = 250;
export const MAX_BODY_LENGTH = 100000;

/* ================================================================
 * キャッシュの保存キー（localStorage）
 * ================================================================
 *
 * **入るのは台帳の場所（ファイルID）だけ。** 宛先もトークンも入れない。
 * card-ocr のキーとは分ける（あちらの検証ロジックと状態を共有しない）。
 */
export const STORAGE_KEYS = Object.freeze({
  rootFolder: 'tsam-card-mail-root-folder-id',
  appFolder: 'tsam-card-mail-app-folder-id',
  spreadsheet: 'tsam-card-mail-spreadsheet-id',
});

/* ================================================================
 * MIME タイプ
 * ================================================================ */

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
