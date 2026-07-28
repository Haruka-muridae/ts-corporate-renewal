/*
 * チャット画面の組み立て。
 *
 * 文字列はすべて textContent 経由で入れる（innerHTML は使わない）。
 * ナレッジ本文・モデルの出力はどちらも外部由来なので、
 * Markdown を HTML へ変換することもしない（後述の renderAnswerBody を参照）。
 *
 * ------------------------------------------------------------------
 * 描画の単位を分けてある理由
 * ------------------------------------------------------------------
 * 生成中は1秒に十数回、本文だけが書き換わる。
 * 毎回すべてを作り直すと、設定欄や履歴一覧まで巻き込んで作り直すことになり、
 * 長い会話ほど目に見えて重くなる（入力欄の位置も飛ぶ）。
 *
 * そこで
 *   - 領域ごとに「その領域が依存する状態」を明示し
 *   - 変化していない領域は描画しない
 *   - 会話ログは、変わったメッセージだけ差し替える
 * という形にしてある。
 * ------------------------------------------------------------------
 */

import { el, clear, replaceChildren, safeDriveUrl, formatDateTime, formatNumber } from '../../core/dom.js';
import {
  ModelState, MODEL_STATE_LABEL_JA, ChatState, CHAT_STATE_LABEL_JA, canSubmit, canStop,
} from '../state/chat-state.js';
import { GPU_STATUS_LABEL_JA, GpuStatus } from '../engine/environment.js';
import { TIER_LABEL_JA, formatDownloadSize, resolveModel } from '../engine/model-catalog.js';
import { splitCitations, UNANSWERABLE_HINTS, GROUNDING_LABEL_JA } from '../rag/grounding.js';
import { DiagnosticStatus, DIAGNOSTIC_STATUS_LABEL_JA } from '../diagnostics.js';

/* 最初に何を聞けばよいか分からない人向けの例。 */
const EXAMPLE_QUESTIONS = Object.freeze([
  '経費精算の申請期限は？',
  '有給休暇の申請手順を教えて',
  '在宅勤務のルールは？',
]);

/* 領域ごとの依存する状態。ここに挙げた値が変わったときだけ描き直す。 */
const SETUP_KEYS = ['booted', 'notice', 'lastError', 'environment', 'knowledge', 'dbReady', 'modelState', 'modelProgress', 'modelId', 'availableModels'];
const COMPOSER_KEYS = ['modelState', 'chatState', 'draft', 'knowledge', 'mode'];
const SIDE_KEYS = ['modelState', 'modelInfo', 'modelCache', 'settings', 'conversations', 'mode', 'knowledge', 'environment', 'diagnostics', 'diagnosticsRunning', 'modelId', 'availableModels', 'dbReady'];
const STATUS_KEYS = ['modelState', 'environment', 'dbReady', 'knowledge', 'chatState'];

export function mountChat({ store, actions: initialActions }) {
  const main = document.getElementById('main');
  const statusBar = document.getElementById('status-bar');

  let actions = initialActions;

  /* 連打防止。操作ごとに1本だけ通す。 */
  const running = new Set();
  const guard = (key, run) => async () => {
    if (running.has(key)) return;
    running.add(key);
    try {
      await run();
    } finally {
      running.delete(key);
    }
  };

  /* 会話部分は毎回作り直すと入力位置が飛ぶため、領域を分けて保持する。 */
  const setupArea = el('div');
  const conversationArea = el('div', {
    class: 'chat-log',
    id: 'chat-log',
    role: 'log',
    'aria-live': 'polite',
    'aria-label': '会話',
    'aria-busy': 'false',
    tabindex: '0',
  });
  const composerArea = el('div', { class: 'chat-composer' });
  const sideArea = el('div', { class: 'chat-side' });

  /*
   * 読み上げ用の通知。
   * 画面の見た目には出さず、状態が変わったことだけを伝える。
   */
  const announcer = el('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });

  replaceChildren(main, [
    setupArea,
    el('div', { class: 'chat-layout' }, [
      el('div', { class: 'chat-main-column' }, [conversationArea, composerArea]),
      sideArea,
    ]),
    announcer,
  ]);

  const api = {
    setActions(next) {
      actions = next;
    },
  };

  const handlers = {
    prepare: guard('prepare', () => actions.prepareModel()),
    cancelPrepare: () => actions.cancelPrepare(),
    unload: guard('unload', () => actions.unloadModel()),
    clearCache: guard('clearCache', async () => {
      if (!window.confirm('AIモデルのキャッシュを削除します。次回の利用時に再ダウンロードが必要になります。\n\nナレッジ（同期済みの資料）は削除されません。\n\n削除しますか？')) {
        return;
      }
      await actions.clearModelCache();
    }),
    measureCache: guard('measureCache', () => actions.refreshModelCache()),
    send: guard('send', () => actions.submit()),
    stop: () => actions.stop(),
    regenerate: guard('regenerate', () => actions.regenerate()),
    newChat: () => actions.newConversation(),
    diagnose: guard('diagnose', () => actions.runDiagnostics()),
    clearHistory: guard('clearHistory', async () => {
      if (!window.confirm('保存されている会話履歴をすべて削除します。よろしいですか？')) {
        return;
      }
      await actions.clearAllConversations();
    }),
    useExample: (text) => {
      actions.setDraft(text);
      focusInput();
    },
  };

  const focusInput = () => {
    const input = document.getElementById('chat-input');

    if (input && !input.disabled) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  };

  /*
   * Esc で生成を止める。
   * 入力欄に触れていなくても効くよう、画面全体で受ける。
   */
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && canStop(store.get())) {
      event.preventDefault();
      actions.stop();
    }
  });

  const view = createRenderer({
    statusBar, setupArea, conversationArea, composerArea, sideArea, announcer,
  });

  store.subscribe((state) => view.render(state, actions, handlers));

  return api;
}

/*
 * 変化した領域だけを描き直す描画器。
 * 直前の状態を覚えておき、依存する値が同じなら描画を飛ばす。
 */
