/*
 * 録音アプリの通知パネルを Node 上で動かすための、最小のブラウザもどき。
 *
 * ==================================================================
 * なぜここまでするのか
 * ==================================================================
 * 実機で「保存はできているのに、復元できていないように見える」という
 * 壊れ方をした（2026-08-11）。前回のテストは
 *
 *   notifier-config.js の writeConnection → readConnection の往復
 *
 * だけを見ており、**これは通っていた。** すり抜けたのは、
 * 実際に起きる順序がその往復ではなかったからである。
 *
 *   保存 → 入力欄を空にする → ページを開き直す（モジュールも作り直される）
 *   → 復元 → **入力欄を触らずに**接続テストが動く
 *
 * この順序を通すには、notifier-panel.js を本当に mount するしかない。
 * document も Notification も無い Node で動かすため、パネルが触る範囲だけの
 * 偽物をここへ置く。
 * ==================================================================
 *
 * 再現していないもの（このテストに要らないため）:
 *   - レイアウト・イベント伝播・フォームの既定動作
 *   - Service Worker の実体（登録は失敗させ、その行が × になることを見る）
 */

class FakeClassList {
  constructor() {
    this.tokens = new Set();
  }

  add(name) { this.tokens.add(name); }

  remove(name) { this.tokens.delete(name); }

  toggle(name, force) {
    if (force === true) {
      this.tokens.add(name);
    } else if (force === false) {
      this.tokens.delete(name);
    } else if (this.tokens.has(name)) {
      this.tokens.delete(name);
    } else {
      this.tokens.add(name);
    }
  }

  contains(name) { return this.tokens.has(name); }
}

class FakeElement {
  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.value = '';
    this.textContent = '';
    this.placeholder = '';
    this.href = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.dataset = {};
    this.classList = new FakeClassList();
    this.children = [];
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];

    list.push(handler);
    this.listeners.set(type, list);
  }

  /** 登録されたハンドラを呼ぶ。テストから「ボタンを押す」ために使う。 */
  async dispatch(type, event = { preventDefault() {} }) {
    for (const handler of this.listeners.get(type) ?? []) {
      await handler.call(this, event);
    }
  }

  append(...nodes) { this.children.push(...nodes); }

  replaceChildren(...nodes) { this.children = [...nodes]; }
}

/**
 * パネルが読む要素をひととおり用意する。
 *
 * **id は notifier-panel.js の ELEMENT_IDS と index.html に合わせる。**
 * 足りない id は getElementById が null を返し、パネル側の
 * 「要素が無ければ何もしない」経路に落ちる（本番の壊れ方と同じ）。
 */
const PANEL_ELEMENT_IDS = [
  'vr-notifier-panel',
  'vr-nf-state-health', 'vr-nf-state-key', 'vr-nf-state-permission',
  'vr-nf-state-subscription', 'vr-nf-state-trigger', 'vr-nf-state-license',
  'vr-nf-hint-health', 'vr-nf-hint-key', 'vr-nf-hint-permission',
  'vr-nf-hint-subscription', 'vr-nf-hint-trigger', 'vr-nf-hint-license',
  'vr-nf-permission',
  'vr-nf-setup', 'vr-nf-template', 'vr-nf-url', 'vr-nf-key', 'vr-nf-key-state',
  'vr-nf-connect', 'vr-nf-disconnect',
  'vr-nf-connection', 'vr-nf-settings-form',
  'vr-nf-accepted', 'vr-nf-tentative', 'vr-nf-needsAction', 'vr-nf-declined',
  'vr-nf-timedOnly', 'vr-nf-timing', 'vr-nf-save', 'vr-nf-recheck',
  'vr-nf-test', 'vr-nf-upcoming', 'vr-nf-upcoming-empty',
  'vr-nf-license-state', 'vr-nf-license-link',
  'vr-nf-message', 'vr-event-banner',
];

/**
 * 画面を1つ作って globalThis へ据える。
 *
 * **「ページを開き直す」ときは、これをもう一度呼んで作り直す。**
 * 前の画面の入力値が残らないことが、この検証の肝である。
 */
/*
 * index.html で hidden 属性が付いている要素。
 * **初期値を実物に合わせる。** 合わせないと「出していないこと」の検査が
 * 素通りし、表示の抜けを見逃す。
 */
