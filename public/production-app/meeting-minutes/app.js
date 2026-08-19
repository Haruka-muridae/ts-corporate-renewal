/*
 * AI議事録アプリの画面組み立て（DOM結線）。
 *
 * 起動の約束（他の本番アプリと同じ）:
 *   1. setScreenDepth(2) … /production-app/meeting-minutes/ はルートから2階層。
 *   2. guardPage() が利用者を返すまで中身（#mm-content）を出さない。
 *   3. APIキーは KeyStore から都度読む。このモジュールの変数に保持しない。
 *
 * ==================================================================
 * 表示は textContent と DOM API のみ（要件書 §8-1）
 * ==================================================================
 * 利用者入力・Gemini応答のどちらも信頼しない。innerHTML / outerHTML /
 * insertAdjacentHTML はこのファイルのどこにも使わない。一覧の描画は
 * すべて createElement + textContent + append で組み立てる。
 * ==================================================================
 *
 * ロジック（検証・正規化・根拠照合・Markdown生成・ファイル名生成）は
 * minutes.js、引継ぎは handoff.js、ドラフトは draft.js、Gemini呼び出しは
 * gemini.js に置き、ここは DOM の付け外しと状態遷移だけを受け持つ。
 */

import { guardPage } from '../../auth/session.js';
import { setScreenDepth } from '../../auth/config.js';
import { KeyStore, PROVIDERS, isKeyStoreAvailable } from '../../auth/keystore.js';

import {
  SCREEN_DEPTH,
  LIMITS,
  TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  REGENERATE_TARGETS,
  DRAFT_AUTOSAVE,
  DRIVE_NAMES,
  isValidTemplateId,
} from './config.js';

import {
  countChars,
  isBlank,
  validateTranscriptForGeneration,
  isNearTranscriptLimit,
  isAllowedTranscriptFileName,
  exceedsTranscriptByteLimit,
  FILE_ERROR,
  TRANSCRIPT_ERROR,
  looksBinary,
  looksMisdecoded,
  parseParticipants,
  mergeMeetingInfo,
  createEmptyMinutes,
  createEmptyTopic,
  createEmptyDecision,
  createEmptyActionItem,
  verifyMinutesEvidence,
  normalizeStoredMinutes,
  describeEvidence,
  buildMarkdown,
  buildMinutesFileName,
  mergeMinutesSection,
} from './minutes.js';

import {
  readHandoff,
  clearHandoff,
  isHandoffDataPresent,
  HANDOFF_ERROR,
} from './handoff.js';

import {
  isDraftStorageAvailable,
  saveDraft,
  loadDraft,
  clearDraft,
  createEmptyDraftRecord,
  hasMeaningfulContent,
  DRAFT_SAVE_ERROR,
  DRAFT_RESTORE_ERROR,
} from './draft.js';

import {
  generateMinutes,
  describeGeminiError,
  GeminiError,
  GeminiErrorCode,
} from './gemini.js';

import {
  ensureAccessToken,
  clearAccessToken,
  DriveAuthError,
  DriveAuthErrorCode,
} from './oauth.js';

import {
  saveMinutesMarkdown,
  DriveError,
  DriveErrorCode,
} from './drive-client.js';

setScreenDepth(SCREEN_DEPTH);

/* ================================================================
 * 状態
 * ================================================================ */

const state = {
  transcript: '',
  meetingInfo: {
    title: '', date: '', startTime: '', endTime: '', participants: '', purpose: '', notes: '',
  },
  templateId: DEFAULT_TEMPLATE_ID,
  /* 正規化・根拠照合済みの議事録（minutes.js の形）。未生成なら null。 */
  minutes: null,
  /* 生成結果に対する編集がある状態でページを離れる操作へ警告するためのフラグ。 */
  dirty: false,
  /* 生成中のAbortController。二重送信防止と中止に使う。 */
  controller: null,
  handoffPending: null,
  draftAutosaveTimer: null,
  /* 自動保存失敗のメッセージを毎回出さない（同じ失敗が続く間は1回だけ）。 */
  draftSaveErrorShown: false,
};

/* ================================================================
 * DOM参照
 * ================================================================ */

