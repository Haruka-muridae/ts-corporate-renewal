/*
 * 画面の組み立て（note 下書き）。
 *
 * 起動の約束（他の本番アプリと同じ）:
 *   1. setScreenDepth(2) … /production-app/note-post/ はルートから2階層。
 *   2. guardPage() が利用者を返すまで中身（#np-content）を出さない。
 *   3. APIキーは KeyStore から都度読む。このモジュールに保持しない。
 *
 * ロジック（検証・intent・保存・Gemini）は post.js / gemini.js に置き、
 * ここは DOM の付け外しだけを受け持つ。
 */

import { guardPage } from '../../auth/session.js';
import { setScreenDepth } from '../../auth/config.js';
import { KeyStore, PROVIDERS, isKeyStoreAvailable } from '../../auth/keystore.js';
import { TEXT_LIMIT } from './config.js';
import {
  countText,
  validatePostText,
  buildEditorUrl,
  isStorageAvailable,
  saveDraft,
  listDrafts,
  deleteDraft,
  recordHistory,
  listHistory,
  saveStylePrompt,
  loadStylePrompt,
} from './post.js';
import { generatePost, describeGeminiError } from './gemini.js';

setScreenDepth(2);

const dom = {
  loading: document.getElementById('np-loading'),
  content: document.getElementById('np-content'),
  storageNote: document.getElementById('np-storage-note'),
  keyNote: document.getElementById('np-key-note'),
  generateForm: document.getElementById('np-generate-form'),
  generateButton: document.getElementById('np-generate'),
  theme: document.getElementById('np-theme'),
  style: document.getElementById('np-style'),
  title: document.getElementById('np-title'),
  copyBody: document.getElementById('np-copy-body'),
  text: document.getElementById('np-text'),
  count: document.getElementById('np-count'),
  limit: document.getElementById('np-limit'),
  save: document.getElementById('np-save'),
  post: document.getElementById('np-post'),
  message: document.getElementById('np-message'),
  drafts: document.getElementById('np-drafts'),
  draftsSection: document.getElementById('np-drafts-section'),
  history: document.getElementById('np-history'),
  historySection: document.getElementById('np-history-section'),
};

const storageOk = isStorageAvailable();

function say(text, isError = false) {
  dom.message.textContent = text;
  dom.message.className = `np-message${isError ? ' np-message--error' : ''}`;
}