function createRenderer(areas) {
  let previous = null;
  let previousIds = '';
  const messageNodes = new Map();
  let lastAnnounced = '';

  const changed = (state, keys) => previous === null || keys.some((key) => previous[key] !== state[key]);

  return {
    render(state, actions, handlers) {
      if (changed(state, STATUS_KEYS)) {
        renderStatus(areas.statusBar, state);
      }

      if (changed(state, SETUP_KEYS)) {
        renderSetup(areas.setupArea, state, actions, handlers);
      }

      if (previous === null || previous.messages !== state.messages || previous.chatState !== state.chatState) {
        previousIds = renderConversation(
          areas.conversationArea, state, actions, handlers, messageNodes, previousIds,
        );
      }

      if (changed(state, COMPOSER_KEYS)) {
        renderComposer(areas.composerArea, state, actions, handlers);
      }

      if (changed(state, SIDE_KEYS)) {
        renderSide(areas.sideArea, state, actions, handlers);
      }

      /* 状態の移り変わりだけを読み上げる（本文は読み上げ対象にしない）。 */
      const announcement = announcementFor(state);

      if (announcement !== lastAnnounced) {
        areas.announcer.textContent = announcement;
        lastAnnounced = announcement;
      }

      previous = state;
    },
  };
}

function announcementFor(state) {
  if (state.modelState === ModelState.DOWNLOADING) return 'モデルをダウンロードしています。';
  if (state.modelState === ModelState.INITIALIZING) return 'モデルを初期化しています。';
  if (state.chatState === ChatState.RETRIEVING) return '資料を検索しています。';
  if (state.chatState === ChatState.GENERATING) return '回答を生成しています。';
  if (state.chatState === ChatState.STOPPING) return '生成を停止しています。';
  if (state.modelState === ModelState.READY && state.chatState === ChatState.IDLE) return '質問できます。';
  return '';
}

/* ---------- 状態バー ---------- */

function renderStatus(container, state) {
  const model = state.modelState;
  const gpu = state.environment?.gpu ?? null;

  const badges = [
    el('span', {
      class: `state-badge ${modelBadgeClass(model)}`,
      text: MODEL_STATE_LABEL_JA[model] ?? model,
    }),
    el('span', {
      class: `state-badge ${gpu === GpuStatus.OK ? 'state-badge--done' : 'state-badge--error'}`,
      text: `WebGPU：${GPU_STATUS_LABEL_JA[gpu] ?? '判定中'}`,
    }),
    el('span', {
      class: `state-badge ${state.dbReady ? 'state-badge--idle' : 'state-badge--error'}`,
      text: state.dbReady ? 'IndexedDB：接続済み' : 'IndexedDB：未接続',
    }),
  ];

  if (state.knowledge) {
    badges.push(el('span', {
      class: 'state-badge state-badge--idle',
      text: `ナレッジ：${formatNumber(state.knowledge.indexedFileCount)} ファイル / ${formatNumber(state.knowledge.chunkCount)} チャンク`,
    }));
  }

  if (state.environment && !state.environment.online) {
    badges.push(el('span', { class: 'state-badge state-badge--error', text: 'オフライン' }));
  }

  if (state.chatState !== ChatState.IDLE) {
    badges.push(el('span', { class: 'state-badge state-badge--busy', text: CHAT_STATE_LABEL_JA[state.chatState] }));
  }

  replaceChildren(container, badges);
}

function modelBadgeClass(modelState) {
  if (modelState === ModelState.READY) return 'state-badge--done';
  if (modelState === ModelState.ERROR || modelState === ModelState.UNSUPPORTED) return 'state-badge--error';
  if (modelState === ModelState.DOWNLOADING || modelState === ModelState.INITIALIZING) return 'state-badge--busy';
  return 'state-badge--idle';
}

/* ---------- 初回説明とモデル準備 ---------- */

function renderSetup(container, state, actions, handlers) {
  if (!state.booted) {
    replaceChildren(container, [
      el('div', { class: 'card' }, [
        el('p', { class: 'notice notice--info', role: 'status', text: '準備しています…' }),
        el('ul', { class: 'check-list' }, [
          el('li', { text: '実行環境（WebGPU）を確認しています。' }),
          el('li', { text: '同期済みナレッジの件数を読み出しています。' }),
        ]),
        el('p', { class: 'muted', text: 'この時点では、まだ通信もダウンロードも発生していません。' }),
      ]),
    ]);
    return;
  }

  const children = [];

  if (state.notice) {
    children.push(el('div', { class: 'notice notice--info', role: 'status', 'aria-live': 'polite' }, [
      el('span', { text: state.notice }),
      el('button', { type: 'button', class: 'button button--secondary button--small', text: '閉じる', onClick: () => actions.dismissNotice() }),
    ]));
  }

  if (state.lastError) {
    children.push(el('div', { class: 'notice notice--error', role: 'alert' }, [
      el('span', { text: state.lastError.message }),
      el('button', { type: 'button', class: 'button button--secondary button--small', text: '閉じる', onClick: () => actions.dismissNotice() }),
    ]));
  }

  /* 実行環境が要件を満たさない場合は、まずそれを出す。 */
  if (state.environment && !state.environment.usable) {
    children.push(renderUnsupported(state.environment));
  }

  /* ナレッジが無い場合の案内。 */
  if (state.dbReady && state.knowledge && !state.knowledge.hasKnowledge) {
    children.push(el('div', { class: 'card' }, [
      el('h2', { class: 'card__title', text: '同期済みのナレッジがありません' }),
      el('p', {
        class: 'card__desc',
        text: 'このチャットは、ナレッジ管理画面でGoogle Driveから同期した資料を検索して回答します。'
          + 'まず資料を同期してください。',
      }),
      el('ol', { class: 'steps' }, [
        el('li', { text: '「ナレッジ管理を開く」からGoogleアカウントでログインする' }),
        el('li', { text: '対象フォルダ（01_ナレッジ）を同期する' }),
        el('li', { text: 'この画面へ戻って「件数を再確認」を押す' }),
      ]),
      el('div', { class: 'card__actions' }, [
        el('a', { class: 'button', href: '../', text: 'ナレッジ管理を開く' }),
        el('button', {
          type: 'button', class: 'button button--secondary', 'data-role': 'refresh-knowledge', text: '件数を再確認',
          onClick: () => actions.refreshKnowledge(),
        }),
      ]),
      el('p', { class: 'muted', text: '資料なしで一般的な質問だけを試す場合は、右の「回答モード」を「資料を使わない」に切り替えてください。' }),
    ]));
  }

  /* モデル未読込のときだけ、初回説明を出す。 */
  if (state.modelState === ModelState.IDLE || state.modelState === ModelState.ERROR) {
    children.push(renderIntro(state, actions, handlers));
  }

  if (state.modelState === ModelState.DOWNLOADING || state.modelState === ModelState.INITIALIZING) {
    children.push(renderProgress(state, handlers));
  }

  replaceChildren(container, children);
}

