/*
 * 議事録の純粋ロジック（DOMを参照しない。Node からそのまま import できる）。
 *
 * 担当範囲（要件書 §4-3・§4-9・§4-10・§4-12・§4-13）:
 *   (a) 構造化応答の検証・正規化
 *   (b) evidence のクライアント側照合
 *   (c) Markdown 生成
 *   (d) ファイル名生成
 *   (e) 入力検証
 *
 * ==================================================================
 * (b) が本質的な理由
 * ==================================================================
 * 要件書 §4-10 は「根拠はAIが新規に作る引用ではなく、入力文字起こし内の
 * 該当箇所に限る」と定める。しかし、これはプロンプトで指示するだけでは
 * 保証できない（モデルが要約や言い換えを「引用」として返す可能性が残る）。
 * そこで、モデルが返した evidence 文字列を**実際に原文へ対して検索し**、
 * 見つからなければ「根拠を確認できません」へ落とす。この照合が本アプリの
 * 信頼性の核である。
 * ==================================================================
 */

import { LIMITS, TEMPLATES, DEFAULT_TEMPLATE_ID, EVIDENCE_NOT_CONFIRMED, REGENERATE_TARGETS } from './config.js';

/* ================================================================
 * (e) 入力検証（要件書 §4-3）
 * ================================================================ */

/* 文字数はコードポイントで数える（絵文字などのサロゲートペア対策）。 */
export function countChars(text) {
  return Array.from(String(text ?? '')).length;
}

export function isBlank(text) {
  return String(text ?? '').trim() === '';
}

/* 生成前検証のエラー文言。§9-2 の表現をそのまま使う（app.js が流用する）。 */
export const TRANSCRIPT_ERROR = Object.freeze({
  EMPTY: '議事録を生成できません。文字起こしを入力してください。',
  OVER_LIMIT: '議事録を生成できませんでした。文字起こしを短くするか分割してください。',
});

/*
 * 生成前の入力検証。問題があれば §9-2 の文言を返し、無ければ null を返す。
 * 空白のみの入力は「空」として扱う（要件書 §4-3 の表）。
 */
export function validateTranscriptForGeneration(text, { maxChars = LIMITS.TRANSCRIPT_MAX_CHARS } = {}) {
  if (isBlank(text)) {
    return TRANSCRIPT_ERROR.EMPTY;
  }

  if (countChars(text) > maxChars) {
    return TRANSCRIPT_ERROR.OVER_LIMIT;
  }

  return null;
}

/* 上限に近づいたことを早めに知らせるための判定（警告のみ。生成は止めない）。 */
export function isNearTranscriptLimit(text, { warnChars = LIMITS.TRANSCRIPT_WARN_CHARS, maxChars = LIMITS.TRANSCRIPT_MAX_CHARS } = {}) {
  const length = countChars(text);
  return length >= warnChars && length <= maxChars;
}

/*
 * File.size（バイト）だけから、読み込んでも上限超過が確定するかを判定する。
 * UTF-8は1文字あたり最大4バイトのため、上限文字数×4バイトを超えるファイルは
 * 実際に読み込んでも必ず上限超過になる。FileReaderで最後まで読み切ってから
 * validateTranscriptForGeneration に掛けるのではなく、読み込み前にこれで弾く
 * ことで、極端に大きいファイルをそのままDOM/メモリへ展開せずに済む
 * （要件書 §8-4「極端に大きい入力をそのままDOM複製しない」）。
 */
export function exceedsTranscriptByteLimit(fileSizeBytes, { maxChars = LIMITS.TRANSCRIPT_MAX_CHARS } = {}) {
  const size = Number(fileSizeBytes);

  if (!Number.isFinite(size) || size < 0) {
    return false;
  }

  return size > maxChars * 4;
}

/* ---------- ファイル読込みの検証 ---------- */

const ALLOWED_FILE_EXTENSIONS = ['.txt', '.md'];

export function isAllowedTranscriptFileName(name) {
  const value = String(name ?? '').toLowerCase();
  return ALLOWED_FILE_EXTENSIONS.some((ext) => value.endsWith(ext));
}