const dom = {
  loading: document.getElementById('mm-loading'),
  content: document.getElementById('mm-content'),
  keyNote: document.getElementById('mm-key-note'),

  steps: document.querySelectorAll('.mm-steps li'),
  stepSections: {
    1: document.getElementById('mm-step-1'),
    2: document.getElementById('mm-step-2'),
    3: document.getElementById('mm-step-3'),
    4: document.getElementById('mm-step-4'),
    5: document.getElementById('mm-step-5'),
  },

  /* ---- ステップ1: 入力 ---- */
  handoffBanner: document.getElementById('mm-handoff'),
  handoffText: document.getElementById('mm-handoff-text'),
  handoffUseTitle: document.getElementById('mm-handoff-use-title'),
  handoffAccept: document.getElementById('mm-handoff-accept'),
  handoffDiscard: document.getElementById('mm-handoff-discard'),

  draftBanner: document.getElementById('mm-draft-banner'),
  draftText: document.getElementById('mm-draft-text'),
  draftRestore: document.getElementById('mm-draft-restore'),
  draftDismiss: document.getElementById('mm-draft-dismiss'),

  transcript: document.getElementById('mm-transcript'),
  charCount: document.getElementById('mm-char-count'),
  charLimit: document.getElementById('mm-char-limit'),
  charWarning: document.getElementById('mm-char-warning'),
  charLimitMessage: document.getElementById('mm-char-limit-message'),

  fileInput: document.getElementById('mm-file-input'),
  fileButton: document.getElementById('mm-file-button'),
  fileError: document.getElementById('mm-file-error'),

  meetingDetails: document.getElementById('mm-meeting-details'),
  meetingTitle: document.getElementById('mm-meeting-title'),
  meetingDate: document.getElementById('mm-meeting-date'),
  meetingStart: document.getElementById('mm-meeting-start'),
  meetingEnd: document.getElementById('mm-meeting-end'),
  meetingParticipants: document.getElementById('mm-meeting-participants'),
  meetingPurpose: document.getElementById('mm-meeting-purpose'),
  meetingNotes: document.getElementById('mm-meeting-notes'),

  templateRadios: document.querySelectorAll('input[name="mm-template"]'),

  step1Message: document.getElementById('mm-step1-message'),
  toConfirm: document.getElementById('mm-to-confirm'),

  /* ---- ステップ2: 設定・送信確認 ---- */
  confirmChars: document.getElementById('mm-confirm-chars'),
  confirmTitle: document.getElementById('mm-confirm-title'),
  confirmTemplate: document.getElementById('mm-confirm-template'),
  confirmBack: document.getElementById('mm-confirm-back'),
  confirmGenerate: document.getElementById('mm-confirm-generate'),
  step2Message: document.getElementById('mm-step2-message'),

  /* ---- ステップ3: 生成中 ---- */
  generatingStatus: document.getElementById('mm-generating-status'),
  cancelGenerate: document.getElementById('mm-cancel-generate'),

  /* ---- ステップ4: 確認・編集 ---- */
  searchInput: document.getElementById('mm-search-input'),
  searchButton: document.getElementById('mm-search-button'),
  searchStatus: document.getElementById('mm-search-status'),
  original: document.getElementById('mm-original'),

  meetingSummary: document.getElementById('mm-meeting-summary'),
  editSummary: document.getElementById('mm-edit-summary'),
  summarySection: document.getElementById('mm-summary-section'),

  topicsList: document.getElementById('mm-topics-list'),
  topicsSection: document.getElementById('mm-topics-section'),
  topicAdd: document.getElementById('mm-topic-add'),

  decisionsList: document.getElementById('mm-decisions-list'),
  decisionsSection: document.getElementById('mm-decisions-section'),
  decisionAdd: document.getElementById('mm-decision-add'),

  actionItemsList: document.getElementById('mm-actionitems-list'),
  actionItemsSection: document.getElementById('mm-actionitems-section'),
  actionItemAdd: document.getElementById('mm-actionitem-add'),

  openIssuesList: document.getElementById('mm-openissues-list'),
  openIssuesSection: document.getElementById('mm-openissues-section'),
  openIssueAdd: document.getElementById('mm-openissue-add'),

  notesList: document.getElementById('mm-notes-list'),
  notesAdd: document.getElementById('mm-note-add'),

  regenTargetRadios: document.querySelectorAll('input[name="mm-regen-target"]'),
  regenerate: document.getElementById('mm-regenerate'),
  reviewMessage: document.getElementById('mm-review-message'),
  toOutput: document.getElementById('mm-to-output'),
  restart4: document.getElementById('mm-restart-4'),

  /* ---- ステップ5: 出力 ---- */
  includeEvidence: document.getElementById('mm-include-evidence'),
  markdownPreview: document.getElementById('mm-markdown-preview'),
  copyMarkdown: document.getElementById('mm-copy-markdown'),
  downloadMarkdown: document.getElementById('mm-download-markdown'),
  saveDrive: document.getElementById('mm-save-drive'),
  outputMessage: document.getElementById('mm-output-message'),
  backToReview: document.getElementById('mm-back-to-review'),

  /* ---- ステップ外: データの管理（画面末尾） ---- */
  clearStorage: document.getElementById('mm-clear-storage'),
  maintenanceMessage: document.getElementById('mm-maintenance-message'),
};

/* ================================================================
 * 小さな共通ヘルパー
 * ================================================================ */

function say(el, text, isError = false) {
  if (!el) {
    return;
  }

  el.textContent = text;
  el.classList.toggle('mm-message--error', isError);
}

function refreshKeyState() {
  const hasKey = isKeyStoreAvailable() && KeyStore.has(PROVIDERS.gemini);
  dom.keyNote.hidden = hasKey;
  return hasKey;
}

/* ---------- ステップ遷移 ---------- */

function showStep(step) {
  for (const [key, section] of Object.entries(dom.stepSections)) {
    const active = Number(key) === step;
    section.hidden = !active;
  }

  dom.steps.forEach((li, index) => {
    const active = index + 1 === step;
    if (active) {
      li.setAttribute('aria-current', 'step');
    } else {
      li.removeAttribute('aria-current');
    }
  });

  /* 画面切替のたびに見出しへフォーカスし、スクリーンリーダーに現在地を伝える。 */
  const heading = dom.stepSections[step]?.querySelector('h2');
  heading?.setAttribute('tabindex', '-1');
  heading?.focus();
}

/* ================================================================
 * ステップ1: 入力
 * ================================================================ */

function updateCharCount() {
  const length = countChars(state.transcript);
  dom.charCount.textContent = String(length);
  dom.charLimit.textContent = String(LIMITS.TRANSCRIPT_MAX_CHARS);

  const over = length > LIMITS.TRANSCRIPT_MAX_CHARS;
  dom.charCount.classList.toggle('mm-count-over', over);

  /* 近接警告は、超過時にも隠さない（短縮・分割の案内自体は超過時も有効）。
     色（mm-count-over）だけで超過を伝えず、下の mm-char-limit-message へ
     §9-2 の文言をテキストで出す（要件書 §6-7「エラーは色だけで伝えない」）。 */
  dom.charWarning.hidden = !(isNearTranscriptLimit(state.transcript) || over);

  say(dom.charLimitMessage, over ? TRANSCRIPT_ERROR.OVER_LIMIT : '', over);

  dom.toConfirm.disabled = isBlank(state.transcript) || over;
}

function collectMeetingInfoFromForm() {
  state.meetingInfo = {
    title: dom.meetingTitle.value,
    date: dom.meetingDate.value,
    startTime: dom.meetingStart.value,
    endTime: dom.meetingEnd.value,
    participants: dom.meetingParticipants.value,
    purpose: dom.meetingPurpose.value,
    notes: dom.meetingNotes.value,
  };
}

function applyMeetingInfoToForm() {
  const info = state.meetingInfo;
  dom.meetingTitle.value = info.title ?? '';
  dom.meetingDate.value = info.date ?? '';
  dom.meetingStart.value = info.startTime ?? '';
  dom.meetingEnd.value = info.endTime ?? '';
  dom.meetingParticipants.value = info.participants ?? '';
  dom.meetingPurpose.value = info.purpose ?? '';
  dom.meetingNotes.value = info.notes ?? '';

  /*
   * 会議情報は既定で畳んである（要件書 §4-4）。この関数はドラフト復元と
   * 全体リセットのときだけ呼ばれるので、開閉も中身の有無へ合わせる。
   * 値があるのに畳んだままだと、復元したはずの参加者・目的・補足が
   * 画面から見えず入力し直される。逆にリセット後は空なので畳み直す。
   */
  dom.meetingDetails.open = Object.values(info).some(
    (value) => typeof value === 'string' && value.trim() !== '',
  );
}