function renderUnsupported(environment) {
  return el('div', { class: 'card card--warn' }, [
    el('h2', { class: 'card__title', text: 'この環境ではAIを実行できません' }),
    el('p', { class: 'notice notice--error', role: 'alert', text: environment.message }),
    environment.hint ? el('p', { class: 'muted', text: environment.hint }) : null,

    el('h3', { class: 'field__label', text: '必要な条件' }),
    el('ul', { class: 'check-list' }, environment.requirements.map((req) => el('li', {}, [
      el('span', { class: req.ok ? 'tag' : 'tag tag--new', text: req.ok ? '満たしている' : '不足' }),
      el('span', { text: `　${req.label}` }),
    ]))),

    el('p', { class: 'muted', text: `ブラウザ：${environment.browser}${environment.mobile ? '（モバイル）' : ''}` }),
    el('p', { class: 'muted', text: 'CPUだけで動かす方式もありますが、この配信構成では実用的な速度になりません。誤解を招くため提供していません。' }),
    el('div', { class: 'card__actions' }, [
      el('a', { class: 'button button--secondary', href: '../', text: 'ナレッジ管理（検索のみ）を使う' }),
    ]),
    el('p', { class: 'muted', text: 'AIチャットが使えない環境でも、ナレッジ管理画面の全文検索はご利用いただけます。' }),
  ]);
}

function renderIntro(state, actions, handlers) {
  const model = resolveModel(state.modelId);
  const models = state.availableModels?.length > 0 ? state.availableModels : [];
  const cached = state.modelCache?.cached === true;

  return el('div', { class: 'card' }, [
    el('h2', { class: 'card__title', text: 'はじめに：このAIはブラウザの中で動きます' }),

    el('p', { class: 'card__desc' }, [
      'このAIは、',
      el('strong', { text: 'あなたのブラウザ内で動作します' }),
      '。同期済み資料と質問内容は、外部の生成AIサービスへ送信されません。',
    ]),

    el('ul', { class: 'check-list' }, [
      el('li', { text: '質問・資料本文・回答は、外部のAI APIへ送信しません（OpenAI・Gemini・Anthropic等を使いません）。' }),
      el('li', { text: 'モデルの計算は、この端末のGPU（WebGPU）で行います。' }),
      el('li', { text: 'ただし、初回だけAIモデルのファイルをダウンロードする通信が発生します（取得のみ・送信なし）。' }),
      el('li', { text: 'ダウンロードしたモデルはブラウザのキャッシュ領域に保存され、次回以降は再利用されます。' }),
      el('li', { text: 'キャッシュを削除すると、再ダウンロードが必要になります。' }),
      el('li', { text: '端末によっては、初回の準備に数分かかることがあります。' }),
      el('li', { text: 'WebGPU非対応の端末では利用できません。モバイルではメモリ不足になることがあります。' }),
      el('li', { text: 'Google Driveへの書き込みは行いません。' }),
    ]),

    el('h3', { class: 'field__label', text: '使用するモデル' }),
    el('div', { class: 'model-picker', role: 'radiogroup', 'aria-label': '使用するモデル' }, models.map((entry) => el('label', {
      class: `model-option${entry.id === model.id ? ' model-option--selected' : ''}`,
    }, [
      el('input', {
        type: 'radio',
        name: 'chat-model',
        value: entry.id,
        checked: entry.id === model.id,
        onChange: () => actions.selectModel(entry.id),
      }),
      el('span', { class: 'model-option__body' }, [
        el('span', { class: 'model-option__name', text: `${entry.name}（${TIER_LABEL_JA[entry.tier]}）` }),
        el('span', { class: 'model-option__meta', text: `パラメータ ${entry.params} ／ ${entry.quantization}` }),
        el('span', { class: 'model-option__meta', text: `初回ダウンロード ${formatDownloadSize(entry.downloadMB)} ／ 必要VRAM 約${formatNumber(entry.vramMB)} MB` }),
        el('span', { class: 'model-option__meta', text: `最大コンテキスト ${formatNumber(entry.contextLen)} トークン ／ ライセンス ${entry.license}` }),
        el('span', { class: 'model-option__note', text: entry.japanese }),
        el('span', { class: 'model-option__note', text: entry.note }),
      ]),
    ]))),

    el('p', { class: 'muted', text: `配信元：${model.source}（モデルファイルの取得のみ。GETリクエストだけを行います）` }),

    cached
      ? el('p', { class: 'notice notice--info', role: 'status', text: 'このブラウザには取得済みのモデルがあります。次回の準備はダウンロードなしで進みます。' })
      : null,

    el('div', { class: 'card__actions' }, [
      el('button', {
        type: 'button',
        class: 'button',
        'data-role': 'prepare-model',
        text: state.modelState === ModelState.ERROR ? 'モデルの準備を再試行' : 'モデルを準備する',
        disabled: state.environment ? !state.environment.usable : false,
        onClick: handlers.prepare,
      }),
      el('a', { class: 'button button--secondary', href: '../', text: 'ナレッジ管理へ戻る' }),
    ]),

    el('p', { class: 'muted', text: 'ボタンを押すまで、モデルのダウンロードは始まりません。' }),
  ]);
}