const INITIALLY_HIDDEN_IDS = [
  'vr-nf-key-state', 'vr-nf-upcoming', 'vr-nf-license-link',
  'vr-nf-message', 'vr-event-banner',
  'vr-nf-hint-health', 'vr-nf-hint-key', 'vr-nf-hint-permission',
  'vr-nf-hint-subscription', 'vr-nf-hint-trigger', 'vr-nf-hint-license',
];

export function installFakeNotifierDom({ notificationPermission = 'granted' } = {}) {
  const elements = new Map();

  for (const id of PANEL_ELEMENT_IDS) {
    const element = new FakeElement(id, id === 'vr-nf-settings-form' ? 'form' : 'div');

    element.hidden = INITIALLY_HIDDEN_IDS.includes(id);
    elements.set(id, element);
  }

  globalThis.document = {
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tagName) => new FakeElement('', tagName),
  };

  globalThis.Notification = {
    permission: notificationPermission,
    requestPermission: async () => notificationPermission,
  };

  /*
   * Service Worker は用意しない。登録が失敗し、「この端末の登録」の行が
   * × になる。**接続そのものの検証には影響しない**（そこは別の行）。
   *
   * Node の navigator は getter のみで代入できないため、defineProperty で置く。
   */
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
    writable: true,
  });

  const storage = new Map();

  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
  };

  return {
    el(id) { return elements.get(id) ?? null; },

    /** ボタンを押す。 */
    click(id) { return elements.get(id).dispatch('click'); },
  };
}

/**
 * GAS の応答をまとめて差し込む。
 *
 * 戻り値の calls に、飛んだ要求が順に入る。
 * **接続キーがどの値で飛んだか**を、ここで見る。
 */
export function installFakeGasFetch({
  publicKey = 'FAKE-PUBLIC-KEY',
  execUrlDigest = '',
  connectKey = null,
  /*
   * publicKey を失敗させる。**実機で起きた鶏卵の再現に要る。**
   * ライセンスが GAS へ届いていないと鍵は取れず、その状態で
   * 「確認してから保存」していると、保存に永久に到達しない。
   */
  publicKeyError = '',
  /* health が持ち帰るゲートの失敗。画面に出す文言の検証に使う。 */
  lastGateError = '',
} = {}) {
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const isPost = String(init.method ?? 'GET').toUpperCase() === 'POST';
    const body = isPost && init.body ? JSON.parse(init.body) : null;
    const query = url.includes('?') ? new URLSearchParams(url.split('?')[1]) : new URLSearchParams();
    const action = isPost ? String(body?.action ?? '') : String(query.get('action') ?? '');

    calls.push({ url, action, method: isPost ? 'POST' : 'GET', key: isPost ? body?.key : query.get('key'), body });

    /* 接続キーを指定していれば、合わないものは本番と同じく撥ねる。 */
    if (connectKey !== null && action !== 'health' && calls.at(-1).key !== connectKey) {
      return jsonResponse({ ok: false, error: { code: 'UNAUTHORIZED', message: '' } });
    }

    if (action === 'health') {
      return jsonResponse({
        ok: true,
        data: {
          ok: true, version: '2.0.0', deployedVersion: '1', execUrlDigest,
          lastTickAt: '', triggerActive: true, configured: true, licensed: true,
          lastGateError,
        },
      });
    }

    if (action === 'ping') {
      return jsonResponse({ ok: true, data: { version: '2.0.0', deployedVersion: '1', execUrlDigest } });
    }

    if (action === 'publicKey') {
      if (publicKeyError !== '') {
        return jsonResponse({ ok: false, error: { code: publicKeyError, message: '' } });
      }

      return jsonResponse({ ok: true, data: { publicKey } });
    }

    if (action === 'getSettings') {
      return jsonResponse({
        ok: true,
        data: {
          settings: { accepted: true, tentative: true, needsAction: true, declined: false, timedOnly: true, timing: 5 },
          license: { present: true, state: 'active', checkedAt: '' },
        },
      });
    }

    if (action === 'upcoming') {
      return jsonResponse({ ok: true, data: { upcoming: [] } });
    }

    return jsonResponse({ ok: true, data: {} });
  };

  return calls;
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}