function applyTemplateSelectionToForm() {
  dom.templateRadios.forEach((radio) => {
    radio.checked = radio.value === state.templateId;
  });
}

/* ---------- ファイル読込み（要件書 §4-2・§4-3） ---------- */

function readTranscriptFile(file) {
  return new Promise((resolve, reject) => {
    if (!isAllowedTranscriptFileName(file.name)) {
      reject(new Error(FILE_ERROR.UNSUPPORTED_EXTENSION));
      return;
    }

    /* file.size の時点で上限超過が確定するファイルは、読み込む前に弾く
       （§8-4「極端に大きい入力をそのままDOM複製しない」）。 */
    if (exceedsTranscriptByteLimit(file.size)) {
      reject(new Error(TRANSCRIPT_ERROR.OVER_LIMIT));
      return;
    }

    const reader = new FileReader();

    reader.onerror = () => reject(new Error(FILE_ERROR.READ_FAILED));

    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';

      if (looksMisdecoded(text)) {
        reject(new Error(FILE_ERROR.ENCODING_INVALID));
        return;
      }

      if (looksBinary(text)) {
        reject(new Error(FILE_ERROR.BINARY_DETECTED));
        return;
      }

      resolve(text);
    };

    reader.readAsText(file, 'UTF-8');
  });
}

async function handleFileSelected(event) {
  const file = event.target.files?.[0];
  event.target.value = '';

  if (!file) {
    return;
  }

  dom.fileError.hidden = true;

  try {
    const text = await readTranscriptFile(file);
    state.transcript = text;
    dom.transcript.value = text;
    updateCharCount();
    scheduleDraftAutosave();
  } catch (error) {
    dom.fileError.hidden = false;
    dom.fileError.textContent = error instanceof Error ? error.message : FILE_ERROR.READ_FAILED;
  }
}

/* ---------- 引継ぎ（要件書 §5） ---------- */

/* 拡張子を取り除く（末尾のドット以降）。ドットが先頭以外に無ければそのまま返す。 */
function stripFileExtension(name) {
  const value = String(name ?? '');
  const dotIndex = value.lastIndexOf('.');
  return dotIndex > 0 ? value.slice(0, dotIndex) : value;
}

function renderHandoffBanner() {
  const handoff = state.handoffPending;
  dom.handoffBanner.hidden = !handoff;

  if (!handoff) {
    return;
  }

  const title = handoff.metadata.title !== '' ? handoff.metadata.title : '(名称未設定)';
  const length = countChars(handoff.transcript);
  dom.handoffText.textContent = `音声文字起こしアプリから引き継いだ文字起こしがあります（${title}、${length}文字）。取り込みますか？`;

  /*
   * ファイル名（表示）は既定では会議名へ採用しない（要件書 §7-3「ファイル名は
   * 会議名として利用者が明示的に採用しない限り送信しない」）。取込み対象を
   * 表示するたびに、チェックボックスを既定OFFへ戻す。
   */
  dom.handoffUseTitle.checked = false;
  dom.handoffUseTitle.disabled = handoff.metadata.title === '';
}

function handleHandoffAccept() {
  const handoff = state.handoffPending;

  if (!handoff) {
    return;
  }

  const useTitle = dom.handoffUseTitle.checked && handoff.metadata.title !== '';

  const applyImport = () => {
    state.transcript = handoff.transcript;
    dom.transcript.value = handoff.transcript;

    if (useTitle) {
      const title = stripFileExtension(handoff.metadata.title);
      state.meetingInfo.title = title;
      dom.meetingTitle.value = title;
      /* 会議名を採用したことが見えるよう、畳んである会議情報を開く。 */
      dom.meetingDetails.open = true;
    }

    clearHandoff();
    state.handoffPending = null;
    renderHandoffBanner();
    updateCharCount();
    scheduleDraftAutosave();
  };

  if (!isBlank(state.transcript)) {
    if (!confirm('入力中の文字起こしを、引き継いだ内容で置き換えます。よろしいですか？')) {
      return;
    }
  }

  applyImport();
}

function handleHandoffDiscard() {
  clearHandoff();
  state.handoffPending = null;
  renderHandoffBanner();
}

/* ---------- ドラフト（要件書 §4-14・§3-3） ---------- */

function draftAvailable() {
  return isDraftStorageAvailable();
}

function currentDraftRecord() {
  collectMeetingInfoFromForm();
  return {
    transcript: state.transcript,
    meetingInfo: state.meetingInfo,
    templateId: state.templateId,
    minutes: state.minutes,
  };
}

async function persistDraftNow() {
  if (!draftAvailable()) {
    return;
  }

  try {
    await saveDraft(currentDraftRecord());
    state.draftSaveErrorShown = false;
  } catch {
    /* 保存容量不足等（要件書 §9-2）。同じ失敗が続く間、毎回は出さない。 */
    if (!state.draftSaveErrorShown) {
      state.draftSaveErrorShown = true;
      say(dom.step1Message, DRAFT_SAVE_ERROR, true);
    }
  }
}

function scheduleDraftAutosave() {
  if (!DRAFT_AUTOSAVE.enabled || !draftAvailable()) {
    return;
  }

  if (state.draftAutosaveTimer) {
    clearTimeout(state.draftAutosaveTimer);
  }

  state.draftAutosaveTimer = setTimeout(() => {
    persistDraftNow();
  }, DRAFT_AUTOSAVE.debounceMs);
}

async function checkDraftOnStartup() {
  if (!draftAvailable()) {
    dom.draftBanner.hidden = true;
    return;
  }

  const record = await loadDraft();

  if (!hasMeaningfulContent(record)) {
    dom.draftBanner.hidden = true;
    return;
  }

  dom.draftBanner.hidden = false;
  dom.draftText.textContent = record.updatedAt
    ? `前回の作業内容が端末内に残っています（${new Date(record.updatedAt).toLocaleString('ja-JP')}）。復元しますか？`
    : '前回の作業内容が端末内に残っています。復元しますか？';

  dom.draftRestore.onclick = () => restoreDraft(record);
  dom.draftDismiss.onclick = async () => {
    await clearDraft();
    dom.draftBanner.hidden = true;
  };
}