function renderProgress(state, handlers) {
  const progress = state.modelProgress ?? {};
  const percent = Math.round((Number(progress.ratio) || 0) * 100);
  const model = resolveModel(state.modelId);

  const lines = [];

  if (progress.phase === 'initializing') {
    lines.push('GPUへモデルを読み込んでいます（初期化）…');
    lines.push('この段階では通信は発生しません。GPUでの準備が終わるまでお待ちください。');
  } else {
    lines.push('モデルファイルをダウンロードしています…');
  }

  if (progress.loadedMB !== null && progress.loadedMB !== undefined) {
    lines.push(`取得済み ${formatNumber(Math.round(progress.loadedMB))} MB / 合計 ${formatDownloadSize(model.downloadMB)}`);
  }

  if (progress.fileIndex && progress.fileTotal) {
    lines.push(`ファイル ${progress.fileIndex} / ${progress.fileTotal}`);
  }

  return el('div', { class: 'card' }, [
    el('h2', { class: 'card__title', text: `モデルを準備しています（${percent}%）` }),

    el('div', { class: 'progress-block', role: 'status', 'aria-live': 'polite' }, [
      ...lines.map((line) => el('p', { text: line })),
      el('progress', {
        class: 'progress',
        role: 'progressbar',
        'aria-label': 'モデル準備の進捗',
        'aria-valuenow': String(percent),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        value: String(percent),
        max: '100',
      }),
    ]),

    el('div', { class: 'card__actions' }, [
      el('button', {
        type: 'button',
        class: 'button button--secondary',
        'data-role': 'cancel-prepare',
        text: '中止する',
        onClick: handlers.cancelPrepare,
      }),
    ]),

    el('p', { class: 'muted', text: '中止しても、取得済みの部分は次回の準備で再利用されます。' }),
    el('p', { class: 'muted', text: 'このページを閉じると準備は中断されます。取得済みの分は残ります。' }),
  ]);
}

/* ---------- 会話 ---------- */

/*
 * 変わったメッセージだけ差し替える。
 * 並び自体が変わったときだけ、全体を作り直す。
 */
function renderConversation(container, state, actions, handlers, cache, previousIds) {
  container.setAttribute('aria-busy', state.chatState === ChatState.GENERATING ? 'true' : 'false');

  if (state.messages.length === 0) {
    cache.clear();
    replaceChildren(container, [renderEmptyConversation(state, handlers)]);
    return '';
  }

  const ids = state.messages.map((m) => m.id).join(',');
  const sameOrder = ids === previousIds && container.children.length === state.messages.length;

  /* 追従するかは「今どこを見ているか」で決める。上を読んでいる人を引きずらない。 */
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;

  state.messages.forEach((message, index) => {
    const signature = signatureOf(message, state);
    const cached = cache.get(message.id);

    if (cached && cached.signature === signature && sameOrder) {
      return;
    }

    const node = message.role === 'user'
      ? renderUserMessage(message)
      : renderAnswerMessage(message, state, actions, handlers);

    cache.set(message.id, { signature, node });

    if (sameOrder && container.children[index]) {
      container.replaceChild(node, container.children[index]);
    }
  });

  if (!sameOrder) {
    replaceChildren(container, state.messages.map((m) => cache.get(m.id).node));

    /* 会話に無いメッセージの記憶は捨てる（長時間の利用で膨らませない）。 */
    const alive = new Set(state.messages.map((m) => m.id));
    [...cache.keys()].forEach((key) => {
      if (!alive.has(key)) {
        cache.delete(key);
      }
    });
  }

  if (state.chatState === ChatState.GENERATING && (nearBottom || !sameOrder)) {
    container.scrollTop = container.scrollHeight;
  }

  return ids;
}

/* 再描画が必要かどうかの判定材料。 */
function signatureOf(message, state) {
  return [
    message.role,
    message.text ?? '',
    message.streaming ? 1 : 0,
    message.stopped ? 1 : 0,
    message.refused ? 1 : 0,
    message.error ? message.error.code : '',
    (message.sources ?? []).length,
    message.grounding?.level ?? '',
    (message.citations?.unknown ?? []).length,
    /* 操作ボタンの活性は会話状態に依存する。 */
    message.role === 'assistant' ? state.chatState : '',
  ].join('|');
}

function renderEmptyConversation(state, handlers) {
  if (state.modelState !== ModelState.READY) {
    return el('div', { class: 'chat-empty' }, [
      el('p', { class: 'muted', text: 'モデルを準備すると質問できます。' }),
      el('p', { class: 'muted', text: '準備は1回だけです。次回からはダウンロードなしで開きます。' }),
    ]);
  }

  return el('div', { class: 'chat-empty' }, [
    el('p', { text: '質問を入力してください。同期済みの資料を検索し、根拠付きで回答します。' }),
    el('p', { class: 'muted', text: '例えば、次のような質問ができます。' }),
    el('div', { class: 'example-chips' }, EXAMPLE_QUESTIONS.map((question) => el('button', {
      type: 'button',
      class: 'chip',
      'data-role': 'example-question',
      text: question,
      onClick: () => handlers.useExample(question),
    }))),
    el('p', { class: 'muted', text: '資料に書かれていないことは「資料からは判断できません」と答えます。' }),
  ]);
}

function renderUserMessage(message) {
  return el('article', { class: 'msg msg--user' }, [
    el('div', { class: 'msg__role', text: 'あなた' }),
    el('div', { class: 'msg__body', text: message.text }),
  ]);
}

