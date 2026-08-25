/*
 * 共通 AI 処理。録音方法ごとの分岐は持たない。
 *
 *   音声 → Gemini入口 → 文字起こし → To Do → 議事録 → Markdown
 *
 * 実 Gemini 呼び出しは既存の
 *   audio-transcriber/gemini-transcriber.js
 *   meeting-minutes/gemini.js
 * を使う。テストでは mock: true で固定結果を返し、API を叩かない。
 */

import { DEFAULT_MODEL, MOCK_GEMINI } from './config.js';
import { transcribeWithGemini } from './gemini-transcriber.js';
import { generateMinutes } from './gemini-minutes.js';
import { verifyMinutesEvidence } from './minutes-logic.js';
import { buildMarkdown, formatMinutesSection, formatTodoSection } from './markdown.js';

export function isMockGeminiEnabled({ mock } = {}) {
  if (mock === true) {
    return true;
  }

  if (mock === false) {
    return false;
  }

  try {
    const host = globalThis.location?.hostname ?? '';
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

    if (!isLocal) {
      return false;
    }

    return new URLSearchParams(globalThis.location?.search ?? '').get('mockGemini') === '1';
  } catch {
    return false;
  }
}

export function buildMockResult({ audioUrl } = {}) {
  const minutes = {
    summary: MOCK_GEMINI.minutesBody,
    topics: [],
    decisions: [],
    actionItems: [{ task: MOCK_GEMINI.todoTask, assignee: '', dueDate: '' }],
    openIssues: [],
  };

  return {
    mock: true,
    transcript: MOCK_GEMINI.transcript,
    minutes,
    markdown: buildMarkdown({
      audioUrl,
      actionItems: minutes.actionItems,
      minutes,
      transcript: MOCK_GEMINI.transcript,
    }),
  };
}

export async function runGeminiPipeline({
  blob,
  displayName,
  apiKey,
  audioUrl,
  mock,
  signal,
  onProgress,
} = {}) {
  if (isMockGeminiEnabled({ mock })) {
    onProgress?.({ phase: 'mock' });
    return buildMockResult({ audioUrl });
  }

  const key = String(apiKey ?? '').trim();

  if (key === '') {
    const error = new Error('api_key_missing');
    error.code = 'API_KEY_MISSING';
    throw error;
  }

  onProgress?.({ phase: 'transcribing' });

  const transcribed = await transcribeWithGemini(blob, {
    apiKey: key,
    displayName,
    preferredModelId: DEFAULT_MODEL,
    language: 'ja',
    withTimestamps: true,
    signal,
    onProgress,
  });

  onProgress?.({ phase: 'minutes' });

  const generated = await generateMinutes({
    apiKey: key,
    transcript: transcribed.text,
    templateId: 'standard',
    model: DEFAULT_MODEL,
    signal,
  });

  const minutes = verifyMinutesEvidence(generated, transcribed.text);

  onProgress?.({ phase: 'markdown' });

  return {
    mock: false,
    transcript: transcribed.text,
    modelId: transcribed.modelId,
    minutes,
    markdown: buildMarkdown({
      audioUrl,
      actionItems: minutes.actionItems,
      minutes,
      transcript: transcribed.text,
    }),
    todoText: formatTodoSection(minutes.actionItems),
    minutesText: formatMinutesSection(minutes),
  };
}