async function restoreDraft(record) {
  /* 入力中の内容（原文または生成結果）を復元で無言のまま失わせない
     （handleHandoffAccept と同じ形。要件書 §3-3「新しい入力で既存ドラフトを
     置き換える前に確認する」の裏返し＝復元で今の入力を置き換える前も同様）。 */
  const hasExistingContent = !isBlank(state.transcript) || state.minutes !== null;

  if (hasExistingContent && !confirm('入力中の内容を、復元した下書きで置き換えます。よろしいですか？')) {
    return;
  }

  let restoredMinutes = null;

  if (record.minutes !== null && record.minutes !== undefined) {
    restoredMinutes = normalizeStoredMinutes(record.minutes);

    if (restoredMinutes === null) {
      /* IndexedDBの中身が壊れている（改変・破損）。復元せずドラフトを破棄する。 */
      dom.draftBanner.hidden = true;

      if (draftAvailable()) {
        try {
          await clearDraft();
        } catch {
          /* 削除に失敗しても、案内自体は出す。次回保存時に上書きされる。 */
        }
      }

      say(dom.step1Message, DRAFT_RESTORE_ERROR, true);
      return;
    }
  }

  const templateId = isValidTemplateId(record.templateId) ? record.templateId : DEFAULT_TEMPLATE_ID;

  state.transcript = record.transcript ?? '';
  state.meetingInfo = { ...createEmptyDraftRecord().meetingInfo, ...(record.meetingInfo ?? {}) };
  state.templateId = templateId;
  state.minutes = restoredMinutes;

  dom.transcript.value = state.transcript;
  applyMeetingInfoToForm();
  applyTemplateSelectionToForm();
  updateCharCount();

  dom.draftBanner.hidden = true;

  if (state.minutes) {
    renderReviewScreen();
    say(dom.reviewMessage, '前回の作業内容を復元しました。');
  }
}

async function handleClearStorage() {
  if (!confirm('端末内の作業データ（原文・会議情報・生成結果・下書き）を削除します。よろしいですか？（APIキー・ログイン状態は削除されません）')) {
    return;
  }

  /*
   * 結果の通知先は、ボタンと同じ「データの管理」区画に置く。
   * この区画はステップ表示の外にあり常に見えているため、
   * 失敗して resetAllState() が走らなかった場合でも案内が読める
   * （ステップ1のメッセージ欄だと、ステップ5から押したときに
   * 隠れたままになる）。
   */
  if (draftAvailable()) {
    try {
      await clearDraft();
    } catch {
      say(dom.maintenanceMessage, '端末内の作業データを削除できませんでした。もう一度お試しください。', true);
      return;
    }
  }

  clearHandoff();
  resetAllState();
  say(dom.maintenanceMessage, '端末内の作業データを削除しました。');
}

function resetAllState() {
  state.transcript = '';
  state.meetingInfo = { title: '', date: '', startTime: '', endTime: '', participants: '', purpose: '', notes: '' };
  state.templateId = DEFAULT_TEMPLATE_ID;
  state.minutes = null;
  state.dirty = false;
  state.handoffPending = null;

  dom.transcript.value = '';
  applyMeetingInfoToForm();
  applyTemplateSelectionToForm();
  updateCharCount();
  dom.handoffBanner.hidden = true;
  dom.draftBanner.hidden = true;

  showStep(1);
}

/* ================================================================
 * ステップ1 → 2
 * ================================================================ */

function handleToConfirm() {
  collectMeetingInfoFromForm();

  const problem = validateTranscriptForGeneration(state.transcript);

  if (problem) {
    say(dom.step1Message, problem, true);
    return;
  }

  say(dom.step1Message, '');
  renderConfirmScreen();
  showStep(2);
}

function renderConfirmScreen() {
  dom.confirmChars.textContent = String(countChars(state.transcript));
  dom.confirmTitle.textContent = state.meetingInfo.title.trim() !== '' ? state.meetingInfo.title.trim() : '（未入力）';
  dom.confirmTemplate.textContent = (TEMPLATES[state.templateId] ?? TEMPLATES[DEFAULT_TEMPLATE_ID]).label;
  say(dom.step2Message, '');
}

/* ================================================================
 * ステップ2 → 3 → 4: 生成
 * ================================================================ */

function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function startElapsedTimer() {
  const startedAt = Date.now();

  const tick = () => {
    dom.generatingStatus.textContent = `議事録を生成しています…（経過 ${formatElapsed(Date.now() - startedAt)}）`;
  };

  tick();
  return setInterval(tick, 1000);
}

async function runGeneration({ regenerateTarget = REGENERATE_TARGETS.ALL, fromStep } = {}) {
  if (state.controller) {
    /* 二重送信防止。すでに実行中なら何もしない。 */
    return;
  }

  const hasKey = refreshKeyState();

  if (!hasKey) {
    const message = describeGeminiError(new GeminiError(GeminiErrorCode.KEY_MISSING));
    say(fromStep === 4 ? dom.reviewMessage : dom.step2Message, message.text, true);
    return;
  }

  const apiKey = KeyStore.get(PROVIDERS.gemini) ?? '';
  const controller = new AbortController();
  state.controller = controller;

  const meetingInfoForRequest = {
    title: state.meetingInfo.title,
    date: state.meetingInfo.date,
    startTime: state.meetingInfo.startTime,
    endTime: state.meetingInfo.endTime,
    participants: parseParticipants(state.meetingInfo.participants),
    purpose: state.meetingInfo.purpose,
    notes: state.meetingInfo.notes,
  };

  showStep(3);
  dom.cancelGenerate.hidden = false;
  const timer = startElapsedTimer();

  const stopGeneratingUi = () => {
    clearInterval(timer);
    dom.cancelGenerate.hidden = true;
    state.controller = null;
  };

  /*
   * try に含めるのはAPI呼び出しだけにする。成功後の状態更新・描画
   * （renderReviewScreen 等）で例外が起きても、それは通信の失敗ではないため、
   * ここで一緒に catch すると SYS-999（不明なエラー）として誤報告される
   * （指摘8）。
   */
  let raw;

  try {
    raw = await generateMinutes({
      apiKey,
      transcript: state.transcript,
      meetingInfo: meetingInfoForRequest,
      templateId: state.templateId,
      regenerateTarget,
      signal: controller.signal,
    });
  } catch (error) {
    stopGeneratingUi();

    if (error instanceof GeminiError && error.code === GeminiErrorCode.ABORTED) {
      /* 利用者が中止した。エラー表示はしない。原文は失われない。 */
      showStep(fromStep === 4 ? 4 : 2);
      return;
    }

    const described = describeGeminiError(error);
    const target = fromStep === 4 ? dom.reviewMessage : dom.step2Message;

    /* 失敗時も入力原文・編集内容は保持する（要件書 §3-3・§9-2）。 */
    showStep(fromStep === 4 ? 4 : 2);

    if (fromStep === 4) {
      renderReviewScreen();
    }

    say(target, `${described.text}（${described.errorCode}）`, true);
    return;
  }

  stopGeneratingUi();

  /* 根拠照合は「マージする前」に行う。マージ後に照合し直すと、既に照合済み
     （オブジェクト形）の evidence を文字列として扱ってしまい壊れるため。 */
  const verified = verifyMinutesEvidence(raw, state.transcript);
  verified.meeting = mergeMeetingInfo(state.meetingInfo, verified.meeting);

  state.minutes = mergeMinutesSection(state.minutes ?? createEmptyMinutes(), verified, regenerateTarget);
  state.dirty = false;

  renderReviewScreen();
  showStep(4);
  say(dom.reviewMessage, '議事録を生成しました。原文と照合してご確認ください。');
  scheduleDraftAutosave();
}

