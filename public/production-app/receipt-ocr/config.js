/*
 * 領収書スキャナの静的設定。
 * 値を書き換える場所は、このファイルの1か所だけにする。
 *
 * 仕様書: docs/specs/receipt-ocr-v2.md
 *
 * ------------------------------------------------------------------
 * ここに秘密情報を入れないこと
 * ------------------------------------------------------------------
 * Gemini APIキーは利用者本人のものであり、Portal の KeyStore が持つ（§4-3）。
 * OAuth のアクセストークンはメモリだけで扱う（§13）。
 * どちらもこのファイルへ書かない。
 *
 * OAuth クライアントIDは秘密ではない（ブラウザへ配信される公開値）。
 * 実質的な防御は Google Cloud 側の「承認済みの JavaScript 生成元」であり、
 * 本番オリジンと開発オリジンだけを登録すること。
 * ------------------------------------------------------------------
 */

/* サイトのルートから見た、このアプリの深さ（production-app/receipt-ocr/ → 2）。 */
export const SCREEN_DEPTH = 2;

/*
 * Google OAuth。
 *
 * **スコープは drive.file のみ（§4-2・§13）。**
 * drive.readonly や drive を足してはならない。ドライブ全体を読む権限は
 * このアプリの用途に不要であり、要求した時点で §15.3 の分離が崩れる。
 *
 * drive.file は「このアプリが作成した／利用者が明示的に開いたファイル」だけに
 * 届く。§9.2-3 の再発見が成立するのはこの性質による。
 */
export const OAUTH = Object.freeze({
  /* TODO: Google Cloud Console で発行したウェブアプリ用クライアントIDを入れる。 */
  clientId: '',
  scope: 'https://www.googleapis.com/auth/drive.file',
});

export function isOauthConfigured(clientId = OAUTH.clientId) {
  return typeof clientId === 'string' && clientId.trim().endsWith('.apps.googleusercontent.com');
}

/*
 * OCRエンジンの選択（§0.2）。
 *
 *   'drive'  … 案A。利用者トークンで画像→Googleドキュメント変換→テキスト取得。
 *              一時ドキュメントは即時削除する（§9.5）。
 *   'gemini' … 案C。利用者キーで画像を直接 Gemini へ渡す。
 *
 * フェーズ0の実測比較で決める（§16 フェーズ0）。既定は追加コストが無く、
 * キー未設定でも動作する案Aとする（§4 キー未設定時の挙動）。
 */
export const OCR_ENGINE = 'drive';

/* Gemini。モデルは静的設定とし、404 のときだけ1回フォールバックする（§6）。 */
export const GEMINI = Object.freeze({
  apiBase: 'https://generativelanguage.googleapis.com',
  apiVersion: 'v1beta',
  model: 'gemini-3.6-flash',
  fallbackModel: 'gemini-2.5-flash',
});

/* 保存先の名前（§9.1）。一度公開したら変えないこと。名前検索の手がかりになる。 */
export const DRIVE_NAMES = Object.freeze({
  root: 'TSAM AI',
  app: '領収書データ',
  originals: '原本',
  spreadsheet: '領収書データ',
});

/* 日付の判定とフォルダ名の生成に使う時間帯（§6）。 */
export const TIME_ZONE = 'Asia/Tokyo';

/* アップロード前の縮小（§14）。長辺がこれを超える画像だけ縮める。 */
export const IMAGE_MAX_EDGE_PX = 2000;

/* 受け付ける画像（§3.1）。HEIC はブラウザ内で JPEG へ変換できた場合のみ。 */
export const ACCEPTED_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png']);

/* Google API のエンドポイント。当社ドメインは含まれない（§15.3）。 */
export const GOOGLE_API = Object.freeze({
  driveFiles: 'https://www.googleapis.com/drive/v3/files',
  driveUpload: 'https://www.googleapis.com/upload/drive/v3/files',
  sheets: 'https://sheets.googleapis.com/v4/spreadsheets',
});
