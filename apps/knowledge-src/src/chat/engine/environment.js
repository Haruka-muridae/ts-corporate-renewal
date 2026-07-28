/*
 * 実行環境の診断。
 *
 * ------------------------------------------------------------------
 * 判定ロジックは純粋関数に分けてある
 * ------------------------------------------------------------------
 * probeEnvironment() だけがブラウザAPIに触れ、
 * classifyEnvironment() は「集めた事実」から結論を出すだけにしてある。
 * こうしておくと、WebGPUの無い環境でも全分岐を単体テストで確認できる。
 * ------------------------------------------------------------------
 */

export const GpuStatus = Object.freeze({
  OK: 'ok',                       // WebGPUが使える
  NO_API: 'no-api',               // navigator.gpu が無い
  NO_ADAPTER: 'no-adapter',       // アダプターを取得できない
  NOT_SECURE: 'not-secure',       // セキュアコンテキストでない
  ERROR: 'error',                 // 取得中に例外
});

export const GPU_STATUS_LABEL_JA = Object.freeze({
  [GpuStatus.OK]: '利用可能',
  [GpuStatus.NO_API]: '非対応',
  [GpuStatus.NO_ADAPTER]: 'アダプター取得不可',
  [GpuStatus.NOT_SECURE]: '安全な接続でない',
  [GpuStatus.ERROR]: '判定に失敗',
});

/*
 * ブラウザ種別を UA から大まかに判定する。
 * 案内文の出し分けにしか使わない（機能の可否には使わない）。
 */
export function detectBrowser(userAgent = '') {
  const ua = String(userAgent);

  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/CriOS\//.test(ua)) return 'Chrome (iOS)';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return '不明';
}

export function detectMobile(userAgent = '') {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(String(userAgent));
}

/*
 * 集めた事実から結論を出す。
 *
 * facts:
 *   { secureContext, hasGpuApi, adapter, adapterError,
 *     indexedDb, cacheStorage, webAssembly, sharedArrayBuffer,
 *     crossOriginIsolated, userAgent, online, storageEstimate }
 */
export function classifyEnvironment(facts = {}) {
  const browser = detectBrowser(facts.userAgent);
  const mobile = detectMobile(facts.userAgent);

  let gpu = GpuStatus.OK;
  let message = 'WebGPUを利用できます。';
  let hint = '';

  if (!facts.secureContext) {
    gpu = GpuStatus.NOT_SECURE;
    message = '安全な接続（HTTPS）でないため、WebGPUを利用できません。';
    hint = 'https:// で始まるURLか、localhost で開いてください。';
  } else if (!facts.hasGpuApi) {
    gpu = GpuStatus.NO_API;
    message = 'このブラウザではWebGPUを利用できません。';
    hint = mobile
      ? 'PCの最新版 Chrome または Edge をご利用ください。スマートフォンでは動作しないことがあります。'
      : '最新版の Chrome または Edge をご利用ください（Safari・Firefox では未対応の場合があります）。';
  } else if (facts.adapterError) {
    gpu = GpuStatus.ERROR;
    message = 'WebGPUの初期化中に問題が発生しました。';
    hint = 'ブラウザを再起動するか、ハードウェアアクセラレーションが有効かご確認ください。';
  } else if (!facts.adapter) {
    gpu = GpuStatus.NO_ADAPTER;
    message = 'WebGPUのアダプター（GPU）を取得できませんでした。';
    hint = 'ブラウザ設定でハードウェアアクセラレーションを有効にしてから、再読み込みしてください。';
  }

  /* 実行に必要な前提。1つでも欠けると動かない。 */
  const requirements = [
    { id: 'secureContext', label: '安全な接続（HTTPS）', ok: facts.secureContext === true, required: true },
    { id: 'webgpu', label: 'WebGPU', ok: gpu === GpuStatus.OK, required: true },
    { id: 'webassembly', label: 'WebAssembly', ok: facts.webAssembly === true, required: true },
    { id: 'indexedDb', label: 'IndexedDB（ナレッジの読み出し）', ok: facts.indexedDb === true, required: true },
    { id: 'cacheStorage', label: 'Cache Storage（モデルの保存先）', ok: facts.cacheStorage === true, required: true },
  ];

  /* 参考情報。欠けていても動く。 */
  const optional = [
    {
      id: 'sharedArrayBuffer',
      label: 'SharedArrayBuffer（CPU実行の高速化）',
      ok: facts.sharedArrayBuffer === true,
      note: facts.crossOriginIsolated === true
        ? '利用できます。'
        : 'この配信構成では利用できません。CPUのみでの実行は現実的な速度になりません。',
    },
    { id: 'online', label: 'ネットワーク接続', ok: facts.online === true, note: facts.online === true ? 'オンラインです。' : 'オフラインです。モデルが未取得の場合は準備できません。' },
  ];

  const blocking = requirements.filter((r) => r.required && !r.ok);

  return {
    gpu,
    gpuLabel: GPU_STATUS_LABEL_JA[gpu],
    message,
    hint,
    browser,
    mobile,
    /* すべての必須条件を満たしているか。 */
    usable: blocking.length === 0,
    blocking,
    requirements,
    optional,
    adapterInfo: facts.adapter ?? null,
    storageEstimate: facts.storageEstimate ?? null,
    online: facts.online === true,
  };
}