/* ファイル関連のエラー文言。UNSUPPORTED_EXTENSION は §9-2 の表現をそのまま使う。 */
export const FILE_ERROR = Object.freeze({
  UNSUPPORTED_EXTENSION: 'ファイルを読み込めませんでした。txtまたはmd形式をご確認ください。',
  READ_FAILED: 'ファイルを読み込めませんでした。貼り付け入力でお試しください。',
  BINARY_DETECTED: 'ファイルを読み込めませんでした。テキスト形式のファイルかご確認ください。',
  ENCODING_INVALID: 'ファイルを正しく読み込めませんでした。UTF-8形式で保存し直してください。',
});

/*
 * バイナリと判断する簡易ヒューリスティック。
 *
 * 完全な判定は不可能なので、次の2条件のどちらかで「バイナリらしい」とみなす。
 *   - NUL文字を含む（テキストファイルには通常現れない）
 *   - 制御文字（改行・タブ以外）の比率が高い
 * 先頭2000文字だけを見るのは、長大なテキストで走査コストが問題にならないため。
 */
export function looksBinary(text) {
  const value = String(text ?? '');

  if (value.includes(String.fromCharCode(0))) {
    return true;
  }

  if (value.length === 0) {
    return false;
  }

  const sample = value.slice(0, 2000);
  let controlCount = 0;

  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0;

    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      controlCount += 1;
    }
  }

  return controlCount / sample.length > 0.05;
}

/*
 * 文字コードを正しく解釈できていない兆候（U+FFFD = 置換文字）を検出する。
 * TextDecoder('utf-8') は不正なバイト列を既定で U+FFFD に置き換えるため、
 * 読込み後のテキストにこれが含まれていれば「UTF-8として解釈できなかった」
 * とみなせる。
 */
export function looksMisdecoded(text) {
  return String(text ?? '').includes('�');
}

/* ---------- 会議情報の補助 ---------- */

/* 参加者欄（改行・カンマ・読点区切り）を配列へ分解する。 */
export function parseParticipants(text) {
  return String(text ?? '')
    .split(/[\n,、]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/* ================================================================
 * (a) 構造化応答の検証・正規化（要件書 §4-9）
 * ================================================================
 *
 * 「未知項目無視」「必須項目チェック」を行う。ここでの必須は
 * 「トップレベルがオブジェクトであること」のみとし、各項目（配列・文字列）は
 * 欠けていても空として扱う。モデルが一部項目を省略しても画面を壊さないため
 * （厳格に例外を投げるのは gemini.js 側の役目 = 応答そのものが不正なとき）。
 * ================================================================ */

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asTextArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => asText(item)).filter((item) => item !== '');
}

export function normalizeMeetingInfo(raw) {
  const meeting = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  return {
    title: asText(meeting.title),
    date: asText(meeting.date),
    time: asText(meeting.time),
    participants: asTextArray(meeting.participants),
    purpose: asText(meeting.purpose),
  };
}

/*
 * 利用者がステップ1で入力した会議情報と、AIが文字起こしから抽出した
 * meeting情報を統合する。
 *
 * **利用者入力を優先する。** 利用者が明示的に入力した値は、原文からの
 * 抽出より確からしい（要件書 §4-4「未入力の項目をAIに推測させない」）。
 * 利用者が空欄のままにした項目だけ、AIが原文から明確に特定できた値
 * （見つからなければ空文字）で補う。
 */
export function mergeMeetingInfo(userInfo, aiMeeting) {
  const user = userInfo && typeof userInfo === 'object' ? userInfo : {};
  const ai = normalizeMeetingInfo(aiMeeting);
  const userParticipants = Array.isArray(user.participants) ? user.participants : [];
  const userTitle = asText(user.title);
  const userDate = asText(user.date);
  const userTime = asText(user.time);
  const userPurpose = asText(user.purpose);

  return {
    title: userTitle !== '' ? userTitle : ai.title,
    date: userDate !== '' ? userDate : ai.date,
    time: userTime !== '' ? userTime : ai.time,
    participants: userParticipants.length > 0 ? userParticipants : ai.participants,
    purpose: userPurpose !== '' ? userPurpose : ai.purpose,
  };
}

export function normalizeTopics(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => ({
      title: asText(item?.title),
      summary: asText(item?.summary),
      keyPoints: asTextArray(item?.keyPoints),
    }))
    .filter((topic) => topic.title !== '' || topic.summary !== '' || topic.keyPoints.length > 0);
}

