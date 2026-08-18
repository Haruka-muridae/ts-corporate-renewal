/*
 * AI議事録アプリの静的設定。**設定値を変えるのはこのファイルだけ。**
 *
 * note-post / threads-post / card-ocr と同じく、定数を1本へ集約する。
 * **秘密情報を置かない。** ここは公開URLから読める（静的ホスティング）。
 * APIキーは KeyStore（../../auth/keystore.js）だけが扱い、ここには現れない。
 *
 * 正となる文書: docs/specs/meeting-minutes-requirements-v1.md（以下「要件書」）。
 */

/* サイトのルートから見た、このアプリの深さ（production-app/meeting-minutes/ → 2）。 */
export const SCREEN_DEPTH = 2;

/* ================================================================
 * Gemini のモデルとエンドポイント（他の本番アプリと同じ選定・同じ切替条件）
 * ================================================================
 *
 * 主モデルが 404（廃止）のときだけ gemini.js がフォールバックへ切り替える。
 * 503（混雑）では切り替えない。混雑は待って直すものだからである
 * （threads-post/config.js・card-ocr/config.js と同じ方針）。
 */
export const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
export const FALLBACK_MODEL = 'gemini-3.5-flash-lite';

export const GEMINI_HOST = 'generativelanguage.googleapis.com';
export const GEMINI_ENDPOINT_BASE = `https://${GEMINI_HOST}/v1beta/models`;

/*
 * 応答の出力上限（トークン）。
 * 議事録は複数セクション（議題別要旨・決定事項・タスク等）を含む構造化JSONで、
 * 名刺OCRの1件抽出より大きい。長い会議・議題が多い会議でも打ち切れないよう
 * 余裕を持たせる（切れるとJSONが壊れ、AI-003 の再生成対象になる）。
 */
export const MAX_OUTPUT_TOKENS = 8192;

/* ================================================================
 * 入力上限（要件書 §4-3・§14「入力上限」）
 * ================================================================
 *
 * **上限値をUI文言へ直書きしない**（要件書 §4-3）。画面は必ずこの定数を
 * textContent で差し込むこと。
 *
 * 目安の根拠: 日本語の会話は概ね 400字/分前後で文字起こしされる
 * （audio-transcriber の実測ログはないため、一般的な発話速度からの見積り）。
 * 60,000字は約2.5時間の会議に相当し、voice-recorder / audio-transcriber が
 * 想定する長時間録音を概ねカバーする。これを超える入力は分割を案内する
 * （モデルの入力上限そのものではなく、プロンプト分の余白とブラウザでの
 * 編集・検索操作の快適さを考慮した安全側の値）。
 */
export const LIMITS = Object.freeze({
  /* この文字数を超えたら生成前に警告し、短縮・分割を案内する。 */
  TRANSCRIPT_MAX_CHARS: 60000,
  /* 上限に近づいたことを早めに知らせる閾値（上限の75%）。 */
  TRANSCRIPT_WARN_CHARS: 45000,
});

/* ================================================================
 * アプリ間引継ぎ（要件書 §5-2・§5-3）
 * ================================================================
 *
 * audio-transcriber → meeting-minutes の一時データ。sessionStorage を使う
 * （タブを閉じれば自動で消え、localStorage のように恒久保存にならないため。
 * 要件書 §5-3「本文そのものをlocalStorageへ恒久保存する方式は避ける」）。
 *
 * **このキー名は audio-transcriber 側の実装とも一致させること**
 * （audio-transcriber 側に書き込み処理を追加する際は、この値を参照する）。
 */
export const HANDOFF_KEY = 'tsam-meeting-minutes-handoff-v1';

/* 引継ぎデータの有効期限（createdAt からの経過時間）。 */
export const HANDOFF_TTL_MS = 30 * 60 * 1000;

/*
 * 受け付ける引継ぎデータのメジャーバージョン。
 * データの version がこれと異なる場合は取り込まない（要件書 §5-2）。
 */