/*
 * 実際にブラウザAPIを叩いて事実を集める。
 *
 * requestAdapter() は端末によっては時間がかかるため、必ず上限を設ける
 * （返ってこないまま画面が「判定中」で固まるのを防ぐ）。
 */
export async function probeEnvironment({ timeoutMs = 8000 } = {}) {
  const nav = globalThis.navigator ?? {};

  const facts = {
    secureContext: globalThis.isSecureContext === true,
    hasGpuApi: Boolean(nav.gpu),
    adapter: null,
    adapterError: null,
    indexedDb: typeof globalThis.indexedDB !== 'undefined',
    cacheStorage: typeof globalThis.caches !== 'undefined',
    webAssembly: typeof globalThis.WebAssembly === 'object',
    sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === 'function',
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    userAgent: String(nav.userAgent ?? ''),
    online: nav.onLine !== false,
    storageEstimate: null,
  };

  if (facts.hasGpuApi) {
    try {
      const adapter = await withTimeout(nav.gpu.requestAdapter({ powerPreference: 'high-performance' }), timeoutMs);

      if (adapter) {
        facts.adapter = summarizeAdapter(adapter);
      }
    } catch (error) {
      facts.adapterError = String(error?.name ?? error).slice(0, 80);
    }
  }

  if (typeof nav.storage?.estimate === 'function') {
    try {
      const estimate = await nav.storage.estimate();
      facts.storageEstimate = {
        usage: Number(estimate?.usage ?? 0),
        quota: Number(estimate?.quota ?? 0),
      };
    } catch {
      /* 取得できない環境がある。表示しないだけで機能には影響しない。 */
    }
  }

  return classifyEnvironment(facts);
}

/*
 * アダプターから表示してよい情報だけを取り出す。
 * 端末を一意に特定しうる詳細は持ち出さない。
 */
function summarizeAdapter(adapter) {
  const limits = adapter.limits ?? {};
  const info = adapter.info ?? {};

  return {
    vendor: String(info.vendor ?? ''),
    architecture: String(info.architecture ?? ''),
    description: String(info.description ?? ''),
    /* モデルが載るかの目安になる値だけ。 */
    maxBufferSize: Number(limits.maxBufferSize ?? 0),
    maxStorageBufferBindingSize: Number(limits.maxStorageBufferBindingSize ?? 0),
    features: typeof adapter.features?.has === 'function'
      ? ['shader-f16'].filter((f) => adapter.features.has(f))
      : [],
  };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AdapterTimeout')), ms);

    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/*
 * モデルが現実的に動くかの目安。
 * WebGPU の maxBufferSize は必要VRAMの下限判定に使える。
 */
export function canRunModel(environment, model) {
  if (!environment?.usable || !model) {
    return { ok: false, reason: 'environment' };
  }

  const max = Number(environment.adapterInfo?.maxStorageBufferBindingSize ?? 0);

  /* 情報が取れない環境では止めない（実行して初めて分かる）。 */
  if (max <= 0) {
    return { ok: true, reason: null };
  }

  /*
   * 重みは複数バッファに分割されるため、必要VRAM全体と直接は比較できない。
   * ここでは「極端に小さいGPU」だけを弾く。
   */
  if (max < 128 * 1024 * 1024) {
    return { ok: false, reason: 'gpu-too-small' };
  }

  return { ok: true, reason: null };
}
