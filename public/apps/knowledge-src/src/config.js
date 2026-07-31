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
 * 見つからない場合は、どの階層で失敗したかを画面へ出す。
 * 探索だけでは作成せず、利用者が不足フォルダ作成を明示確認した場合に限り
 * 別経路で一時的な書き込み権限を要求する。
 */
export const KNOWLEDGE_FOLDER_PATH = Object.freeze(['TSAM AI', 'ローカルLLM', '01_ナレッジ']);

/* パス表示用のラベル（先頭にマイドライブを付ける）。 */
export const DRIVE_ROOT_LABEL = 'マイドライブ';

/*
 * ------------------------------------------------------------------
 * 不足フォルダの作成（利用者が明示的にボタンを押したときだけ）
 * ------------------------------------------------------------------
 * 目標とする構成:
 *
 *   マイドライブ
 *   └─ TSAM AI            ← base[0]
 *      └─ ローカルLLM      ← base[1]
 *         ├─ 01_ナレッジ    ← children[0]（同期対象。KNOWLEDGE_FOLDER_PATH の末端）
 *         ├─ 02_未整理      ← children[1]
 *         ├─ 03_アーカイブ  ← children[2]
 *         └─ 99_システム    ← children[3]
 *
 * 作成順序は「上から順、同階層は配列順」で固定する（folder-plan.js）。
 * 既にあるフォルダは再利用し、欠けているものだけを作る。
 */
export const FOLDER_STRUCTURE = Object.freeze({
  base: Object.freeze(['TSAM AI', 'ローカルLLM']),
  children: Object.freeze(['01_ナレッジ', '02_未整理', '03_アーカイブ', '99_システム']),
  /* 同期対象。base + [knowledge] が KNOWLEDGE_FOLDER_PATH と一致していること。 */
  knowledge: '01_ナレッジ',
});

/*
 * フォルダ作成に使うスコープ。
 *
 * ------------------------------------------------------------------
 * なぜ readonly では作れないのか（実測にもとづく）
 * ------------------------------------------------------------------
 * Drive API v3 のディスカバリ文書（revision 20260720）が示す
 * files.create の受付スコープは次の3つだけである。
 *
 *     https://www.googleapis.com/auth/drive
 *     https://www.googleapis.com/auth/drive.appdata
 *     https://www.googleapis.com/auth/drive.file
 *
 * drive.readonly と drive.metadata は含まれない。
 * したがって作成には必ず追加スコープの認可が要る。
 *
 * ------------------------------------------------------------------
 * 'drive'（採用） … 通常は readonly。ボタンを押したときだけ drive を追加要求し、
 *                   POST /files を1回ずつ実行したら、そのトークンを即破棄する。
 *                   既存の TSAM AI（利用者が作ったフォルダ）配下にも作れる。
 *
 * 'file'  （保留） … drive.file は「アプリが作った／利用者がPickerで選んだ」
 *                   資源にしか触れない。既存の TSAM AI 配下へ作るには
 *                   Picker で親フォルダを選ばせて権限を付与する必要があり、
 *                   pickerApiKey / pickerAppId の設定が前提になる。
 *                   両方が設定されるまでは選べない。
 * ------------------------------------------------------------------
 */
export const FOLDER_CREATE_SCOPE_MODE = 'drive';

const CREATE_SCOPE_BY_MODE = Object.freeze({
  drive: 'https://www.googleapis.com/auth/drive',
  file: 'https://www.googleapis.com/auth/drive.file',
});

export function getFolderCreateScope(mode = FOLDER_CREATE_SCOPE_MODE) {
  return CREATE_SCOPE_BY_MODE[mode] ?? CREATE_SCOPE_BY_MODE.drive;
}

/* 画面に出す「必要な権限」の短い説明。 */
export const FOLDER_CREATE_SCOPE_LABEL = Object.freeze({
  drive: 'drive（フォルダ作成のあいだだけ）',
  file: 'drive.file（Pickerで選んだフォルダのみ）',
});

/*
 * 'file' モードは Picker が設定済みのときしか成立しない。
 * 設定不足のまま切り替えられても、作成前にここで止める。
 */
export function isFolderCreateModeAvailable(mode = FOLDER_CREATE_SCOPE_MODE) {
  if (mode === 'file') {
    return isPickerConfigured() && String(AUTH_CONFIG.pickerAppId ?? '').trim() !== '';
  }
  return mode === 'drive';
}

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

/* Drive API v3 のエンドポイント。読み取りはここだけを使う。 */
export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

/*
 * 本文つきファイルを新規作成するときだけ使う配信元。
 * セットアップのサンプル作成と、利用者が明示確認した端末アップロードで使う。
 * 通常の探索・同期・検索からは到達しない（src/drive/drive-writer.js に閉じている）。
 */
