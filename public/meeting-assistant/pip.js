/*
 * PC 向け Document Picture-in-Picture（録音コントローラー）。
 *
 * 録音処理は持たない。既存 Recorder / mix / OPFS / Drive を操作する UI だけ。
 * 小窓を閉じても録音は止めない。停止は明示的な「録音停止」だけ。
 */

import { formatDuration } from './recorder/capabilities.js';

export const PIP_WINDOW_SIZE = {
  width: 360,
  height: 232,
};

export function isDocumentPipSupported(target = globalThis) {
  return typeof target?.documentPictureInPicture?.requestWindow === 'function';
}

export function recordingModeLabel(mode) {
  return mode === 'online' ? 'Remote' : 'On-site';
}

export function applyPipState(root, state = {}) {
  if (!root?.querySelector) {
    return;
  }

  const recording = Boolean(state.recording);
  const modeNode = root.querySelector('[data-pip="mode"]');
  const indicator = root.querySelector('[data-pip="indicator"]');
  const indicatorText = root.querySelector('[data-pip="indicator-text"]');
  const timer = root.querySelector('[data-pip="timer"]');
  const stop = root.querySelector('[data-pip="stop"]');
  const status = root.querySelector('[data-pip="status"]');

  if (root.dataset) {
    root.dataset.recording = recording ? 'true' : 'false';
  }

  if (modeNode) {
    modeNode.textContent = recordingModeLabel(state.mode);
  }

  if (indicator) {
    indicator.dataset.state = recording ? 'recording' : 'idle';
  }

  if (indicatorText) {
    indicatorText.textContent = recording ? '録音中' : '待機中';
  }

  if (timer) {
    timer.textContent = formatDuration(state.seconds);
  }

  if (stop) {
    stop.disabled = !recording;
  }

  if (status) {
    status.textContent = state.error || state.status || '';
  }
}

function copyStyleSheets(fromDoc, toDoc) {
  const links = fromDoc?.querySelectorAll?.('link[rel="stylesheet"]') ?? [];

  for (const link of links) {
    const cloned = toDoc.createElement('link');
    cloned.rel = 'stylesheet';
    cloned.href = link.href;
    toDoc.head.append(cloned);
  }
}

function createNode(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value == null) {
      continue;
    }

    if (key === 'text') {
      node.textContent = value;
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else {
      node[key] = value;
    }
  }

  for (const child of children) {
    node.append(child);
  }

  return node;
}

function mountPipUi(pipWindow, { onStop, onClose }) {
  const doc = pipWindow.document;
  doc.documentElement.lang = 'ja';
  doc.title = 'Meeting Assistant';
  doc.body.className = 'ma-pip-page';

  const stop = createNode(doc, 'button', {
    type: 'button',
    className: 'ma-button ma-pip-stop',
    text: '録音停止',
    dataset: { pip: 'stop' },
  });
  stop.disabled = true;

  const close = createNode(doc, 'button', {
    type: 'button',
    className: 'ma-button ma-button--ghost ma-pip-close',
    text: '閉じる',
    dataset: { pip: 'close' },
  });

  const root = createNode(doc, 'div', { className: 'ma-pip', dataset: { pip: 'root' } }, [
    createNode(doc, 'p', { className: 'ma-pip__brand', text: 'Meeting Assistant' }),
    createNode(doc, 'p', { className: 'ma-pip__mode', dataset: { pip: 'mode' }, text: 'On-site' }),
    createNode(doc, 'div', {
      className: 'vr-indicator ma-pip__indicator',
      dataset: { pip: 'indicator', state: 'idle' },
    }, [
      createNode(doc, 'span', { className: 'vr-indicator__dot' }),
      createNode(doc, 'span', { dataset: { pip: 'indicator-text' }, text: '待機中' }),
    ]),
    createNode(doc, 'p', { className: 'ma-pip__timer', dataset: { pip: 'timer' }, text: formatDuration(0) }),
    createNode(doc, 'div', { className: 'ma-pip__actions' }, [stop, close]),
    createNode(doc, 'p', { className: 'vr-note ma-pip__status', dataset: { pip: 'status' }, text: '' }),
  ]);

  doc.body.append(root);

  stop.addEventListener('click', () => {
    onStop?.();
  });

  close.addEventListener('click', () => {
    onClose?.();
  });

  return root;
}

export function createDocumentPip(options = {}) {
  const api = options.api ?? globalThis.documentPictureInPicture;
  const ownerDocument = options.ownerDocument ?? globalThis.document;
  let pipWindow = null;
  let root = null;
  let lastState = {
    mode: 'offline',
    recording: false,
    seconds: 0,
    status: '',
    error: '',
  };

  function supported() {
    return typeof api?.requestWindow === 'function';
  }

  function sync(patch = {}) {
    lastState = { ...lastState, ...patch };
    if (!pipWindow || pipWindow.closed || !root) {
      return;
    }
    applyPipState(root, lastState);
  }

  function close() {
    const current = pipWindow;
    pipWindow = null;
    root = null;
    if (current && !current.closed) {
      try {
        current.close();
      } catch {
        /* 閉じられなくても録音には触れない。 */
      }
    }
  }

  async function open(patch = {}) {
    if (!supported()) {
      const error = new Error('document_pip_unsupported');
      error.code = 'DOCUMENT_PIP_UNSUPPORTED';
      throw error;
    }

    lastState = { ...lastState, ...patch };

    if (pipWindow && !pipWindow.closed) {
      sync();
      pipWindow.focus?.();
      return pipWindow;
    }

    const nextWindow = await api.requestWindow({
      width: PIP_WINDOW_SIZE.width,
      height: PIP_WINDOW_SIZE.height,
    });

    pipWindow = nextWindow;
    copyStyleSheets(ownerDocument, nextWindow.document);
    root = mountPipUi(nextWindow, {
      onStop: () => options.onStop?.(),
      onClose: () => close(),
    });
    applyPipState(root, lastState);

    nextWindow.addEventListener('pagehide', () => {
      if (pipWindow === nextWindow) {
        pipWindow = null;
        root = null;
      }
    });

    return nextWindow;
  }

  return {
    supported,
    open,
    sync,
    close,
    isOpen() {
      return Boolean(pipWindow && !pipWindow.closed);
    },
  };
}