function renderAnswerMessage(message, state, actions, handlers) {
  const children = [
    el('div', { class: 'msg__role' }, [
      el('span', { text: 'AI（ブラウザ内）' }),
      message.streaming ? el('span', { class: 'tag tag--busy', text: '生成中' }) : null,
      message.stopped ? el('span', { class: 'tag', text: '停止' }) : null,
      message.refused ? el('span', { class: 'tag tag--new', text: '回答しませんでした' }) : null,
      !message.streaming && !message.refused && message.grounding
        ? el('span', {
          class: `tag grounding grounding--${message.grounding.level}`,
          text: `根拠 ${message.grounding.stars}`,
          title: `${GROUNDING_LABEL_JA[message.grounding.level]}（質問の語のうち ${Math.round((message.grounding.coverage ?? 0) * 100)}% が資料に出てきました）`,
        })
        : null,
    ]),
    message.refused ? renderRefusal(message) : renderAnswerBody(message),
  ];

  if (message.streaming) {
    children.push(el('p', { class: 'muted msg__hint', text: '生成中です。Esc キーで停止できます。' }));
  }

  if (message.error) {
    children.push(el('p', { class: 'notice notice--error', role: 'alert', text: message.error.message }));
    children.push(el('div', { class: 'msg__actions' }, [
      el('button', { type: 'button', class: 'button button--secondary button--small', text: '再試行', onClick: handlers.regenerate }),
    ]));
  }

  /* 渡していない番号を書いていたら、その場で注意する。 */
  if (message.citations?.unknown?.length > 0) {
    children.push(el('p', {
      class: 'notice notice--error',
      role: 'alert',
      text: `AIが、存在しない資料番号（${message.citations.unknown.map((n) => `[${n}]`).join(' ')}）を書いています。`
        + 'その部分は資料にもとづいていない可能性が高いため、下の引用元をご確認ください。',
    }));
  }

  if (message.searchInfo && !message.streaming) {
    children.push(renderSources(message));
  }

  if (!message.streaming && !message.error && !message.refused) {
    children.push(el('div', { class: 'msg__actions' }, [
      el('button', {
        type: 'button', class: 'button button--secondary button--small', text: 'コピー',
        onClick: (event) => copyText(message.text, event.currentTarget),
      }),
      el('button', {
        type: 'button', class: 'button button--secondary button--small', 'data-role': 'regenerate', text: '再生成',
        disabled: state.chatState !== ChatState.IDLE,
        onClick: handlers.regenerate,
      }),
    ]));
  }

  if (message.refused) {
    children.push(el('div', { class: 'msg__actions' }, [
      el('button', {
        type: 'button', class: 'button button--secondary button--small', 'data-role': 'regenerate', text: 'もう一度試す',
        disabled: state.chatState !== ChatState.IDLE,
        onClick: handlers.regenerate,
      }),
      el('a', { class: 'button button--secondary button--small', href: '../#search', text: 'ナレッジ管理で検索する' }),
    ]));
  }

  return el('article', { class: `msg msg--assistant${message.refused ? ' msg--refused' : ''}` }, children);
}

/* 資料が足りずに回答しなかったときの表示。 */
function renderRefusal(message) {
  const missing = message.grounding?.missing ?? [];

  return el('div', { class: 'msg__body msg__body--refused' }, [
    el('p', { class: 'refusal__title', text: message.text }),
    el('p', { class: 'muted', text: '同期済みの資料に、この質問へ答えられる記述が見つかりませんでした。推測で答えることはしません。' }),
    el('ul', { class: 'check-list' }, UNANSWERABLE_HINTS.map((hint) => el('li', { text: hint }))),
    missing.length > 0
      ? el('p', { class: 'muted', text: `資料に見つからなかった語（一部）：${missing.slice(0, 8).join('・')}` })
      : null,
  ]);
}

/*
 * 回答本文。
 *
 * Markdown を HTML へ変換しない。モデルの出力は外部由来であり、
 * HTMLにするとサニタイズの責務が増えるだけで利点が小さい。
 * 見出し・箇条書きは改行のまま等幅で読める形にし、
 * コードブロックだけは横スクロールできるようにする。
 *
 * [1] のような引用番号だけは、対応する引用元へ飛べるようにする。
 */
function renderAnswerBody(message) {
  const text = String(message.text ?? '');

  if (text === '') {
    return el('div', { class: 'msg__body muted', text: message.streaming ? '…' : '（応答がありません）' });
  }

  const blocks = [];
  const parts = text.split(/```/);

  parts.forEach((part, index) => {
    if (part === '') {
      return;
    }

    if (index % 2 === 1) {
      /* ``` に挟まれた部分＝コードブロック。 */
      const body = part.replace(/^[^\n]*\n/, '');
      blocks.push(el('pre', { class: 'code-block' }, [el('code', { text: body })]));
      return;
    }

    blocks.push(el('div', { class: 'msg__text' }, renderTextWithCitations(part, message)));
  });

  return el('div', { class: 'msg__body' }, blocks);
}

/* [n] を引用元へのリンクにする。番号が存在しない場合は目立たせる。 */
function renderTextWithCitations(text, message) {
  const sources = Array.isArray(message.sources) ? message.sources : [];

  if (sources.length === 0) {
    return [document.createTextNode(text)];
  }

  return splitCitations(text, sources).map((part) => {
    if (part.type === 'text') {
      return document.createTextNode(part.value);
    }

    if (!part.valid) {
      return el('span', {
        class: 'citation citation--unknown',
        title: '渡していない資料番号です。',
        text: `[${part.id}]`,
      });
    }

    const source = sources.find((s) => Number(s.id) === part.id);

    return el('a', {
      class: 'citation',
      href: `#${sourceAnchorId(message.id, part.id)}`,
      title: source?.fileName ? `出典：${source.fileName}` : '出典へ移動',
      'aria-label': source?.fileName ? `引用 ${part.id}：${source.fileName}` : `引用 ${part.id}`,
      text: `[${part.id}]`,
    });
  });
}

function sourceAnchorId(messageId, sourceId) {
  return `src-${messageId}-${sourceId}`;
}

