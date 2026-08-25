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

import { LIMITS, TEMPLATES, DEFAULT_TEMPLATE_ID, EVIDENCE_NOT_CONFIRMED } from './config.js';

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