export const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

/*
 * 利用者が端末から追加できるファイルの制限。
 *
 * 1ファイルの上限は同期側と同じ40MBにそろえる。Driveへ保存できても、
 * 直後の同期で取得できない大きさを受け付けると「保存だけ成功」の状態を
 * 不用意に作るためである。
 */
export const KNOWLEDGE_UPLOAD_LIMITS = Object.freeze({
  maxFiles: 50,
  maxFileBytes: 40 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxNameCodePoints: 180,
  maxFolderDepth: 5,
});

/*
 * 端末からのアップロードで受け付ける拡張子。
 *
 * parseable=true は、既存の同期エンジンが実際に解析できる形式だけ。
 * HTML / PPTX / XLSX は要望された選択肢としてDrive保存を許可するが、
 * 現在の解析器では検索対象にできないため、画面で「保存のみ」と明示する。
 */
export const KNOWLEDGE_UPLOAD_TYPES = Object.freeze({
  '.pdf': Object.freeze({ mimeType: 'application/pdf', label: 'PDF', parseable: true }),
  '.txt': Object.freeze({ mimeType: 'text/plain', label: 'テキスト', parseable: true }),
  '.md': Object.freeze({ mimeType: 'text/markdown', label: 'Markdown', parseable: true }),
  '.markdown': Object.freeze({ mimeType: 'text/markdown', label: 'Markdown', parseable: true }),
  '.csv': Object.freeze({ mimeType: 'text/csv', label: 'CSV', parseable: true }),
  '.docx': Object.freeze({
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'DOCX',
    parseable: true,
  }),
  '.html': Object.freeze({ mimeType: 'text/html', label: 'HTML', parseable: false }),
  '.htm': Object.freeze({ mimeType: 'text/html', label: 'HTML', parseable: false }),
  '.pptx': Object.freeze({
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PPTX',
    parseable: false,
  }),
  '.xlsx': Object.freeze({
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'XLSX',
    parseable: false,
  }),
});

/*
 * 01_ナレッジ を新規作成したときだけ置く、動作確認用のファイル。
 *
 * 生成するのは初回の1度だけ。同じ名前のファイルが既にあれば **作らない**
 * （上書き・更新は行わない。そもそも更新用のAPIを実装していない）。
 */
export const SAMPLE_FILES = Object.freeze([
  Object.freeze({
    name: 'README.md',
    mimeType: 'text/markdown',
    description: 'このフォルダの使い方',
    content: [
      '# 01_ナレッジ フォルダについて',
      '',
      'このフォルダは、ナレッジ管理・検索アプリの **取り込み対象** です。',
      '',
      '## 置いてよいファイル',
      '',
      '- Googleドキュメント',
      '- PDF（テキストを含むもの）',
      '- Word（.docx）',
      '- テキスト（.txt）',
      '- Markdown（.md）',
      '',
      'スプレッドシート・スライド・画像は現在の版では対象外です。',
      '',
      '## 隣のフォルダの使い分け',
      '',
      '| フォルダ | 用途 |',
      '| --- | --- |',
      '| 01_ナレッジ | 検索対象にしたい資料 |',
      '| 02_未整理 | これから仕分けする資料 |',
      '| 03_アーカイブ | 参照しなくなった資料 |',
      '| 99_システム | 運用メモなど |',
      '',
      '## 注意',
      '',
      '通常の探索・同期・検索では、アプリは Drive を **読み取り専用** で扱います。',
      '「ナレッジを追加」を確認した場合だけ新しいファイルを作成できますが、',
      '既存ファイルの編集・移動・削除・上書きは行いません。',
      '抽出したテキストと検索インデックスはブラウザの中（IndexedDB）にだけ保存され、',
      'Drive へは書き戻しません。',
      '',
    ].join('\n'),
  }),
  Object.freeze({
    name: 'サンプル.txt',
    mimeType: 'text/plain',
    description: '検索テスト用のテキスト',
    content: [
      'ナレッジ検索の動作確認用ファイルです。',
      '',
      'このファイルには、検索テスト用のキーワードとして',
      'テスト用キーワードあいうえお',
      'を入れてあります。',
      '',
      'セットアップウィザードの「検索テスト」で、この語を検索して',
      'このファイルがヒットすれば、取得・抽出・分割・索引・検索の',
      'すべてが正しく動いています。',
      '',
      '確認が済んだら、このファイルは削除しても構いません。',
      '（削除は Drive 上で手動で行ってください。アプリからは削除できません。）',
      '',
    ].join('\n'),
  }),
]);

/* 検索テストで使うキーワード。サンプル.txt の本文と一致させること。 */
export const SAMPLE_SEARCH_TERM = 'テスト用キーワードあいうえお';

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