function renderSources(message) {
  const sources = Array.isArray(message.sources) ? message.sources : [];

  if (sources.length === 0) {
    return el('p', {
      class: 'muted',
      text: message.searchInfo?.reason === 'no-hits'
        ? '関連する資料は見つかりませんでした。'
        : '関連度が十分な資料が見つかりませんでした。',
    });
  }

  const cited = new Set(message.citations?.cited ?? []);
  const grounding = message.grounding;

  const head = [
    el('summary', {}, [
      el('span', { text: `参照した資料（${sources.length} 件）` }),
      grounding ? el('span', { class: `tag grounding grounding--${grounding.level}`, text: `根拠 ${grounding.stars}` }) : null,
    ]),
  ];

  if (grounding) {
    head.push(el('p', {
      class: 'muted sources__summary',
      text: `${GROUNDING_LABEL_JA[grounding.level]}：質問に含まれる語のうち ${Math.round((grounding.coverage ?? 0) * 100)}% が、これらの資料に出てきました。`,
    }));
  }

  if (message.refused) {
    head.push(el('p', {
      class: 'muted',
      text: '下の資料は検索で見つかった候補ですが、根拠としては不十分と判定したため回答は作っていません。',
    }));
  }

  head.push(el('ol', { class: 'sources__list' }, sources.map((source) => renderSource(source, message, cited))));

  return el('details', { class: 'sources', open: message.refused ? true : undefined }, head);
}

function renderSource(source, message, cited) {
  const href = safeDriveUrl(source.driveUrl);
  const range = source.chunkIndexEnd !== undefined && source.chunkIndexEnd !== source.chunkIndex
    ? `チャンク ${source.chunkIndex}〜${source.chunkIndexEnd}`
    : `チャンク ${source.chunkIndex}`;

  return el('li', { class: 'sources__item', id: sourceAnchorId(message.id, source.id) }, [
    el('div', { class: 'sources__head' }, [
      el('span', { class: 'sources__id', text: `[${source.id}]` }),
      el('span', { class: 'sources__file', text: source.fileName || '（名称不明）' }),
      cited.has(Number(source.id))
        ? el('span', { class: 'tag tag--done', text: '回答で引用' })
        : el('span', { class: 'tag', text: '未引用' }),
    ]),
    el('div', { class: 'sources__meta' }, [
      el('span', { class: 'tag', text: range }),
      el('span', { class: 'tag', text: `関連度 ${Number(source.score ?? 0).toFixed(2)}` }),
      source.matchRatio !== undefined
        ? el('span', { class: 'tag', text: `一致率 ${Math.round(source.matchRatio * 100)}%` })
        : null,
      source.expanded ? el('span', { class: 'tag', text: '前後を補完' }) : null,
      source.truncated ? el('span', { class: 'tag', text: '一部のみ' }) : null,
      source.folderName ? el('span', { class: 'muted', text: source.folderName }) : null,
    ]),
    source.heading ? el('div', { class: 'muted', text: `見出し：${source.heading}` }) : null,
    el('div', { class: 'sources__snippet', text: excerpt(source.text) }),
    el('div', { class: 'sources__links' }, [
      href
        ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: 'Driveで開く' })
        : el('span', { class: 'muted', text: '（Driveリンクなし）' }),
      el('a', { href: '../#search', text: 'ナレッジ管理で検索' }),
    ]),
  ]);
}

/* 抜粋。サロゲートペアを壊さない。 */
function excerpt(text, max = 240) {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim();

  if (source.length <= max) {
    return source;
  }

  let end = max;
  const code = source.charCodeAt(end - 1);

  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }

  return `${source.slice(0, end)}…`;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(String(text ?? ''));
    const original = button.textContent;
    button.textContent = 'コピーしました';
    setTimeout(() => { button.textContent = original; }, 1500);
  } catch {
    button.textContent = 'コピーできません';
  }
}

/* ---------- 入力欄 ---------- */

function renderComposer(container, state, actions, handlers) {
  const verdict = canSubmit(state);
  const busy = state.chatState === ChatState.GENERATING || state.chatState === ChatState.RETRIEVING;
  const length = (state.draft ?? '').length;

  const textarea = el('textarea', {
    class: 'chat-input',
    id: 'chat-input',
    rows: '3',
    'aria-label': '質問',
    'aria-describedby': 'chat-input-help',
    maxlength: '2000',
    placeholder: state.modelState === ModelState.READY
      ? '質問を入力（Enterで送信 / Shift+Enterで改行）'
      : 'モデルを準備すると入力できます',
    disabled: state.modelState !== ModelState.READY || busy,
    onInput: (event) => actions.setDraft(event.currentTarget.value),
    onKeyDown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        handlers.send();
      }
    },
  });

  textarea.value = state.draft ?? '';

  replaceChildren(container, [
    el('div', { class: 'chat-composer__row' }, [
      textarea,
      el('div', { class: 'chat-composer__buttons' }, [
        el('button', {
          type: 'button',
          class: 'button',
          'data-role': 'send',
          text: '送信',
          disabled: !verdict.ok,
          onClick: handlers.send,
        }),
        el('button', {
          type: 'button',
          class: 'button button--secondary',
          'data-role': 'stop',
          text: '生成を停止',
          disabled: !canStop(state),
          onClick: handlers.stop,
        }),
      ]),
    ]),

    el('div', { class: 'chat-composer__meta' }, [
      el('span', {
        class: 'muted', id: 'chat-input-help', role: 'status', 'aria-live': 'polite',
        text: verdict.ok
          ? 'Enterで送信、Shift+Enterで改行、Escで生成を停止できます。'
          : verdict.message,
      }),
      el('span', {
        class: length > 1800 ? 'muted text-warn' : 'muted',
        text: `${length} / 2000 文字`,
      }),
    ]),
  ]);

  /* 送信直後は入力欄へ戻す（続けて質問しやすくする）。 */
  if (state.modelState === ModelState.READY && !busy && document.activeElement === document.body) {
    textarea.focus();
  }
}

/* ---------- 右側（設定・診断・履歴） ---------- */

