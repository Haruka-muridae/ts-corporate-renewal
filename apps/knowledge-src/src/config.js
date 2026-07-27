/*
 * このアプリの設定値。
 *
 * ------------------------------------------------------------------
 * 設定値の正本（どのファイルを編集するか）
 * ------------------------------------------------------------------
 *   OAuthクライアントID … apps/auth-config.js   ★ここでは編集しない
 *                          ビルド前に scripts/generate-auth-config.mjs が
 *                          src/generated/google-config.js を生成して取り込む。
 *   Picker用APIキー     … このファイル（pickerApiKey）
 *   プロジェクト番号     … このファイル（pickerAppId）
 *   使用スコープ         … このファイル（SCOPE_MODE）
 *   固定フォルダパス     … このファイル（KNOWLEDGE_FOLDER_PATH）
 *
 * クライアントIDを2か所へ手入力する運用は残さない。
 * 詳細は apps/KNOWLEDGE_SETUP.md「設定値の正本」を参照。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * リポジトリへ絶対に入れてはならないもの
 * ------------------------------------------------------------------
 *   OAuth client secret / refresh token / アクセストークン /
 *   サービスアカウント秘密鍵 / 個人の認証情報
 *
 * OAuthクライアントID と Picker用APIキー は「公開情報」であり秘密ではない。
 * ただしAPIキーは Google Cloud Console 側で
 *   - HTTPリファラー制限（https://tsam-ai.com/* など）
 *   - APIの制限（Google Picker API のみ）
 * を必ず設定すること。無制限のAPIキーはコミットしない。
 * ------------------------------------------------------------------
 */

/*
 * 自動生成モジュール。正本は apps/auth-config.js。
 * 見つからない場合は `npm run generate:config` を実行する。
 */
import { GOOGLE_CLIENT_ID, CLIENT_ID_PLACEHOLDER as GENERATED_PLACEHOLDER } from './generated/google-config.js';

/* 未設定を表す値。この値のままなら外部通信を一切行わず「準備中」表示になる。 */
export const CLIENT_ID_PLACEHOLDER = GENERATED_PLACEHOLDER;

export const AUTH_CONFIG = Object.freeze({
  /*
   * Google Cloud Console で発行した「ウェブアプリケーション」用クライアントID。
   * ★編集先は apps/auth-config.js。ここへ直接書かないこと。
   */
  clientId: GOOGLE_CLIENT_ID,

  /*
   * Google Picker API 用のAPIキー。
   * 空文字なら Picker を使わず、Drive API によるフォルダ一覧フォールバックへ倒す。
   * （フォールバックは drive.readonly / drive.metadata.readonly が必要。）
   */
  pickerApiKey: '',

  /*
   * Google Cloud プロジェクト番号（プロジェクトIDではなく数字のほう）。
   * SCOPE_MODE が 'file' のとき、Pickerで選んだフォルダへ権限を付与するために必要。
   * 'readonly' のときは未設定でよい。
   */
  pickerAppId: '',
});

/*
 * 要求するDriveスコープ。**読み取り専用のみ**。書き込みスコープは追加しない。
 *
 * scopeMode:
 *   'readonly' … https://www.googleapis.com/auth/drive.readonly
 *                Drive全体の読み取り。Pickerが無くてもフォルダ一覧を出せる。
 *                Googleの分類では「制限付きスコープ」で、外部公開時は審査対象。
 *
 *   'file'     … https://www.googleapis.com/auth/drive.file
 *                利用者がPickerで明示的に選んだフォルダ／ファイルのみ。最小権限。
 *                **Pickerが必須**（pickerApiKey 未設定だとフォルダを選べない）。
 *
 * 既定は 'readonly'。Picker用APIキーを設定できるなら 'file' へ切り替えて
 * 権限をさらに絞ることを推奨する。
 */
export const SCOPE_MODE = 'readonly';

const SCOPE_BY_MODE = Object.freeze({
  readonly: 'https://www.googleapis.com/auth/drive.readonly',
  file: 'https://www.googleapis.com/auth/drive.file',
});

export function getDriveScope(mode = SCOPE_MODE) {
  return SCOPE_BY_MODE[mode] ?? SCOPE_BY_MODE.readonly;
}

/*
 * ナレッジ対象の固定フォルダパス。
 *
 * マイドライブ直下から順に、**親フォルダIDを指定しながら1階層ずつ**探索する。
 * フォルダ名だけの全体検索は行わない（同名フォルダの誤選択を避けるため）。
 *
 * 見つからない場合は、どの階層で失敗したかを画面へ出し、
 * フォルダ選択へ誘導する。**自動でフォルダを作成しない**
 * （書き込み権限を持たないため、そもそも作成できない）。
 */
export const KNOWLEDGE_FOLDER_PATH = Object.freeze(['TSAM AI', 'ローカルLLM', '01_ナレッジ']);