export function normalizeDecisions(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => ({
      decision: asText(item?.decision),
      evidence: asText(item?.evidence),
    }))
    .filter((item) => item.decision !== '');
}

export function normalizeActionItems(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => ({
      task: asText(item?.task),
      /* 不明な担当者・期限を推測しない（要件書 §4-8）。空文字のまま保持する。 */
      assignee: asText(item?.assignee),
      dueDate: asText(item?.dueDate),
      evidence: asText(item?.evidence),
    }))
    .filter((item) => item.task !== '');
}

/*
 * 構造化応答の正規化本体。
 * トップレベルがオブジェクトでない場合のみ例外にする（応答そのものが不正）。
 * gemini.js はこれを呼び、失敗を「不正なJSON」として扱う。
 */
export function normalizeMinutesResponse(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('minutes_response_not_object');
  }

  return {
    meeting: normalizeMeetingInfo(raw.meeting),
    summary: asText(raw.summary),
    topics: normalizeTopics(raw.topics),
    decisions: normalizeDecisions(raw.decisions),
    actionItems: normalizeActionItems(raw.actionItems),
    openIssues: asTextArray(raw.openIssues),
    notes: asTextArray(raw.notes),
  };
}

/* ドラフトの初期値・引継ぎ直後の初期値として使う空の議事録。 */
export function createEmptyMinutes() {
  return {
    meeting: { title: '', date: '', time: '', participants: [], purpose: '' },
    summary: '',
    topics: [],
    decisions: [],
    actionItems: [],
    openIssues: [],
    notes: [],
  };
}

/*
 * 編集画面の「追加」操作用の空要素。evidence は検証済みの形
 * （{ text, confirmed, timestamp }）で揃える。利用者が手で追加した項目は
 * 原文由来ではないため、最初から confirmed: false（根拠を確認できません）
 * とする。
 */
export function createEmptyTopic() {
  return { title: '', summary: '', keyPoints: [] };
}

export function createEmptyDecision() {
  return { decision: '', evidence: { text: '', confirmed: false, timestamp: undefined, locatable: false } };
}

export function createEmptyActionItem() {
  return {
    task: '', assignee: '', dueDate: '',
    evidence: { text: '', confirmed: false, timestamp: undefined, locatable: false },
  };
}

/* ================================================================
 * (b) evidence のクライアント側照合（要件書 §4-10）
 * ================================================================ */

function collapseWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/*
 * 原文（transcript）に evidence 文字列が実在するかを検索する。
 *
 * まず完全一致（部分文字列）を試す。見つからない場合、改行位置や
 * 全角/半角スペースの揺れだけを吸収した比較を行う。ただしこの二次照合では
 * 元の文字列中の正確な位置が分からないため、タイムスタンプの案内はしない
 * （不正確な位置を出すより、位置なしのほうが安全）。
 *
 * 完全一致が原文内に複数箇所あった場合は multiple: true を返す。
 * この場合、どの出現がAIの根拠なのかをクライアント側では特定できないため、
 * 呼び出し側（verifyEvidence）は timestamp を案内しない（§4-10「擬似的な
 * 時刻を生成しない」の趣旨。1件目に決め打ちしても外れる可能性があるため）。
 */
export function findEvidenceInTranscript(evidence, transcript) {
  const needle = String(evidence ?? '').trim();
  const haystack = String(transcript ?? '');

  if (needle === '') {
    return { found: false, index: -1, multiple: false };
  }

  const exactIndex = haystack.indexOf(needle);

  if (exactIndex !== -1) {
    const multiple = haystack.indexOf(needle, exactIndex + 1) !== -1;
    return { found: true, index: exactIndex, multiple };
  }

  const normalizedNeedle = collapseWhitespace(needle);
  const normalizedHaystack = collapseWhitespace(haystack);

  if (normalizedNeedle !== '' && normalizedHaystack.includes(normalizedNeedle)) {
    return { found: true, index: -1, multiple: false };
  }

  return { found: false, index: -1, multiple: false };
}

/*
 * [00:00:00] 形式のタイムスタンプを、根拠の直前から遡って探す。
 * 見つからない場合は undefined を返す（擬似時刻は生成しない。要件書 §4-10）。
 */
