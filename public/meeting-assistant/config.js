/*
 * Meeting Assistant 最小MVPの静的設定。
 * 値を書き換える場所はこのファイルの1か所だけにする。
 *
 * ------------------------------------------------------------------
 * 秘密情報を入れない
 * ------------------------------------------------------------------
 * Gemini APIキーは keystore.js だけが扱う。
 * OAuth のアクセストークンは oauth.js のメモリだけ。
 * client secret / refresh token は使わない。
 * portal 認証・共通セッションは使わない。
 * ------------------------------------------------------------------
 */

export const OAUTH = Object.freeze({
  clientId: '603018562548-j2he1aeo96p2igqfk65gaevj55pdaikc.apps.googleusercontent.com',
  scope: 'https://www.googleapis.com/auth/drive.file',
  /*
   * ポップアップを開けないとき（standalone PWA・ポップアップ阻止）に
   * リダイレクト方式へ切り替えるか。oauth.js を参照。
   * 切り替え先には Google Cloud Console の「承認済みのリダイレクト URI」へ
   * このアプリの URL（例: https://tsam-ai.com/meeting-assistant/）の登録が要る。
   */
  redirectFallback: true,
});

export function isOauthConfigured(clientId = OAUTH.clientId) {
  return typeof clientId === 'string' && clientId.trim().endsWith('.apps.googleusercontent.com');
}

/*
 * 保存先。フォルダIDは書かない。毎回「名前と親」から解決する。
 *
 *   マイドライブ
 *   └─ Potenitas System
 *      └─ Potenitas Administrator
 *         └─ Potenitas meet
 *            ├─ Potenitas voice
 *            └─ Potenitas record
 */
export const DRIVE_VOICE_PATH = Object.freeze([
  'Potenitas System',
  'Potenitas Administrator',
  'Potenitas meet',
  'Potenitas voice',
]);

export const DRIVE_RECORD_PATH = Object.freeze([
  'Potenitas System',
  'Potenitas Administrator',
  'Potenitas meet',
  'Potenitas record',
]);

export const DRIVE_NAMES = Object.freeze({
  voice: DRIVE_VOICE_PATH,
  record: DRIVE_RECORD_PATH,
});

export function formatFolderPath(names) {
  return ['マイドライブ', ...names].join(' ＞ ');
}

export const GOOGLE_API = Object.freeze({
  driveFiles: 'https://www.googleapis.com/drive/v3/files',
  driveUpload: 'https://www.googleapis.com/upload/drive/v3/files',
});

export const DRIVE = Object.freeze({
  listPageSize: 100,
  maxListPages: 10,
});

export const AUDIO_EXTENSIONS = Object.freeze([
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.webm', '.flac',
]);

export const AUDIO_MIME_TYPES = Object.freeze([
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
]);

export const TIME_ZONE = 'Asia/Tokyo';
export const FILE_NAME_SUFFIX = '_録音';
export const FILE_EXTENSION = '.mp3';
export const MP3_MIME = 'audio/mpeg';
export const MARKDOWN_MIME = 'text/markdown';

const DEFAULT_MAX_SECONDS = 90 * 60;
const DEFAULT_WARNING_LEAD_SECONDS = 5 * 60;

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

  if (!Number.isFinite(value) || value <= 0 || value > fallback) {
    return fallback;
  }

  return Math.floor(value);
}

export const MAX_SECONDS = overrideSeconds('testMaxSeconds', DEFAULT_MAX_SECONDS);
export const WARNING_SECONDS = overrideSeconds(
  'testWarningSeconds',
  Math.max(0, MAX_SECONDS - DEFAULT_WARNING_LEAD_SECONDS),
);

export const BITRATE_KBPS = 128;
export const MP3_BYTES_PER_SECOND = (BITRATE_KBPS * 1000) / 8;
export const SUPPORTED_SAMPLE_RATES = Object.freeze([44100, 48000]);
export const MIN_FREE_BYTES = 250 * 1024 * 1024;
export const SAFE_MIN_BYTES = 100 * 1024 * 1024;
export const MIX_SOURCE_GAIN = 0.7;

/* ---------- Gemini（モデルIDはここだけ） ---------- */

export const GEMINI_HOST = 'generativelanguage.googleapis.com';
export const GEMINI_ENDPOINT_BASE = `https://${GEMINI_HOST}/v1beta/models`;

/*
 * 高速・低コストな最軽量モデルを既定にする。
 * 高性能モデルは既定にしない。UIからも選ばせない。
 * 主モデルが 404 のときだけフォールバックする（meeting-minutes と同じ）。
 */
export const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
export const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
export const MAX_OUTPUT_TOKENS = 8192;

export const GEMINI = Object.freeze({
  apiBase: 'https://generativelanguage.googleapis.com',
  apiVersion: 'v1beta',
  models: Object.freeze([
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', costRank: 1 },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', costRank: 2 },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', costRank: 3 },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', costRank: 4 },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', costRank: 5 },
  ]),
  defaultModelId: DEFAULT_MODEL,
  pollIntervalMs: 2000,
  pollTimeoutMs: 10 * 60 * 1000,
});

export const GEMINI_API_KEY_URL = 'https://aistudio.google.com/apikey';

export const TRANSCRIPTION_PROMPT = `この音声を、聞こえた内容に忠実に日本語で文字起こししてください。

要件:
- 内容を要約しない
- 発言を勝手に補完しない
- 聞き取れない箇所は「[聞き取り不能]」と記載する
- 明らかな言い直しやフィラーを過度に削除しない
- 複数の話者を識別できる場合は「話者1」「話者2」のように区別する
- 可能な範囲でタイムスタンプを付ける
- Markdownの説明文は付けず、文字起こし本文のみ返す`;

export const LIMITS = Object.freeze({
  TRANSCRIPT_MAX_CHARS: 60000,
  TRANSCRIPT_WARN_CHARS: 45000,
  geminiMaxBytes: 200 * 1024 * 1024,
  geminiMaxDurationSec: 2 * 60 * 60,
});

export const TEMPLATES = Object.freeze({
  standard: Object.freeze({
    id: 'standard',
    label: '標準',
    description: '一般的な社内会議向け。概要・議題・決定事項・タスク・未決事項を整理します。',
    focusHint: '概要、議題、決定事項、タスク、未決事項',
    sections: Object.freeze(['summary', 'topics', 'decisions', 'actionItems', 'openIssues']),
    headings: Object.freeze({
      summary: '概要',
      topics: '議題',
      decisions: '決定事項',
      actionItems: 'タスク',
      openIssues: '未決事項',
    }),
  }),
});

export const DEFAULT_TEMPLATE_ID = 'standard';

export function isValidTemplateId(id) {
  return typeof id === 'string' && Object.hasOwn(TEMPLATES, id);
}

export const REGENERATE_TARGETS = Object.freeze({
  ALL: 'all',
  SUMMARY: 'summary',
  DECISIONS: 'decisions',
  ACTION_ITEMS: 'actionItems',
});

export const EVIDENCE_NOT_CONFIRMED = '根拠を確認できません';

export const MOCK_GEMINI = Object.freeze({
  transcript: 'テスト文字起こし',
  todoTask: 'テストタスク',
  minutesBody: 'テスト議事録',
});