/* パス表示用のラベル（先頭にマイドライブを付ける）。 */
export const DRIVE_ROOT_LABEL = 'マイドライブ';

/*
 * PDF.js の補助アセットの配置場所。
 *
 * 日本語PDFは定義済みCMap（90ms-RKSJ-H など）を使うことが多く、
 * これを読み込めないとテキスト抽出が空になるか文字化けする。
 * アセットは scripts/copy-pdf-assets.mjs が public/ へ複製し、
 * 配信物の直下（apps/knowledge/cmaps 等）に置かれる。
 *
 * Worker 側では基準URLを解決できないため、メインスレッドで算出して渡す。
 *   本番: base './' → index.html と同じ階層
 *   開発: base '/'  → サーバールート
 */
function assetBaseUrl() {
  const base = import.meta.env?.BASE_URL ?? '/';
  return new URL(base, globalThis.location?.href ?? 'http://localhost/');
}

export function getPdfAssetUrls() {
  const base = assetBaseUrl();

  return {
    cMapUrl: new URL('cmaps/', base).href,
    standardFontDataUrl: new URL('standard_fonts/', base).href,
  };
}

/* Google Identity Services / Picker の公式配信元。自己ホストや差し替えは行わない。 */
export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
export const GAPI_SCRIPT_URL = 'https://apis.google.com/js/api.js';
export const SCRIPT_LOAD_TIMEOUT_MS = 15000;

/* Drive API v3 のエンドポイント。書き込み系は一切呼ばない。 */
export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

/* テキスト正規化・チャンク分割の初期値。設定画面から上書きできる。 */
export const CHUNK_DEFAULTS = Object.freeze({
  targetChars: 800,
  overlapChars: 100,
  maxChars: 1200,
  /* これ未満のチャンクは（末尾チャンクを除き）前のチャンクへ吸収する。 */
  minChars: 80,
});

/* 同期の既定値。 */
export const SYNC_DEFAULTS = Object.freeze({
  /* 1ファイルあたりの取得上限。これを超えるファイルはスキップし理由を記録する。 */
  maxFileBytes: 40 * 1024 * 1024,
  /* Drive API の1ページあたり件数。 */
  pageSize: 100,
  /* 同時解析数。UIを止めないため控えめにする。 */
  concurrency: 2,
  /* サブフォルダを再帰的にたどるか。 */
  recursive: true,
  /* 再帰の深さ上限（循環・巨大ツリー対策）。 */
  maxDepth: 5,
});

/*
 * 初期版の対応MIMEタイプ。
 * スプレッドシート・スライド・画像OCRは対象外（除外理由を一覧に表示する）。
 */
export const MIME = Object.freeze({
  GOOGLE_DOC: 'application/vnd.google-apps.document',
  GOOGLE_SHEET: 'application/vnd.google-apps.spreadsheet',
  GOOGLE_SLIDE: 'application/vnd.google-apps.presentation',
  GOOGLE_FOLDER: 'application/vnd.google-apps.folder',
  PDF: 'application/pdf',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  DOC: 'application/msword',
  TXT: 'text/plain',
  MARKDOWN: 'text/markdown',
});

/* 拡張子でしか判別できない場合の補助（DriveがMIMEを text/plain にすることがある）。 */
export const MARKDOWN_EXTENSIONS = Object.freeze(['.md', '.markdown', '.mdown', '.mkd']);
export const TEXT_EXTENSIONS = Object.freeze(['.txt', '.text', '.log', '.csv']);

/*
 * 将来拡張のフラグ。既定はすべて false。
 * true にするだけで動くわけではなく、対応モジュールの実装が前提。
 * （src/future/ に受け口だけ用意してある。）
 */
export const FEATURE_FLAGS = Object.freeze({
  embedding: false,      // Transformers.js による埋め込み生成
  vectorSearch: false,   // ベクトル検索
  hybridSearch: false,   // 全文 + ベクトルのハイブリッド
  webgpuLlm: false,      // WebGPU ローカルLLM
  ocr: false,            // 画像OCR
  summarize: false,      // 要約
  answerGeneration: false, // 回答生成
  spreadsheet: false,    // Googleスプレッドシート
  slides: false,         // Googleスライド
  multiFolder: false,    // 複数ナレッジフォルダ
  pwa: false,            // PWA
});

/* クライアントIDが実際に使える値かどうか。false ならページは壊さず「準備中」表示。 */
export function isClientIdConfigured(clientId = AUTH_CONFIG.clientId) {
  if (typeof clientId !== 'string') {
    return false;
  }

  const value = clientId.trim();

  if (value === '' || value === CLIENT_ID_PLACEHOLDER) {
    return false;
  }

  return value.endsWith('.apps.googleusercontent.com');
}

/* Picker用APIキーが設定されているかどうか。false ならフォールバックUIを使う。 */
export function isPickerConfigured(apiKey = AUTH_CONFIG.pickerApiKey) {
  return typeof apiKey === 'string' && apiKey.trim().length >= 20;
}
