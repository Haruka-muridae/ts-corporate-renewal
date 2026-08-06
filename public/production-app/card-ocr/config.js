/*
 * 名刺OCRアプリの静的設定。**設定値を変えるのはこのファイルだけ。**
 *
 * ==================================================================
 * なぜ1本にまとめるか
 * ==================================================================
 * 検証用PoC（./poc/）は、定数を google-config.js・drive-api.js・
 * drive-storage.js・gemini.js に散らしていた。「この値はどこで決まって
 * いるのか」を探すのに毎回grepが要る状態だったので、本番実装では
 * 領収書OCR（../receipt-ocr/config.js）と同じく1本に集約する。
 *
 * **使わない値をここへ置かない。** 置いたまま参照しないと、
 * 「設定したのに効かない」という最も分かりにくい不具合になる
 * （docs/receipt-ocr-findings-20260804.md #9 が実例）。
 * フェーズが進んで必要になった時点で、そのPRで足す。
 *
 * **秘密情報を置かない。** ここは公開URLから読める。
 * ==================================================================
 */

/* ================================================================
 * Google OAuth
 * ================================================================ */

/* 未設定の目印。この値のままなら連携を開始しない。 */
export const CLIENT_ID_PLACEHOLDER = 'REPLACE_WITH_GOOGLE_CLIENT_ID';

/*
 * card-ocr 専用に新規発行したクライアントID（2026-08-03）。
 *
 * テスト環境 `/apps/` が使う既存IDとも、領収書OCRが使うIDとも
 * **別のクライアント**である（フェーズ0計画 §6-2 の決定）。
 *
 * このIDで作成したファイルだけが drive.file の対象になるため、
 * 他アプリが作ったファイルはこのアプリからは見えない。これは意図どおりで、
 * アプリごとに見える範囲を切るためにIDを分けている。
 *
 * **クライアントIDは秘密ではない。** リポジトリに入れてよい
 * （既存の public/apps/auth-config.js も同じ扱い）。
 * クライアントシークレットは使わない。静的サイトに置けないため。
 *
 * 承認済みJavaScript生成元（Google Cloud 側の設定。コードには現れない）:
 *   https://tsam-ai.com  … 本番
 *   （フェーズ0の検証に使ったプレビューURLは、フェーズ2の測定でも
 *     使うため当面残す。撤去はフェーズ2の完了後）
 */
export const GOOGLE_CLIENT_ID = '603018562548-6653ifft0dji8g93m9sba919rn0nv4li.apps.googleusercontent.com';

/*
 * 要求するスコープはこの1つだけ。**増やさないこと。**
 *
 * drive.file は「このクライアントIDが作成した、または利用者が明示的に
 * 選んだファイル」だけを対象とする権限で、ドライブ全体を読む権限ではない
 * （要件定義書 §FR-02 の2、§6 前提条件4）。
 *
 * スコープを増やすと利用者に再同意を求めることになり、
 * 「未確認アプリ」の警告や審査の要否にも影響する。
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/*
 * GIS の公式配信URL。
 *
 * docs/external-dependency-approvals.md で承認済みの読み込み先であり、
 * **ここ以外へ向けてはならない。** 自己ホスト・npm化・非公式ミラーへの
 * 差し替えも行わない（Google 側の更新に追従できなくなるため）。
 */
export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

/* 読み込みの打ち切り。通信が滞ったまま画面が固まるのを防ぐ。 */
export const GIS_LOAD_TIMEOUT_MS = 10000;

/* 期限ぎりぎりのトークンを使わない。手前で切り上げる幅。 */
export const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

/*
 * クライアントIDが設定済みか。
 *
 * **未設定なら GIS を読み込まない。** 承認記録の条件どおり、
 * 画面を開いただけで外部通信を発生させないため、判定を先に行う。
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
 * ================================================================ */

/*
 * 要件定義書 §12 が許す通信先は3系統だけ。ここを変えないこと。
 * （3つ目の generativelanguage.googleapis.com はフェーズ2で足す）
 */
export const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
export const DRIVE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';
export const SHEETS_ENDPOINT = 'https://sheets.googleapis.com/v4/spreadsheets';
export const GEMINI_HOST = 'generativelanguage.googleapis.com';
export const GEMINI_ENDPOINT_BASE = `https://${GEMINI_HOST}/v1beta/models`;

/* ================================================================
 * Gemini のモデル（§FR-11、§20 で確定）
 * ================================================================
 *
 * フェーズ0で当初の主モデル gemini-3.5-flash-lite に 503（混雑）が続き、
 * 入れ替えたところ同じキー・同じリクエストで6/6成功した（計画 §7-5-2）。
 * **実測で通ったほうを主に置く。**
 *
 * 両モデルとも実在することは確認済み。したがってフォールバックが働く
 * 場面は「**主モデルが廃止されたとき**」であり、混雑時の退避ではない。
 * 退避の是非は §20 の要判断として残っている。
 */
export const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
export const FALLBACK_MODEL = 'gemini-3.5-flash-lite';

/*
 * 出力の上限（§FR-11）。無料枠キーのクォータを無駄に減らさない。
 *
 * v3.5 で 400 → 700 にした。otherInformation（どの項目にも入らなかった
 * 読み取り内容）が加わり、400 では途中で切れて JSON が壊れうるため。
 * **切れると AI-003 になり、その名刺は登録できない。**
 */
export const MAX_OUTPUT_TOKENS = 700;

/* ================================================================
 * 保存構造（要件定義書 §FR-07）
 * ================================================================
 *
 *   マイドライブ
 *   └─ TSAM AI
 *      └─ 名刺データ
 *         ├─ 名刺管理（Googleスプレッドシート）
 *         └─ images
 *
 * ルートの `TSAM AI` は他アプリ（領収書OCR）と共用する名前だが、
 * **フォルダの実体は共用しない。** drive.file はクライアントIDごとに
 * 見える範囲が分かれるため、それぞれのアプリが自分の `TSAM AI` を
 * 作る。利用者のドライブ上で同名フォルダが2つ並ぶことがあるが、
 * これは権限モデルの帰結であって不具合ではない。
 */
export const ROOT_FOLDER_NAME = 'TSAM AI';
export const APP_FOLDER_NAME = '名刺データ';
export const IMAGE_FOLDER_NAME = 'images';
export const SPREADSHEET_NAME = '名刺管理';

/* 台帳のタブ名（要件定義書 §11.2・§11.3）。 */
export const TABS = Object.freeze({
  data: '名刺データ',
  history: '変更履歴',
});

/*
 * 台帳に記録するアプリの版（§11.2 の app_version）。
 *
 * **列の構成を変えたら上げること。** 行を見たときに、どの構成で
 * 書かれたのかが分かるようにするための値である。
 */
export const APP_VERSION = 'card-ocr-1.1';

/* ================================================================
 * キャッシュの保存キー（localStorage）
 * ================================================================
 *
 * **入るのは保存先のIDだけ。** 名刺データもトークンもキーも入れない
 * （要件定義書 §FR-21）。localStorage はキャッシュであって正本ではなく、
 * 消えても検索で復旧する。
 */
export const STORAGE_KEYS = Object.freeze({
  rootFolder: 'tsam-card-ocr-root-folder-id',
  appFolder: 'tsam-card-ocr-app-folder-id',
  imageFolder: 'tsam-card-ocr-image-folder-id',
  spreadsheet: 'tsam-card-ocr-spreadsheet-id',
});

/* ================================================================
 * MIME タイプ
 * ================================================================ */

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
export const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
export const JPEG_MIME = 'image/jpeg';