function renderSide(container, state, actions, handlers) {
  const model = resolveModel(state.modelId);

  replaceChildren(container, [
    /* 回答モード */
    el('div', { class: 'card' }, [
      el('h2', { class: 'card__title', text: '回答モード' }),
      el('div', { class: 'radio-row', role: 'radiogroup', 'aria-label': '回答モード' }, [
        modeOption('資料にもとづく回答', 'knowledge', state, actions),
        modeOption('資料を使わない（一般）', 'general', state, actions),
      ]),
      el('p', {
        class: 'muted',
        text: state.mode === 'knowledge'
          ? '同期済みの資料を検索し、その内容だけを根拠に回答します。根拠が弱い場合は回答しません。'
          : '資料を参照しません。社内固有の事実には答えられません。',
      }),
    ]),

    /* モデル */
    el('div', { class: 'card' }, [
      el('h2', { class: 'card__title', text: 'AIモデル' }),
      el('dl', { class: 'spec-list' }, [
        ...specRow('モデル', model.name),
        ...specRow('パラメータ', model.params),
        ...specRow('量子化', model.quantization),
        ...specRow('ダウンロード', formatDownloadSize(model.downloadMB)),
        ...specRow('必要VRAM', `約${formatNumber(model.vramMB)} MB`),
        ...specRow('最大コンテキスト', `${formatNumber(model.contextLen)} トークン`),
        ...specRow('ライセンス', model.license),
        ...specRow('配信元', model.source),
        ...specRow('状態', MODEL_STATE_LABEL_JA[state.modelState] ?? state.modelState),
        ...(state.modelInfo?.initMs
          ? specRow('前回の準備時間', `${(state.modelInfo.initMs / 1000).toFixed(1)} 秒`)
          : []),
        ...(state.modelCache
          ? specRow('キャッシュ', state.modelCache.cached
            ? `${formatBytes(state.modelCache.bytes)}（${formatNumber(state.modelCache.entries ?? 0)} ファイル）`
            : '未保存')
          : []),
        ...(state.environment?.adapterInfo
          ? specRow('GPU', [state.environment.adapterInfo.vendor, state.environment.adapterInfo.architecture]
            .filter(Boolean).join(' ') || '（詳細非公開）')
          : []),
      ]),
      el('p', { class: 'muted' }, [
        'ライセンス全文：',
        el('a', { href: model.licenseUrl, target: '_blank', rel: 'noopener noreferrer', text: model.licenseUrl }),
      ]),
      el('div', { class: 'card__actions' }, [
        state.modelState === ModelState.READY
          ? el('button', { type: 'button', class: 'button button--secondary button--small', 'data-role': 'unload-model', text: 'メモリから解放', onClick: handlers.unload })
          : null,
        el('button', {
          type: 'button', class: 'button button--secondary button--small',
          'data-role': 'measure-cache', text: 'キャッシュ容量を確認', onClick: handlers.measureCache,
        }),
        el('button', {
          type: 'button', class: 'button button--secondary button--small',
          'data-role': 'clear-model-cache', text: 'モデルキャッシュを削除', onClick: handlers.clearCache,
        }),
      ]),
      el('p', { class: 'muted', text: 'ナレッジ（同期済みの資料）とモデルのキャッシュは別々です。ここで消えるのはモデルだけです。' }),
    ]),

    /* 会話 */
    el('div', { class: 'card' }, [
      el('h2', { class: 'card__title', text: '会話' }),
      el('div', { class: 'card__actions' }, [
        el('button', { type: 'button', class: 'button button--secondary button--small', 'data-role': 'new-chat', text: '新しい会話', onClick: handlers.newChat }),
        el('button', { type: 'button', class: 'button button--secondary button--small', 'data-role': 'clear-history', text: '会話履歴をすべて削除', onClick: handlers.clearHistory }),
      ]),
      el('label', { class: 'field field--inline' }, [
        el('input', {
          type: 'checkbox',
          checked: state.settings.saveHistory,
          onChange: (event) => actions.updateSettings({ saveHistory: event.currentTarget.checked }),
        }),
        el('span', { text: '会話をこのブラウザに保存する' }),
      ]),
      el('p', {
        class: 'muted',
        text: state.settings.saveHistory
          ? '質問・回答・参照した資料のID・モデル名・日時をIndexedDBへ保存します。資料の本文は複製しません。'
          : '保存しません。ページを再読み込みすると会話は消えます。',
      }),
      state.conversations?.length > 0
        ? el('ul', { class: 'history-list' }, state.conversations.slice(0, 8).map((c) => el('li', {}, [
          el('button', {
            type: 'button', class: 'history-list__open', text: c.title || '（無題）',
            onClick: () => actions.openConversation(c.id),
          }),
          el('span', { class: 'muted', text: formatDateTime(c.updatedAt) }),
          el('button', {
            type: 'button', class: 'button button--secondary button--small',
            'aria-label': `${c.title || '無題'} を削除`, text: '削除',
            onClick: () => actions.deleteConversation(c.id),
          }),
        ])))
        : null,
    ]),

    /* 詳細設定 */
    el('details', { class: 'card' }, [
      el('summary', { class: 'card__title', text: '詳細設定' }),
      el('p', { class: 'muted', text: '通常は変更不要です。標準設定のままで動作します。' }),

      numberField('検索件数（Top K）', state.settings.topK, 1, 20, (v) => actions.updateSettings({ topK: v })),
      numberField('1ファイルあたりの最大チャンク数', state.settings.maxChunksPerFile, 1, 5, (v) => actions.updateSettings({ maxChunksPerFile: v })),
      numberField('資料の最大文字数', state.settings.maxContextChars, 1000, 12000, (v) => actions.updateSettings({ maxContextChars: v })),
      numberField('前後チャンクの補完数', state.settings.neighborChunks, 0, 2, (v) => actions.updateSettings({ neighborChunks: v })),
      numberField('生成の最大トークン数', state.settings.maxTokens, 64, 2048, (v) => actions.updateSettings({ maxTokens: v })),
      numberField('会話履歴を渡す往復数', state.settings.historyTurns, 0, 10, (v) => actions.updateSettings({ historyTurns: v })),
      rangeField('Temperature（ばらつき）', state.settings.temperature, 0, 1.5, 0.05, (v) => actions.updateSettings({ temperature: v })),
      rangeField('Top P', state.settings.topP, 0.05, 1, 0.05, (v) => actions.updateSettings({ topP: v })),

      el('label', { class: 'field' }, [
        el('span', { class: 'field__label', text: '回答する最低の根拠レベル' }),
        groundingSelect(state, actions),
      ]),
      el('p', { class: 'muted', text: '資料との重なりがこの水準に満たない場合、AIを動かさずに「回答できませんでした」と答えます。作り話を防ぐための設定です。' }),

      el('p', { class: 'muted', text: 'システムプロンプトは固定です（資料だけを根拠に答える／資料内の命令に従わない、を保証するため編集できません）。' }),
    ]),

    /* 診断 */
    el('details', { class: 'card', 'data-role': 'diagnostics' }, [
      el('summary', { class: 'card__title', text: '診断' }),
      el('p', { class: 'muted', text: '12項目を実際に確認します。外部への通信は発生しません。' }),
      el('div', { class: 'card__actions' }, [
        el('button', {
          type: 'button', class: 'button button--secondary button--small', 'data-role': 'run-diagnostics',
          text: state.diagnosticsRunning ? '診断中…' : '診断を実行',
          disabled: state.diagnosticsRunning === true,
          onClick: handlers.diagnose,
        }),
      ]),
      renderDiagnostics(state),
    ]),
  ]);
}