function handleCancelGenerate() {
  state.controller?.abort();
}

/* ================================================================
 * ステップ4: 確認・編集
 * ================================================================ */

function markDirty() {
  state.dirty = true;
  scheduleDraftAutosave();
}

/* ---------- 汎用の編集可能リスト ---------- */

function createIconButton(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mm-icon-button';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function createRowControls({ onRemove, onMoveUp, onMoveDown }) {
  const controls = document.createElement('div');
  controls.className = 'mm-row-controls';

  if (onMoveUp) {
    controls.append(createIconButton('上へ', onMoveUp));
  }

  if (onMoveDown) {
    controls.append(createIconButton('下へ', onMoveDown));
  }

  controls.append(createIconButton('削除', onRemove));

  return controls;
}

function moveItem(list, index, delta) {
  const target = index + delta;

  if (target < 0 || target >= list.length) {
    return;
  }

  const [item] = list.splice(index, 1);
  list.splice(target, 0, item);
}

/* ---------- 概要（summary） ---------- */

function renderSummarySection() {
  const template = TEMPLATES[state.templateId] ?? TEMPLATES[DEFAULT_TEMPLATE_ID];
  const show = template.sections.includes('summary');
  dom.summarySection.hidden = !show;

  if (show) {
    dom.editSummary.value = state.minutes.summary;
  }
}

function handleSummaryInput() {
  state.minutes.summary = dom.editSummary.value;
  markDirty();
}

/* ---------- 議題（topics） ---------- */

function renderTopicsSection() {
  const template = TEMPLATES[state.templateId] ?? TEMPLATES[DEFAULT_TEMPLATE_ID];
  const show = template.sections.includes('topics');
  dom.topicsSection.hidden = !show;

  if (!show) {
    return;
  }

  dom.topicsList.textContent = '';

  state.minutes.topics.forEach((topic, index) => {
    const li = document.createElement('li');
    li.className = 'mm-edit-item';

    const titleLabel = document.createElement('label');
    titleLabel.textContent = '見出し';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = topic.title;
    titleInput.addEventListener('input', () => {
      topic.title = titleInput.value;
      markDirty();
    });
    titleLabel.append(titleInput);

    const summaryLabel = document.createElement('label');
    summaryLabel.textContent = '要旨';
    const summaryArea = document.createElement('textarea');
    summaryArea.rows = 2;
    summaryArea.value = topic.summary;
    summaryArea.addEventListener('input', () => {
      topic.summary = summaryArea.value;
      markDirty();
    });
    summaryLabel.append(summaryArea);

    const pointsLabel = document.createElement('p');
    pointsLabel.className = 'mm-sublabel';
    pointsLabel.textContent = '主な意見・要点';

    const pointsList = document.createElement('ul');
    pointsList.className = 'mm-subitems';

    topic.keyPoints.forEach((point, pointIndex) => {
      const pointLi = document.createElement('li');
      const pointInput = document.createElement('input');
      pointInput.type = 'text';
      pointInput.value = point;
      pointInput.addEventListener('input', () => {
        topic.keyPoints[pointIndex] = pointInput.value;
        markDirty();
      });

      const removePoint = createIconButton('削除', () => {
        topic.keyPoints.splice(pointIndex, 1);
        markDirty();
        renderTopicsSection();
      });

      pointLi.append(pointInput, removePoint);
      pointsList.append(pointLi);
    });

    const addPoint = document.createElement('button');
    addPoint.type = 'button';
    addPoint.className = 'mm-add-button';
    addPoint.textContent = '要点を追加';
    addPoint.addEventListener('click', () => {
      topic.keyPoints.push('');
      markDirty();
      renderTopicsSection();
    });

    const controls = createRowControls({
      onRemove: () => {
        state.minutes.topics.splice(index, 1);
        markDirty();
        renderTopicsSection();
      },
      onMoveUp: index > 0 ? () => { moveItem(state.minutes.topics, index, -1); markDirty(); renderTopicsSection(); } : null,
      onMoveDown: index < state.minutes.topics.length - 1
        ? () => { moveItem(state.minutes.topics, index, 1); markDirty(); renderTopicsSection(); }
        : null,
    });

    li.append(titleLabel, summaryLabel, pointsLabel, pointsList, addPoint, controls);
    dom.topicsList.append(li);
  });
}

function handleTopicAdd() {
  state.minutes.topics.push(createEmptyTopic());
  markDirty();
  renderTopicsSection();
}

/* ---------- 決定事項（decisions） ---------- */

function renderEvidenceNote(evidence) {
  const p = document.createElement('p');
  p.className = 'mm-evidence';
  p.textContent = `根拠: ${describeEvidence(evidence)}`;

  /* locatable でない（＝空白正規化の二次照合でしか確認できていない）場合は
     原文中の厳密な位置を再検索できないため、ボタン自体を出さない（指摘13）。 */
  if (evidence?.confirmed && evidence?.locatable) {
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'mm-evidence-jump';
    jump.textContent = '原文で確認';
    jump.addEventListener('click', () => jumpToOriginalText(evidence.text));
    p.append(document.createTextNode(' '), jump);
  }

  return p;
}