const TIMESTAMP_PATTERN = /\[(\d{2}):(\d{2}):(\d{2})\]/g;

export function findPrecedingTimestamp(transcript, atIndex) {
  const text = String(transcript ?? '');

  if (!Number.isFinite(atIndex) || atIndex < 0) {
    return undefined;
  }

  let found;

  TIMESTAMP_PATTERN.lastIndex = 0;

  for (let match = TIMESTAMP_PATTERN.exec(text); match !== null; match = TIMESTAMP_PATTERN.exec(text)) {
    if (match.index > atIndex) {
      break;
    }

    found = match[0];
  }

  return found;
}

/*
 * 根拠として短すぎる文字列は、原文中に偶然一致しても「その決定・タスクの
 * 根拠」として信頼できない（例: 「はい」「そうですね」等はほぼ確実に原文の
 * 複数箇所へ一致する）。この閾値未満は原文照合を試みるまでもなく
 * confirmed: false とする。
 */
const MIN_EVIDENCE_CHARS = 10;

/*
 * 1件の根拠文字列を検証し、表示用の形へ変換する。
 * 戻り値: { text, confirmed, timestamp, locatable }
 *   text        … モデルが返した根拠の原文（見つからなくても保持する。
 *                 利用者が原文検索する際の手がかりとして残すため）
 *   confirmed   … 原文中に実在が確認できたか
 *   timestamp   … 直前のタイムスタンプ（原文に無ければ undefined。原文内に
 *                 完全一致が複数あり位置を断定できない場合も undefined）
 *   locatable   … 原文中の位置（index）を特定できたか。app.js はこれが
 *                 true の場合のみ「原文で確認」ボタンを出す。空白正規化の
 *                 二次照合で確認できた場合は、原文中の厳密な部分文字列と
 *                 一致しない（indexOf で再検索できない）ため false になる。
 */
export function verifyEvidence(evidenceText, transcript) {
  const text = String(evidenceText ?? '').trim();

  if (text === '') {
    return { text: '', confirmed: false, timestamp: undefined, locatable: false };
  }

  if (countChars(text) < MIN_EVIDENCE_CHARS) {
    return { text, confirmed: false, timestamp: undefined, locatable: false };
  }

  const { found, index, multiple } = findEvidenceInTranscript(text, transcript);

  if (!found) {
    return { text, confirmed: false, timestamp: undefined, locatable: false };
  }

  const locatable = index !== -1;

  return {
    text,
    confirmed: true,
    timestamp: multiple ? undefined : findPrecedingTimestamp(transcript, index),
    locatable,
  };
}

/*
 * 議事録全体（decisions / actionItems）の evidence を、原文照合済みの
 * オブジェクト形へ差し替える。normalizeMinutesResponse の直後、
 * app.js から呼ぶ想定。
 */
export function verifyMinutesEvidence(minutes, transcript) {
  return {
    ...minutes,
    decisions: minutes.decisions.map((item) => ({
      ...item,
      evidence: verifyEvidence(item.evidence, transcript),
    })),
    actionItems: minutes.actionItems.map((item) => ({
      ...item,
      evidence: verifyEvidence(item.evidence, transcript),
    })),
  };
}

/*
 * 端末内ドラフト（IndexedDB）から読み戻した minutes を検証・正規化する。
 *
 * ドラフトの minutes は normalizeMinutesResponse が扱う「AI応答そのまま」の形
 * ではなく、evidence がすでに検証済みオブジェクト（{ text, confirmed,
 * timestamp, locatable }）に差し替わった後の形である。そのため
 * normalizeMinutesResponse をそのまま再利用すると、evidence を文字列として
 * 扱う asText() が「オブジェクトだから空文字」と誤判定し、根拠情報を消して
 * しまう。IndexedDB の中身は開発者ツール等での改変を含め信頼できない入力
 * （handoff.js の validateHandoffPayload と同じ考え方）のため、専用の
 * 正規化関数で受け直す。
 *
 * トップレベルがオブジェクトでない場合は null を返す（呼び出し側はドラフト
 * を破棄し、§9-2 の文型で案内する）。
 */
