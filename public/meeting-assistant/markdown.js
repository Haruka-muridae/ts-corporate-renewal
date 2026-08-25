/*
 * Markdown の組み立てと、音声／議事録の対応関係。
 * Drive URL は呼び出し側が渡す。Gemini に生成させない。
 *
 * 順番は必ず 引用元 → To Do → 議事録 → 文字起こし。
 */

export function fileStem(name) {
  const value = String(name ?? '').trim();
  const lastDot = value.lastIndexOf('.');

  if (lastDot <= 0) {
    return value;
  }

  return value.slice(0, lastDot);
}

export function toMarkdownFileName(audioName) {
  const value = String(audioName ?? '').trim();

  if (value === '') {
    return 'untitled.md';
  }

  if (/\.md$/i.test(value)) {
    return value.replace(/\.md$/i, '.md');
  }

  const stem = fileStem(value);
  return `${stem === '' ? value : stem}.md`;
}

export function isSameStem(left, right) {
  return fileStem(left) === fileStem(right) && fileStem(left) !== '';
}

export function findMatchingMarkdown(audioName, markdownFiles) {
  const files = Array.isArray(markdownFiles) ? markdownFiles : [];
  return files.find((file) => isSameStem(audioName, file?.name ?? file)) ?? null;
}

export function isProcessed(audioName, markdownFiles) {
  return findMatchingMarkdown(audioName, markdownFiles) !== null;
}

function asLines(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter((item) => item !== '');
  }

  const text = String(value ?? '').trim();
  return text === '' ? [] : [text];
}

export function formatTodoSection(actionItems) {
  const items = Array.isArray(actionItems) ? actionItems : [];
  const lines = [];

  for (const item of items) {
    const task = String(item?.task ?? '').trim();

    if (task === '') {
      continue;
    }

    const bits = [];
    const assignee = String(item?.assignee ?? '').trim();
    const dueDate = String(item?.dueDate ?? '').trim();

    if (assignee !== '') {
      bits.push(`担当: ${assignee}`);
    }

    if (dueDate !== '') {
      bits.push(`期限: ${dueDate}`);
    }

    lines.push(bits.length > 0 ? `- ${task}（${bits.join(' / ')}）` : `- ${task}`);
  }

  return lines.length > 0 ? lines.join('\n') : 'なし';
}

export function formatMinutesSection(minutes) {
  const data = minutes && typeof minutes === 'object' ? minutes : {};
  const blocks = [];

  const topics = Array.isArray(data.topics) ? data.topics : [];
  const topicLines = topics
    .map((topic) => {
      const title = String(topic?.title ?? '').trim();
      const summary = String(topic?.summary ?? '').trim();

      if (title === '' && summary === '') {
        return '';
      }

      if (title !== '' && summary !== '') {
        return `- ${title}: ${summary}`;
      }

      return `- ${title || summary}`;
    })
    .filter((line) => line !== '');

  blocks.push('## 主な議題');
  blocks.push('');
  blocks.push(topicLines.length > 0 ? topicLines.join('\n') : 'なし');
  blocks.push('');
  blocks.push('## 話し合った内容');
  blocks.push('');
  blocks.push(String(data.summary ?? '').trim() || 'なし');
  blocks.push('');
  blocks.push('## 決定事項');
  blocks.push('');

  const decisions = Array.isArray(data.decisions) ? data.decisions : [];
  const decisionLines = decisions
    .map((item) => String(item?.decision ?? item ?? '').trim())
    .filter((item) => item !== '')
    .map((item) => `- ${item}`);

  blocks.push(decisionLines.length > 0 ? decisionLines.join('\n') : 'なし');
  blocks.push('');
  blocks.push('## 保留事項');
  blocks.push('');

  const openIssues = asLines(data.openIssues);
  blocks.push(openIssues.length > 0 ? openIssues.map((item) => `- ${item}`).join('\n') : 'なし');

  return blocks.join('\n');
}

export function buildMarkdown({
  audioUrl,
  actionItems,
  minutes,
  transcript,
  todoText,
  minutesText,
} = {}) {
  const url = String(audioUrl ?? '').trim() || '（URL未取得）';
  const todoSection = todoText == null ? formatTodoSection(actionItems) : String(todoText);
  const minutesSection = minutesText == null ? formatMinutesSection(minutes) : String(minutesText);
  const transcriptSection = String(transcript ?? '').trim() || 'なし';

  return [
    '# 引用元',
    '',
    `音声ファイル: ${url}`,
    '',
    '# To Do',
    '',
    todoSection,
    '',
    '# 議事録',
    '',
    minutesSection,
    '',
    '# 文字起こし',
    '',
    transcriptSection,
    '',
  ].join('\n');
}

export function markdownSectionOrder(markdown) {
  const headings = [];
  const pattern = /^# (.+)$/gm;
  let match = pattern.exec(String(markdown ?? ''));

  while (match) {
    headings.push(match[1]);
    match = pattern.exec(String(markdown ?? ''));
  }

  return headings;
}
