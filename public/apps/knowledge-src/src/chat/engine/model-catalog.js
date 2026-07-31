/*
 * 利用できるモデルの一覧。
 *
 * ------------------------------------------------------------------
 * ここに書いてよいのは「WebLLM が実際に配布しているモデル」だけ
 * ------------------------------------------------------------------
 * model_id は @mlc-ai/web-llm 0.2.84 の prebuiltAppConfig.model_list に
 * 実在するものだけを載せている。値は下記の実測にもとづく。
 *
 *   downloadMB … HuggingFace の API で取得したリポジトリ内ファイルの合計
 *   vramMB     … prebuiltAppConfig の vram_required_MB
 *   contextLen … prebuiltAppConfig の overrides.context_window_size
 *
 * 起動時に assertCatalogIsSupported() でライブラリ側の一覧と突き合わせ、
 * 存在しない model_id を画面へ出さないようにしている。
 * ------------------------------------------------------------------
 */

export const ModelTier = Object.freeze({
  LIGHT: 'light',
  STANDARD: 'standard',
  ADVANCED: 'advanced',
});

export const MODEL_CATALOG = Object.freeze([
  Object.freeze({
    id: 'gemma-2-2b-jpn-it-q4f16_1-MLC',
    tier: ModelTier.LIGHT,
    name: 'Gemma 2 2B 日本語版',
    params: '約20億',
    quantization: 'q4f16_1（4bit量子化 / fp16）',
    downloadMB: 1424,
    vramMB: 1895,
    contextLen: 4096,
    license: 'Gemma 利用規約（商用利用可・利用ポリシーあり）',
    licenseUrl: 'https://ai.google.dev/gemma/terms',
    source: 'huggingface.co / mlc-ai',
    japanese: 'Google公式の日本語チューニング版。日本語の資料に最も向く。',
    note: '最初はこれを推奨。ダウンロードが最も小さく、一般的なWebGPU対応PCで動く。',
  }),
  Object.freeze({
    id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',
    tier: ModelTier.STANDARD,
    name: 'Qwen2.5 3B Instruct',
    params: '約30億',
    quantization: 'q4f16_1（4bit量子化 / fp16）',
    downloadMB: 1667,
    vramMB: 2505,
    contextLen: 4096,
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct',
    source: 'huggingface.co / mlc-ai',
    japanese: '多言語モデル。日本語も扱えるが、日本語専用チューニングではない。',
    note: '軽量版より説明が丁寧になりやすい。VRAM 4GB 以上を推奨。',
  }),
  Object.freeze({
    id: 'Qwen3-4B-q4f16_1-MLC',
    tier: ModelTier.ADVANCED,
    name: 'Qwen3 4B',
    params: '約40億',
    quantization: 'q4f16_1（4bit量子化 / fp16）',
    downloadMB: 2174,
    vramMB: 3432,
    contextLen: 4096,
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen3-4B',
    source: 'huggingface.co / mlc-ai',
    japanese: '多言語モデル。3つの中では最も長い文章を扱いやすい。',
    note: 'VRAM 6GB 以上を推奨。ダウンロードと初期化に最も時間がかかる。'
      + '思考過程を出力することがあるため、回答表示時に取り除いている。',
  }),
]);

export const DEFAULT_MODEL_ID = MODEL_CATALOG[0].id;

export const TIER_LABEL_JA = Object.freeze({
  [ModelTier.LIGHT]: '軽量（推奨）',
  [ModelTier.STANDARD]: '標準',
  [ModelTier.ADVANCED]: '上級',
});

export function findModel(modelId) {
  return MODEL_CATALOG.find((model) => model.id === modelId) ?? null;
}

export function resolveModel(modelId) {
  return findModel(modelId) ?? MODEL_CATALOG[0];
}

/*
 * ライブラリ側が実際に配布している model_id と突き合わせる。
 *
 * supportedIds はライブラリから取り出した文字列配列。
 * 一致しないものは画面へ出さない（存在しないモデルを選ばせない）。
 */
export function filterSupported(supportedIds) {
  if (!Array.isArray(supportedIds) || supportedIds.length === 0) {
    /* 一覧を取得できない場合は、カタログをそのまま使う（起動を止めない）。 */
    return { models: [...MODEL_CATALOG], missing: [] };
  }

  const set = new Set(supportedIds.map(String));

  return {
    models: MODEL_CATALOG.filter((model) => set.has(model.id)),
    missing: MODEL_CATALOG.filter((model) => !set.has(model.id)).map((model) => model.id),
  };
}

/* 表示用（1,424 MB → 「約1.4 GB」）。 */
export function formatDownloadSize(megabytes) {
  const mb = Number(megabytes);

  if (!Number.isFinite(mb) || mb <= 0) {
    return '—';
  }

  return mb >= 1024 ? `約${(mb / 1024).toFixed(1)} GB` : `約${Math.round(mb)} MB`;
}