function normalizeStoredEvidence(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const text = asText(value.text);
  const confirmed = value.confirmed === true && text !== '';

  return {
    text,
    confirmed,
    timestamp: confirmed && typeof value.timestamp === 'string' && value.timestamp !== '' ? value.timestamp : undefined,
    locatable: confirmed && value.locatable === true,
  };
}

function normalizeStoredDecisions(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => ({ decision: asText(item?.decision), evidence: normalizeStoredEvidence(item?.evidence) }))
    .filter((item) => item.decision !== '');
}

function normalizeStoredActionItems(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => ({
      task: asText(item?.task),
      assignee: asText(item?.assignee),
      dueDate: asText(item?.dueDate),
      evidence: normalizeStoredEvidence(item?.evidence),
    }))
    .filter((item) => item.task !== '');
}

export function normalizeStoredMinutes(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  return {
    meeting: normalizeMeetingInfo(raw.meeting),
    summary: asText(raw.summary),
    topics: normalizeTopics(raw.topics),
    decisions: normalizeStoredDecisions(raw.decisions),
    actionItems: normalizeStoredActionItems(raw.actionItems),
    openIssues: asTextArray(raw.openIssues),
    notes: asTextArray(raw.notes),
  };
}

/*
 * 根拠オブジェクトを表示用の1行へ変換する。Markdown化・app.js の根拠確認UIの
 * 両方から使う共通の表示ロジック（要件書 §4-10「根拠が見つからない項目は
 * 『根拠を確認できません』と表示する」）。
 */
export function describeEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || !evidence.confirmed) {
    return EVIDENCE_NOT_CONFIRMED;
  }

  return evidence.timestamp ? `${evidence.timestamp} ${evidence.text}` : evidence.text;
}

/* ================================================================
 * (c) Markdown 生成（要件書 §4-9・§4-5）
 * ================================================================
 *
 * evidence は既定で省略する（§4-9「完成版Markdownへの出力は既定で省略して
 * よい」）。出力するのは確認・編集画面の根拠確認UIであり、Markdown化は
 * 別工程として includeEvidence オプションで明示したときだけ含める。
 * ================================================================ */

function formatMetaLine(label, value) {
  return `- ${label}: ${value !== '' ? value : '記載なし'}`;
}

export function buildMeetingSection(meeting) {
  const info = meeting ?? createEmptyMinutes().meeting;
  const lines = [
    '## 会議情報',
    formatMetaLine('会議名', info.title),
    formatMetaLine('開催日', info.date),
    formatMetaLine('時間', info.time),
    `- 参加者: ${info.participants.length > 0 ? info.participants.join('、') : '記載なし'}`,
    formatMetaLine('目的', info.purpose),
  ];

  return lines.join('\n');
}

function renderSummarySection(heading, summary) {
  return `## ${heading}\n\n${summary !== '' ? summary : '記載なし'}`;
}

function renderTopicsSection(heading, topics) {
  if (topics.length === 0) {
    return `## ${heading}\n\n記載なし`;
  }

  const body = topics
    .map((topic) => {
      const title = topic.title !== '' ? topic.title : '（見出しなし）';
      const parts = [`### ${title}`];

      if (topic.summary !== '') {
        parts.push(topic.summary);
      }

      if (topic.keyPoints.length > 0) {
        parts.push(topic.keyPoints.map((point) => `- ${point}`).join('\n'));
      }

      return parts.join('\n\n');
    })
    .join('\n\n');

  return `## ${heading}\n\n${body}`;
}

function renderDecisionsSection(heading, decisions, includeEvidence) {
  if (decisions.length === 0) {
    return `## ${heading}\n\n記載なし`;
  }

  const lines = decisions.map((item) => {
    const base = `- ${item.decision}`;
    return includeEvidence ? `${base}\n  - 根拠: ${describeEvidence(item.evidence)}` : base;
  });

  return `## ${heading}\n\n${lines.join('\n')}`;
}

function renderActionItemsSection(heading, actionItems, includeEvidence) {
  if (actionItems.length === 0) {
    return `## ${heading}\n\n記載なし`;
  }

  const lines = actionItems.map((item) => {
    const assignee = item.assignee !== '' ? item.assignee : '不明';
    const dueDate = item.dueDate !== '' ? item.dueDate : '不明';
    const base = `- ${item.task}（担当: ${assignee} / 期限: ${dueDate}）`;
    return includeEvidence ? `${base}\n  - 根拠: ${describeEvidence(item.evidence)}` : base;
  });

  return `## ${heading}\n\n${lines.join('\n')}`;
}