function renderDecisionsSection() {
  const template = TEMPLATES[state.templateId] ?? TEMPLATES[DEFAULT_TEMPLATE_ID];
  const show = template.sections.includes('decisions');
  dom.decisionsSection.hidden = !show;

  if (!show) {
    return;
  }

  dom.decisionsList.textContent = '';

  state.minutes.decisions.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'mm-edit-item';

    const label = document.createElement('label');
    label.textContent = '内容';
    const textarea = document.createElement('textarea');
    textarea.rows = 2;
    textarea.value = item.decision;
    textarea.addEventListener('input', () => {
      item.decision = textarea.value;
      markDirty();
    });
    label.append(textarea);

    const controls = createRowControls({
      onRemove: () => {
        state.minutes.decisions.splice(index, 1);
        markDirty();
        renderDecisionsSection();
      },
      onMoveUp: index > 0 ? () => { moveItem(state.minutes.decisions, index, -1); markDirty(); renderDecisionsSection(); } : null,
      onMoveDown: index < state.minutes.decisions.length - 1
        ? () => { moveItem(state.minutes.decisions, index, 1); markDirty(); renderDecisionsSection(); }
        : null,
    });

    li.append(label, renderEvidenceNote(item.evidence), controls);
    dom.decisionsList.append(li);
  });
}

function handleDecisionAdd() {
  state.minutes.decisions.push(createEmptyDecision());
  markDirty();
  renderDecisionsSection();
}

/* ---------- タスク（actionItems） ---------- */

function renderActionItemsSection() {
  const template = TEMPLATES[state.templateId] ?? TEMPLATES[DEFAULT_TEMPLATE_ID];
  const show = template.sections.includes('actionItems');
  dom.actionItemsSection.hidden = !show;

  if (!show) {
    return;
  }

  dom.actionItemsList.textContent = '';

  state.minutes.actionItems.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'mm-edit-item';

    const taskLabel = document.createElement('label');
    taskLabel.textContent = '内容';
    const taskInput = document.createElement('textarea');
    taskInput.rows = 2;
    taskInput.value = item.task;
    taskInput.addEventListener('input', () => {
      item.task = taskInput.value;
      markDirty();
    });
    taskLabel.append(taskInput);

    const assigneeLabel = document.createElement('label');
    assigneeLabel.textContent = '担当者（不明な場合は空欄のまま）';
    const assigneeInput = document.createElement('input');
    assigneeInput.type = 'text';
    assigneeInput.value = item.assignee;
    assigneeInput.addEventListener('input', () => {
      item.assignee = assigneeInput.value;
      markDirty();
    });
    assigneeLabel.append(assigneeInput);

    const dueLabel = document.createElement('label');
    dueLabel.textContent = '期限（不明な場合は空欄のまま）';
    const dueInput = document.createElement('input');
    dueInput.type = 'text';
    dueInput.value = item.dueDate;
    dueInput.addEventListener('input', () => {
      item.dueDate = dueInput.value;
      markDirty();
    });
    dueLabel.append(dueInput);

    const controls = createRowControls({
      onRemove: () => {
        state.minutes.actionItems.splice(index, 1);
        markDirty();
        renderActionItemsSection();
      },
      onMoveUp: index > 0
        ? () => { moveItem(state.minutes.actionItems, index, -1); markDirty(); renderActionItemsSection(); }
        : null,
      onMoveDown: index < state.minutes.actionItems.length - 1
        ? () => { moveItem(state.minutes.actionItems, index, 1); markDirty(); renderActionItemsSection(); }
        : null,
    });

    li.append(taskLabel, assigneeLabel, dueLabel, renderEvidenceNote(item.evidence), controls);
    dom.actionItemsList.append(li);
  });
}

function handleActionItemAdd() {
  state.minutes.actionItems.push(createEmptyActionItem());
  markDirty();
  renderActionItemsSection();
}

/* ---------- 未決事項・補足（文字列配列の共通実装） ---------- */

function renderTextListSection(listEl, sectionEl, items, key, sectionsRequired) {
  const template = TEMPLATES[state.templateId] ?? TEMPLATES[DEFAULT_TEMPLATE_ID];

  if (sectionEl) {
    sectionEl.hidden = sectionsRequired ? !template.sections.includes(key) : false;

    if (sectionEl.hidden) {
      return;
    }
  }

  listEl.textContent = '';

  items.forEach((value, index) => {
    const li = document.createElement('li');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.addEventListener('input', () => {
      items[index] = input.value;
      markDirty();
    });

    const controls = createRowControls({
      onRemove: () => {
        items.splice(index, 1);
        markDirty();
        renderReviewLists();
      },
      onMoveUp: index > 0 ? () => { moveItem(items, index, -1); markDirty(); renderReviewLists(); } : null,
      onMoveDown: index < items.length - 1 ? () => { moveItem(items, index, 1); markDirty(); renderReviewLists(); } : null,
    });

    li.append(input, controls);
    listEl.append(li);
  });
}

function renderOpenIssuesSection() {
  renderTextListSection(dom.openIssuesList, dom.openIssuesSection, state.minutes.openIssues, 'openIssues', true);
}

function renderNotesSection() {
  const template = TEMPLATES[state.templateId] ?? TEMPLATES[DEFAULT_TEMPLATE_ID];
  const usesNotesAsSection = template.sections.includes('notes');
  /* notes は1on1テンプレートでは「本人の認識」として主要項目になるが、
     他テンプレートでも補足として常に編集可能にする（要件書 §4-9 の notes）。 */
  renderTextListSection(dom.notesList, null, state.minutes.notes, 'notes', usesNotesAsSection);
}

function handleOpenIssueAdd() {
  state.minutes.openIssues.push('');
  markDirty();
  renderOpenIssuesSection();
}

function handleNoteAdd() {
  state.minutes.notes.push('');
  markDirty();
  renderNotesSection();
}

function renderReviewLists() {
  renderSummarySection();
  renderTopicsSection();
  renderDecisionsSection();
  renderActionItemsSection();
  renderOpenIssuesSection();
  renderNotesSection();
}

/* ---------- 原文パネルと検索 ---------- */

function jumpToOriginalText(needle) {
  const value = dom.original.value;
  const index = value.indexOf(needle);

  if (index === -1) {
    dom.searchStatus.textContent = '原文内に見つかりませんでした。';
    return;
  }

  /* 原文内に複数一致する場合、どの箇所が該当かをクライアント側では断定できない
     （指摘1-c）。1件目を無条件で選択せず、複数一致である旨だけを伝える。 */
  if (value.indexOf(needle, index + 1) !== -1) {
    dom.searchStatus.textContent = '複数箇所に一致しました。原文内を目視でご確認ください。';
    return;
  }

  dom.original.focus();
  dom.original.setSelectionRange(index, index + needle.length);
  dom.searchStatus.textContent = '該当箇所を選択しました。';
}