function formatTime(ms) {
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function updateCount() {
  const length = countText(dom.text.value);
  dom.count.textContent = String(length);
  dom.count.className = length > TEXT_LIMIT ? 'np-count-over' : '';
}

function refreshKeyState() {
  const hasKey = isKeyStoreAvailable() && KeyStore.has(PROVIDERS.gemini);
  dom.keyNote.hidden = hasKey;
}

/* ---------- 一覧の描画 ---------- */

function renderDrafts() {
  const drafts = storageOk ? listDrafts() : [];

  dom.drafts.textContent = '';

  /*
   * 0件のあいだはセクションごと出さない。空の一覧と「まだありません」は
   * 場所を取るだけで、利用者の次の操作を助けない（下書きは「下書き保存」で
   * 増え、そのときこの関数が呼び直されて現れる）。
   */
  dom.draftsSection.hidden = drafts.length === 0;

  for (const draft of drafts) {
    const li = document.createElement('li');

    const body = document.createElement('div');
    body.className = 'np-item-body';

    const meta = document.createElement('p');
    meta.className = 'np-item-meta';
    meta.textContent = draft.title
      ? `${formatTime(draft.createdAt)}　${draft.title}`
      : formatTime(draft.createdAt);

    const text = document.createElement('p');
    text.className = 'np-item-text';
    text.textContent = draft.text;

    body.append(meta, text);

    const actions = document.createElement('div');
    actions.className = 'np-item-actions';

    const load = document.createElement('button');
    load.type = 'button';
    load.textContent = '呼び出す';
    load.addEventListener('click', () => {
      dom.title.value = draft.title ?? '';
      dom.text.value = draft.text;
      updateCount();
      dom.text.focus();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '削除';
    remove.addEventListener('click', () => {
      if (!confirm('この下書きを削除します。よろしいですか？')) {
        return;
      }

      deleteDraft(draft.id);
      renderDrafts();
    });

    actions.append(load, remove);
    li.append(body, actions);
    dom.drafts.append(li);
  }
}

function renderHistory() {
  const items = storageOk ? listHistory() : [];

  dom.history.textContent = '';

  /* 記録の範囲の注記もセクションの中にある。1件も無いうちは出す意味がない。 */
  dom.historySection.hidden = items.length === 0;

  for (const item of items) {
    const li = document.createElement('li');

    const body = document.createElement('div');
    body.className = 'np-item-body';

    const meta = document.createElement('p');
    meta.className = 'np-item-meta';
    meta.textContent = item.title
      ? `${formatTime(item.at)}　${item.kind}　${item.title}`
      : `${formatTime(item.at)}　${item.kind}`;

    const text = document.createElement('p');
    text.className = 'np-item-text';
    text.textContent = item.text;

    body.append(meta, text);
    li.append(body);
    dom.history.append(li);
  }
}

/* ---------- 操作 ---------- */

function handleSave() {
  if (!storageOk) {
    say('この環境では保存できません', true);
    return;
  }

  try {
    saveDraft(dom.text.value, { title: dom.title.value });
    say('下書きを保存しました');
    renderDrafts();
  } catch (error) {
    say(String(error?.message ?? error), true);
  }
}

async function handlePost() {
  const problem = validatePostText(dom.text.value);

  if (problem) {
    say(problem, true);
    return;
  }

  /*
   * note には本文プリフィルの URL が無く、タイトルと本文が別枠
   * （config.js の注記）。クリップボードは一度に1つしか持てないため、
   * まず**タイトル**をコピーして作成画面を開く（最初のカーソルは
   * タイトル欄）。本文は「本文をコピー」で2段階目として貼り付ける。
   * window.open はクリックと同じイベント内で行う（ポップアップ扱いの回避）。
   */
  const title = dom.title.value.trim();
  let copied = false;

  try {
    await navigator.clipboard.writeText(title !== '' ? title : dom.text.value);
    copied = true;
  } catch {
    /* 許可が無い環境ではコピーだけ諦め、作成画面は開く。 */
  }

  const win = window.open(buildEditorUrl(), '_blank', 'noopener,noreferrer');

  if (!win) {
    say('作成画面を開けませんでした。ポップアップの許可をご確認ください。', true);
    return;
  }

  if (storageOk) {
    recordHistory('作成画面を開いた', dom.text.value, { title });
    renderHistory();
  }

  if (!copied) {
    say('note の作成画面を開きました（コピーは許可されませんでした。タイトルと本文は手動でコピーしてください）。');
    return;
  }

  say(title !== ''
    ? 'タイトルをコピーして note の作成画面を開きました。貼り付けたら、このタブに戻って「本文をコピー」を押してください。'
    : 'タイトルが空のため本文をコピーして note の作成画面を開きました。本文欄に貼り付けてください。');
}

async function handleCopyBody() {
  const problem = validatePostText(dom.text.value);

  if (problem) {
    say(problem, true);
    return;
  }

  try {
    await navigator.clipboard.writeText(dom.text.value);
    say('本文をコピーしました。note の本文欄に貼り付けてください。');
  } catch {
    say('コピーが許可されませんでした。本文を選択して手動でコピーしてください。', true);
  }
}

async function handleGenerate(event) {
  event.preventDefault();

  const theme = dom.theme.value.trim();

  if (theme === '') {
    say('テーマ・指示を入力してください', true);
    dom.theme.focus();
    return;
  }

  if ((dom.text.value.trim() !== '' || dom.title.value.trim() !== '')
    && !confirm('入力中のタイトル・本文を生成結果で置き換えます。よろしいですか？')) {
    return;
  }

  /* キーは都度読み、変数に残さない（KeyStore の方針）。 */
  const apiKey = isKeyStoreAvailable() ? KeyStore.get(PROVIDERS.gemini) : null;

  dom.generateButton.disabled = true;
  say('生成しています…');

  try {
    const article = await generatePost({ apiKey: apiKey ?? '', theme, stylePrompt: dom.style.value });
    dom.title.value = article.title;
    dom.text.value = article.body;
    updateCount();
    say('生成しました。タイトルと本文を確認・編集してから保存/note で書くへ進んでください。');
  } catch (error) {
    const described = describeGeminiError(error);
    say(`${described.text}（${described.errorCode}）`, true);
  } finally {
    dom.generateButton.disabled = false;
  }
}

/* ---------- 起動 ---------- */

async function init() {
  const user = await guardPage();

  if (!user) {
    /* すでにログイン画面へ遷移している。ここで描画を止める。 */
    return;
  }

  dom.loading.hidden = true;
  dom.content.hidden = false;

  dom.limit.textContent = String(TEXT_LIMIT);
  dom.storageNote.hidden = storageOk;

  dom.text.addEventListener('input', updateCount);
  dom.save.addEventListener('click', handleSave);
  dom.post.addEventListener('click', handlePost);
  dom.copyBody.addEventListener('click', handleCopyBody);
  dom.generateForm.addEventListener('submit', handleGenerate);

  /* ポータルでキーを設定して戻ってきたら、案内を消す。 */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshKeyState();
    }
  });
  globalThis.addEventListener('focus', refreshKeyState);

  /* 調整プロンプトの復元と自動保存。保存できない環境では欄だけ生かす。 */
  if (storageOk) {
    dom.style.value = loadStylePrompt();
  }
  dom.style.addEventListener('input', () => {
    if (storageOk) {
      saveStylePrompt(dom.style.value);
    }
  });

  refreshKeyState();
  updateCount();
  renderDrafts();
  renderHistory();
}

init();