function renderListSection(heading, items) {
  if (items.length === 0) {
    return `## ${heading}\n\n記載なし`;
  }

  return `## ${heading}\n\n${items.map((item) => `- ${item}`).join('\n')}`;
}

/*
 * 議事録全体を Markdown へ変換する。
 * テンプレートの sections/headings（config.js）に従って出す項目と見出しを決める。
 */
export function buildMarkdown(minutes, { templateId = DEFAULT_TEMPLATE_ID, includeEvidence = false } = {}) {
  const data = minutes ?? createEmptyMinutes();
  const template = TEMPLATES[templateId] ?? TEMPLATES[DEFAULT_TEMPLATE_ID];

  const blocks = [
    `# ${data.meeting.title !== '' ? data.meeting.title : '議事録'}`,
    buildMeetingSection(data.meeting),
  ];

  for (const key of template.sections) {
    const heading = template.headings[key] ?? key;

    switch (key) {
      case 'summary':
        blocks.push(renderSummarySection(heading, data.summary));
        break;
      case 'topics':
        blocks.push(renderTopicsSection(heading, data.topics));
        break;
      case 'decisions':
        blocks.push(renderDecisionsSection(heading, data.decisions, includeEvidence));
        break;
      case 'actionItems':
        blocks.push(renderActionItemsSection(heading, data.actionItems, includeEvidence));
        break;
      case 'openIssues':
        blocks.push(renderListSection(heading, data.openIssues));
        break;
      case 'notes':
        blocks.push(renderListSection(heading, data.notes));
        break;
      default:
        break;
    }
  }

  return blocks.join('\n\n');
}

/* ================================================================
 * (d) ファイル名生成（要件書 §4-13）
 * ================================================================ */

/* Windows/macOSどちらでも使えない文字と制御文字を安全な文字へ置換する。 */
const FILENAME_UNSAFE_PATTERN = /[\\/:*?"<>|\x00-\x1f]/g;

function sanitizeForFileName(text) {
  return String(text ?? '')
    .replace(FILENAME_UNSAFE_PATTERN, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDateForFileName(now) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/*
 * 既定のファイル名。
 *   会議名あり: YYYY-MM-DD_会議名_議事録.md
 *   会議名なし: YYYY-MM-DD_議事録.md
 * date が YYYY-MM-DD 形式でない場合は、生成時刻（now）から日付を補う
 * （ファイル名には常に日付が要るため。§4-13 は「未入力時」の定めが無いため、
 * 安全側として実装時に補完する判断とする）。
 */
export function buildMinutesFileName({ date, title, now = new Date() } = {}) {
  const safeDate = sanitizeForFileName(date);
  const datePart = /^\d{4}-\d{2}-\d{2}$/.test(safeDate) ? safeDate : formatDateForFileName(now);
  /* 長すぎるファイル名を避けるため、会議名は先頭60文字までに丸める。 */
  const safeTitle = sanitizeForFileName(title).slice(0, 60);

  return safeTitle !== '' ? `${datePart}_${safeTitle}_議事録.md` : `${datePart}_議事録.md`;
}

/* ================================================================
 * 再生成のマージ（要件書 §4-12）
 * ================================================================
 *
 * 「全体」以外は、対象セクションだけを新しい応答へ差し替え、
 * それ以外は現在の（編集済みかもしれない）内容をそのまま保持する。
 * ================================================================ */

export function mergeMinutesSection(current, incoming, target = REGENERATE_TARGETS.ALL) {
  const base = current ?? createEmptyMinutes();
  const next = incoming ?? createEmptyMinutes();

  switch (target) {
    case REGENERATE_TARGETS.ALL:
      return next;
    case REGENERATE_TARGETS.SUMMARY:
      return { ...base, summary: next.summary };
    case REGENERATE_TARGETS.DECISIONS:
      return { ...base, decisions: next.decisions };
    case REGENERATE_TARGETS.ACTION_ITEMS:
      return { ...base, actionItems: next.actionItems };
    default:
      return base;
  }
}