function handleSearch() {
  const query = dom.searchInput.value.trim();

  if (query === '') {
    dom.searchStatus.textContent = '';
    return;
  }

  jumpToOriginalText(query);
}

/* ---------- 議事録全体の描画 ---------- */

function renderMeetingSummary() {
  const meeting = state.minutes.meeting;
  dom.meetingSummary.textContent = '';

  const rows = [
    ['会議名', meeting.title],
    ['開催日', meeting.date],
    ['時間', meeting.time],
    ['参加者', meeting.participants.length > 0 ? meeting.participants.join('、') : ''],
    ['目的', meeting.purpose],
  ];

  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value !== '' ? value : '記載なし';
    dom.meetingSummary.append(dt, dd);
  }
}

function renderReviewScreen() {
  dom.original.value = state.transcript;
  renderMeetingSummary();
  renderReviewLists();
}

/* ---------- 再生成（要件書 §4-12） ---------- */

const REGENERATE_RANGE_LABEL = Object.freeze({
  [REGENERATE_TARGETS.ALL]: '議事録全体',
  [REGENERATE_TARGETS.SUMMARY]: '概要・要約',
  [REGENERATE_TARGETS.DECISIONS]: '決定事項',
  [REGENERATE_TARGETS.ACTION_ITEMS]: 'タスク',
});

function currentRegenerateTarget() {
  const checked = Array.from(dom.regenTargetRadios).find((radio) => radio.checked);
  return checked?.value ?? REGENERATE_TARGETS.ALL;
}

function handleRegenerate() {
  const target = currentRegenerateTarget();
  const label = REGENERATE_RANGE_LABEL[target] ?? target;

  if (!confirm(`「${label}」を再生成します。現在の編集内容のうち、このセクションだけが置き換わります（対象外のセクションは保持されます）。よろしいですか？`)) {
    return;
  }

  runGeneration({ regenerateTarget: target, fromStep: 4 });
}

/* ================================================================
 * ステップ4 → 5: 出力
 * ================================================================ */

function renderOutputScreen() {
  const markdown = buildMarkdown(state.minutes, {
    templateId: state.templateId,
    includeEvidence: dom.includeEvidence.checked,
  });

  dom.markdownPreview.value = markdown;
  say(dom.outputMessage, '');
}

/* コピー失敗時の文言。§9-2 の表現をそのまま使う。API非対応・実行時失敗の
   両分岐で表現を揃える（指摘12）。 */
const COPY_ERROR = '議事録をコピーできませんでした。Markdownファイルとして保存してください。';

async function handleCopyMarkdown() {
  if (!navigator.clipboard?.writeText) {
    say(dom.outputMessage, COPY_ERROR, true);
    return;
  }

  try {
    await navigator.clipboard.writeText(dom.markdownPreview.value);
    say(dom.outputMessage, '議事録をコピーしました。');
  } catch {
    say(dom.outputMessage, COPY_ERROR, true);
  }
}

function handleDownloadMarkdown() {
  const fileName = buildMinutesFileName({
    date: state.minutes.meeting.date,
    title: state.minutes.meeting.title,
  });

  const blob = new Blob([dom.markdownPreview.value], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 0);

  state.dirty = false;
  say(dom.outputMessage, `${fileName} として保存しました。`);
}

/* ================================================================
 * Googleドライブへの保存（要件書 §4-15）
 * ================================================================ */

/* 画面に出す保存先の表記。実フォルダ名（config.js の DRIVE_NAMES）から組む。 */
const MINUTES_DRIVE_PATH = `マイドライブ ＞ ${DRIVE_NAMES.root} ＞ ${DRIVE_NAMES.minutes}`;

/* 文言は audio-transcriber の同種テーブルに合わせる（利用者が同じ体験をするため）。 */
const DRIVE_AUTH_ERROR_MESSAGES = Object.freeze({
  [DriveAuthErrorCode.CLIENT_ID_MISSING]:
    'Googleドライブ連携が設定されていません。管理者へお問い合わせください。',
  [DriveAuthErrorCode.GIS_LOAD_FAILED]:
    'Googleの認証機能を読み込めませんでした。通信環境を確認して、もう一度お試しください。',
  [DriveAuthErrorCode.POPUP_CLOSED]: 'Googleドライブへの接続が中断されました。',
  [DriveAuthErrorCode.POPUP_BLOCKED]:
    'ポップアップがブロックされました。ブラウザの設定でこのサイトのポップアップを許可してください。',
  [DriveAuthErrorCode.ACCESS_DENIED]: 'Googleドライブへの接続が許可されませんでした。',
  [DriveAuthErrorCode.SCOPE_NOT_GRANTED]:
    'Googleドライブの権限が許可されませんでした。もう一度お試しいただき、権限の確認画面で許可してください。',
  [DriveAuthErrorCode.UNKNOWN]: 'Googleドライブへの接続に失敗しました。',
});

const DRIVE_ERROR_MESSAGES = Object.freeze({
  [DriveErrorCode.UNAUTHORIZED]:
    'Googleドライブの利用許可の期限が切れました。もう一度「Googleドライブへ保存」を押して、許可し直してください。',
  [DriveErrorCode.FORBIDDEN]:
    'Googleドライブへのアクセスが拒否されました。権限が足りない可能性があります。',
  [DriveErrorCode.API_DISABLED]:
    'Google Drive APIが有効になっていません。管理者へお問い合わせください。',
  [DriveErrorCode.QUOTA_EXCEEDED]: 'Googleドライブの空き容量が不足しています。',
  [DriveErrorCode.RATE_LIMITED]: 'アクセスが集中しています。しばらく待ってからお試しください。',
  [DriveErrorCode.NOT_FOUND]: '保存先が見つかりませんでした。もう一度お試しください。',
  [DriveErrorCode.NETWORK]: '通信に失敗しました。ネットワークの状態を確認してください。',
  [DriveErrorCode.SERVER_ERROR]: 'Google側で問題が発生しています。しばらく待ってからお試しください。',
  [DriveErrorCode.CANCELLED]: '処理を中止しました。',
  [DriveErrorCode.UNKNOWN]: 'Googleドライブへの保存に失敗しました。',
});