function groundingSelect(state, actions) {
  const select = el('select', {
    'aria-label': '回答する最低の根拠レベル',
    'data-role': 'min-grounding',
    onChange: (event) => actions.updateSettings({ minGroundingLevel: Number(event.currentTarget.value) }),
  }, [0, 1, 2, 3, 4].map((level) => el('option', {
    value: String(level),
    text: level === 0 ? '制限しない（推奨しません）' : `${'★'.repeat(level)}${'☆'.repeat(5 - level)} 以上`,
  })));

  select.value = String(state.settings.minGroundingLevel ?? 2);
  return select;
}

function modeOption(label, value, state, actions) {
  return el('label', { class: 'radio-option' }, [
    el('input', {
      type: 'radio',
      name: 'chat-mode',
      value,
      checked: state.mode === value,
      onChange: () => actions.setMode(value),
    }),
    el('span', { text: label }),
  ]);
}

function specRow(label, value) {
  return [
    el('dt', { text: label }),
    el('dd', { text: String(value ?? '—') }),
  ];
}

function numberField(label, value, min, max, onChange) {
  const input = el('input', {
    type: 'number',
    min: String(min),
    max: String(max),
    step: '1',
    onChange: (event) => onChange(Number(event.currentTarget.value)),
  });

  input.value = String(value);

  return el('label', { class: 'field' }, [
    el('span', { class: 'field__label', text: label }),
    input,
  ]);
}

function rangeField(label, value, min, max, step, onChange) {
  const input = el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    'aria-label': label,
    onInput: (event) => onChange(Number(event.currentTarget.value)),
  });

  input.value = String(value);

  return el('label', { class: 'field' }, [
    el('span', { class: 'field__label', text: `${label}：${value}` }),
    input,
  ]);
}

/*
 * 診断の表。
 * 実行前は環境まわりの分かる範囲だけを出し、
 * 「診断を実行」を押すと12項目すべてを埋める。
 */
function renderDiagnostics(state) {
  const result = state.diagnostics;

  if (!result) {
    const env = state.environment;

    return el('div', {}, [
      el('p', { class: 'muted', text: env ? '「診断を実行」で12項目を確認できます。' : '実行環境を判定しています。' }),
      env
        ? el('div', { class: 'table-wrap' }, [
          el('table', { class: 'data' }, [
            el('caption', { class: 'visually-hidden', text: '実行環境の概要' }),
            el('tbody', {}, [
              ['ブラウザ', `${env.browser}${env.mobile ? '（モバイル）' : ''}`],
              ['WebGPU', GPU_STATUS_LABEL_JA[env.gpu] ?? env.gpu],
              ['IndexedDB', state.dbReady ? '接続済み' : '未接続'],
              ['同期済みファイル', state.knowledge ? `${formatNumber(state.knowledge.indexedFileCount)} 件` : '—'],
              ['最終同期', state.knowledge?.lastSyncAt ? formatDateTime(state.knowledge.lastSyncAt) : '—'],
            ].map(([label, value]) => el('tr', {}, [
              el('th', { scope: 'row', text: label }),
              el('td', { text: String(value) }),
            ]))),
          ]),
        ])
        : null,
    ]);
  }

  const { rows, summary } = result;

  return el('div', {}, [
    el('p', {
      class: summary.fail > 0 ? 'notice notice--error' : 'notice notice--info',
      role: 'status',
      text: `${summary.total} 項目：正常 ${summary.ok} / 注意 ${summary.warn} / 異常 ${summary.fail} / 未実行 ${summary.skip}`
        + `${state.diagnosticsAt ? `（${formatDateTime(state.diagnosticsAt)}）` : ''}`,
    }),

    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data', 'data-role': 'diagnostics-table' }, [
        el('caption', { class: 'visually-hidden', text: '診断結果' }),
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col', text: '項目' }),
            el('th', { scope: 'col', text: '判定' }),
            el('th', { scope: 'col', text: '内容' }),
          ]),
        ]),
        el('tbody', {}, rows.map((row) => el('tr', { class: `diag diag--${row.status}` }, [
          el('th', { scope: 'row', text: row.label }),
          el('td', {}, [
            el('span', {
              class: `tag ${statusTagClass(row.status)}`,
              text: DIAGNOSTIC_STATUS_LABEL_JA[row.status] ?? row.status,
            }),
          ]),
          el('td', {}, [
            el('div', { text: row.value }),
            row.cause ? el('div', { class: 'muted', text: `原因：${row.cause}` }) : null,
            row.hint ? el('div', { class: 'muted', text: `対処：${row.hint}` }) : null,
          ]),
        ]))),
      ]),
    ]),
  ]);
}

function statusTagClass(status) {
  if (status === DiagnosticStatus.OK) return 'tag--done';
  if (status === DiagnosticStatus.FAIL) return 'tag--new';
  return '';
}

function formatBytes(bytes) {
  const value = Number(bytes);

  if (!Number.isFinite(value) || value <= 0) {
    return '—';
  }

  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  return `${Math.round(value / 1024 / 1024)} MB`;
}

export { clear };