export const HANDOFF_MAJOR_VERSION = 1;

/* 引継ぎの送信元として許可するアプリID（要件書 §5-2）。 */
export const HANDOFF_SOURCE_APP = 'audio-transcriber';

/* ================================================================
 * 端末内ドラフト（要件書 §4-14）
 * ================================================================
 *
 * 原文を含みうるため IndexedDB を使う（localStorage は容量が小さく、
 * 大容量の原文向けではないという要件書の指示に従う）。
 *
 * 名前は voice-recorder 側の notifier-config.js の作法にならい、
 * `tsam-` 接頭辞＋アプリ名で他アプリの保存領域と衝突しないようにする。
 */
export const DRAFT_DB_NAME = 'tsam-meeting-minutes-draft';
export const DRAFT_DB_VERSION = 1;
export const DRAFT_STORE_NAME = 'draft';
/* ドラフトは常に1件（複数ドラフトの管理はMVPに含めない）。 */
export const DRAFT_RECORD_KEY = 'current';

/*
 * 自動保存の有無と間隔（要件書 §4-14「実装時にUIと合わせて定数化する」）。
 * 入力のたびに保存すると大きな原文で保存が頻発するため、
 * デバウンスして間隔をあける。
 */
export const DRAFT_AUTOSAVE = Object.freeze({
  enabled: true,
  debounceMs: 2000,
});

/* ================================================================
 * 議事録テンプレート（要件書 §4-5）
 * ================================================================
 *
 * MVPは固定4種のプリセットで、利用者による編集は行わない。
 *
 * 内部の構造化データは常に共通スキーマ（gemini.js の MINUTES_SCHEMA。
 * meeting/summary/topics/decisions/actionItems/openIssues/notes）を使う。
 * テンプレートごとに変わるのは「どの項目を、どの見出しでMarkdownへ出すか」
 * であり、`sections` と `headings` がその対応表になる。
 *
 * 1on1・面談テンプレートは要件書 §4-5 の項目名（話題／本人の認識／
 * 合意事項／次回までの行動）が共通スキーマの語彙と異なるため、次のように
 * 写像している。
 *   話題           → topics（議題別の話題）
 *   本人の認識     → notes（構造化しにくい所感・認識を自由記述で拾う）
 *   合意事項       → decisions（1on1における「合意」を決定事項として扱う）
 *   次回までの行動 → actionItems（次回までの行動をタスクとして扱う）
 */