function describeDriveSaveError(error) {
  if (error instanceof DriveAuthError) {
    return DRIVE_AUTH_ERROR_MESSAGES[error.code] ?? DRIVE_AUTH_ERROR_MESSAGES[DriveAuthErrorCode.UNKNOWN];
  }

  if (error instanceof DriveError) {
    return DRIVE_ERROR_MESSAGES[error.code] ?? DRIVE_ERROR_MESSAGES[DriveErrorCode.UNKNOWN];
  }

  return DRIVE_ERROR_MESSAGES[DriveErrorCode.UNKNOWN];
}

async function handleSaveToDrive() {
  if (dom.saveDrive.disabled) {
    return;
  }

  const fileName = buildMinutesFileName({
    date: state.minutes.meeting.date,
    title: state.minutes.meeting.title,
  });
  const text = dom.markdownPreview.value;

  dom.saveDrive.disabled = true;
  say(dom.outputMessage, 'Googleドライブへ保存しています…');

  try {
    /*
     * ensureAccessToken はポップアップを開きうるため、押下直後のここでだけ呼ぶ。
     * 保存中に期限切れ（401）になった場合は、自動でポップアップを開き直さず、
     * トークンを破棄してもう一度ボタンを押してもらう（oauth.js の契約）。
     */
    const token = await ensureAccessToken();
    const saved = await saveMinutesMarkdown({ token, text, fileName });

    /* ドライブに実体が残ったので、ダウンロード済みと同じ扱いにする。 */
    state.dirty = false;
    say(dom.outputMessage, `Googleドライブの「${MINUTES_DRIVE_PATH}」へ ${saved.name} を保存しました。`);
  } catch (error) {
    if (error instanceof DriveError && error.code === DriveErrorCode.UNAUTHORIZED) {
      clearAccessToken();
    }

    say(dom.outputMessage, describeDriveSaveError(error), true);
  } finally {
    dom.saveDrive.disabled = false;
  }
}

async function handleRestart() {
  if (state.dirty && !confirm('編集内容が保存されていません。最初からやり直すと失われます。よろしいですか？')) {
    return;
  }

  if (!state.dirty && !confirm('最初からやり直します。入力内容と生成結果は破棄されます。よろしいですか？')) {
    return;
  }

  if (draftAvailable()) {
    try {
      await clearDraft();
    } catch {
      /* 削除に失敗しても、リセット自体は続行する（ドラフトは次回上書きされる）。 */
    }
  }

  clearHandoff();
  resetAllState();
}

/* ================================================================
 * beforeunload（要件書 §4-11）
 * ================================================================ */

window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) {
    return;
  }

  event.preventDefault();
  event.returnValue = '';
});

/* ================================================================
 * 起動
 * ================================================================ */

async function init() {
  const user = await guardPage();

  if (!user) {
    /* すでにログイン画面へ遷移している。ここで描画を止める。 */
    return;
  }

  dom.loading.hidden = true;
  dom.content.hidden = false;

  /* ---- ステップ1 ---- */
  dom.transcript.addEventListener('input', () => {
    state.transcript = dom.transcript.value;
    updateCharCount();
    scheduleDraftAutosave();
  });

  dom.fileButton.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', handleFileSelected);

  for (const field of [dom.meetingTitle, dom.meetingDate, dom.meetingStart, dom.meetingEnd, dom.meetingParticipants, dom.meetingPurpose, dom.meetingNotes]) {
    field.addEventListener('input', () => {
      collectMeetingInfoFromForm();
      scheduleDraftAutosave();
    });
  }

  dom.templateRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) {
        state.templateId = radio.value;
        scheduleDraftAutosave();
      }
    });
  });

  dom.toConfirm.addEventListener('click', handleToConfirm);

  dom.handoffAccept.addEventListener('click', handleHandoffAccept);
  dom.handoffDiscard.addEventListener('click', handleHandoffDiscard);

  /* ---- ステップ2 ---- */
  dom.confirmBack.addEventListener('click', () => showStep(1));
  dom.confirmGenerate.addEventListener('click', () => runGeneration({ regenerateTarget: REGENERATE_TARGETS.ALL, fromStep: 2 }));

  /* ---- ステップ3 ---- */
  dom.cancelGenerate.addEventListener('click', handleCancelGenerate);

  /* ---- ステップ4 ---- */
  dom.searchButton.addEventListener('click', handleSearch);
  dom.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSearch();
    }
  });

  dom.editSummary.addEventListener('input', handleSummaryInput);
  dom.topicAdd.addEventListener('click', handleTopicAdd);
  dom.decisionAdd.addEventListener('click', handleDecisionAdd);
  dom.actionItemAdd.addEventListener('click', handleActionItemAdd);
  dom.openIssueAdd.addEventListener('click', handleOpenIssueAdd);
  dom.notesAdd.addEventListener('click', handleNoteAdd);

  dom.regenerate.addEventListener('click', handleRegenerate);
  dom.toOutput.addEventListener('click', () => {
    renderOutputScreen();
    showStep(5);
  });
  dom.restart4.addEventListener('click', handleRestart);

  /* ---- ステップ5 ---- */
  dom.includeEvidence.addEventListener('change', renderOutputScreen);
  dom.copyMarkdown.addEventListener('click', handleCopyMarkdown);
  dom.downloadMarkdown.addEventListener('click', handleDownloadMarkdown);
  dom.saveDrive.addEventListener('click', handleSaveToDrive);
  dom.backToReview.addEventListener('click', () => showStep(4));

  /* ---- ステップ外: データの管理 ---- */
  dom.clearStorage.addEventListener('click', handleClearStorage);

  /* KeyStore の状態はポータルで設定して戻ってきたときに更新する。 */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshKeyState();
    }
  });
  window.addEventListener('focus', refreshKeyState);

  /* ---- 初期状態の構築 ---- */
  /*
   * readHandoff() は「引継ぎ無し」と「引継ぎはあるが不正・期限切れ」を
   * どちらも null で返す。isHandoffDataPresent() と併せて見ることで、
   * 後者だけを§9-2の「引継ぎデータ不正」として案内する。
   */
  const handoffWasPresent = isHandoffDataPresent();
  state.handoffPending = readHandoff();

  if (!state.handoffPending && handoffWasPresent) {
    clearHandoff();
    say(dom.step1Message, HANDOFF_ERROR, true);
  }

  renderHandoffBanner();

  await checkDraftOnStartup();

  applyTemplateSelectionToForm();
  updateCharCount();
  refreshKeyState();
  showStep(1);
}

init();