export const TEMPLATES = Object.freeze({
  standard: Object.freeze({
    id: 'standard',
    label: '標準',
    description: '一般的な社内会議向け。概要・議題・決定事項・タスク・未決事項を整理します。',
    /* 生成時にモデルへ伝える「主な出力項目」（要件書 §4-5 の表現をそのまま使う）。 */
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
  concise: Object.freeze({
    id: 'concise',
    label: '要点重視',
    description: '短時間で内容を確認したいとき向け。要約・決定事項・タスクだけに絞ります。',
    focusHint: '要約、決定事項、タスク',
    sections: Object.freeze(['summary', 'decisions', 'actionItems']),
    headings: Object.freeze({
      summary: '要約',
      decisions: '決定事項',
      actionItems: 'タスク',
    }),
  }),
  detailed: Object.freeze({
    id: 'detailed',
    label: '詳細',
    description: '経緯を残したい会議向け。議題別の要旨・主な意見・決定事項・タスク・未決事項を残します。',
    focusHint: '議題別の要旨、主な意見、決定事項、タスク、未決事項',
    sections: Object.freeze(['topics', 'decisions', 'actionItems', 'openIssues']),
    headings: Object.freeze({
      topics: '議題別の要旨',
      decisions: '決定事項',
      actionItems: 'タスク',
      openIssues: '未決事項',
    }),
  }),
  'one-on-one': Object.freeze({
    id: 'one-on-one',
    label: '1on1・面談',
    description: '面談や定期対話向け。話題・本人の認識・合意事項・次回までの行動を残します。',
    focusHint: '話題、本人の認識、合意事項、次回までの行動',
    sections: Object.freeze(['topics', 'notes', 'decisions', 'actionItems']),
    headings: Object.freeze({
      topics: '話題',
      notes: '本人の認識',
      decisions: '合意事項',
      actionItems: '次回までの行動',
    }),
  }),
});

export const DEFAULT_TEMPLATE_ID = 'standard';

export function isValidTemplateId(id) {
  return typeof id === 'string' && Object.hasOwn(TEMPLATES, id);
}

/* ================================================================
 * 再生成の対象（要件書 §4-12）
 * ================================================================
 * 「全体」「要約のみ」「決定事項のみ」「タスクのみ」の4択。
 * 値は minutes.js の mergeMinutesSection() がそのまま参照する。
 */
export const REGENERATE_TARGETS = Object.freeze({
  ALL: 'all',
  SUMMARY: 'summary',
  DECISIONS: 'decisions',
  ACTION_ITEMS: 'actionItems',
});

/* 根拠が原文中に見つからなかったときの表示文言（要件書 §4-10）。 */
export const EVIDENCE_NOT_CONFIRMED = '根拠を確認できません';

/* ================================================================
 * Googleドライブへの保存（要件書 §4-15）
 * ================================================================
 *
 * スコープは drive.file のみ。ドライブ全体が見えるスコープは要求しない。
 * このスコープで見えるのは「同じOAuthクライアントのアプリが作成したファイル」
 * だけである。
 *
 * クライアントIDは録音アプリ（production-app/voice-recorder/config.js）・
 * 音声文字起こしアプリ（production-app/audio-transcriber/config.js）と
 * **意図的に同一のものを使う**。本アプリは録音→文字起こし→議事録という
 * 同じ作業の後段であり、同一クライアントにしておくことで、
 *   - 承認済みオリジンの設定を追加せずに済む
 *   - 将来、文字起こしTXT（Audio Transcriber フォルダ）を本アプリから
 *     直接読む拡張が drive.file のままで成立する
 * ためである。名刺系（card-ocr / card-mail）が別クライアントを共用している
 * のと同じ「機能系統ごとの共用」の判断（一致は tests/unit/meeting-minutes.mjs
 * で検知する）。
 *
 * クライアントIDは公開値であり、実質的な防御は Google Cloud 側の
 * 「承認済みの JavaScript 生成元」。client secret はここへ貼らないこと
 * （暗黙フローでは不要で、静的サイトに秘密は置けない）。
 */
export const OAUTH = Object.freeze({
  clientId: '603018562548-j2he1aeo96p2igqfk65gaevj55pdaikc.apps.googleusercontent.com',
  scope: 'https://www.googleapis.com/auth/drive.file',
});

export function isOauthConfigured(clientId = OAUTH.clientId) {
  return typeof clientId === 'string' && clientId.trim().endsWith('.apps.googleusercontent.com');
}

/*
 * 保存先フォルダの名前。フォルダIDは持たない。
 * IDは利用者ごとに異なるため、毎回「名前と親の関係」から解決する
 * （drive-client.js。voice-recorder / audio-transcriber と同じ流儀）。
 *
 * root は録音アプリ・文字起こしアプリの DRIVE_NAMES.root と同名であること。
 * **片方だけ変えないこと。** 名前がずれると、同じ場所を指しているつもりで
 * 別のフォルダを見ることになる（一致はテストで検知する）。
 */
export const DRIVE_NAMES = Object.freeze({
  /* マイドライブ直下に置く最上位フォルダ。 */
  root: 'TSAM AI',

  /* TSAM AI 直下。このアプリが議事録（.md）を保存する場所。初回保存時に作成する。 */
  minutes: '議事録データ',
});
