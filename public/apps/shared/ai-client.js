/*
 * AI呼び出しの共通入口。**雛形**
 *
 * ------------------------------------------------------------------
 * Phase 1 時点の状態
 * ------------------------------------------------------------------
 * モードからプロバイダを選び、実行前に可否を判定するところまでが実装済み。
 * **実際のAI処理は未実装**で、run() は NOT_IMPLEMENTED を投げる。
 * 中身は Phase 6 で providers/ に実装する。
 *
 * このファイルの目的は「各アプリが呼ぶ形を今のうちに1つに固定しておく」こと。
 * アプリ側は providers/ を直接 import しない。ここだけを使う。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 送信内容についての約束
 * ------------------------------------------------------------------
 * 無料モード（local）は **外部へ一切送信しない**。
 * マイAPIキーモード（gemini）は、利用者のキーで利用者のデータを送る。
 * どのモードでも、当社のサーバーや GAS へ内容を送らない。
 *
 * この約束を破らないよう、providers/ 以外に fetch を書かないこと。
 * ------------------------------------------------------------------
 */

import { AI_MODE, getAiMode, getAiConfig } from './ai-config.js';
import { AiError, AiErrorCode } from './ai-types.js';
import * as localProvider from './providers/local.js';
import * as geminiProvider from './providers/gemini.js';

/*
 * 共通の型はここから再エクスポートする。
 * 各アプリは ai-types.js を直接 import しなくてよい。
 */
export { AI_TASK, AiError, AiErrorCode, createAiResult } from './ai-types.js';

/* モードとプロバイダの対応表。モードを増やしたらここへ追加する。 */
const PROVIDERS = Object.freeze({
  [AI_MODE.FREE]: localProvider,
  [AI_MODE.MY_KEY]: geminiProvider,
});

/* 現在のモードに対応するプロバイダを返す。 */
export function getProvider(mode = getAiMode()) {
  const provider = PROVIDERS[mode];

  if (!provider) {
    throw new AiError(AiErrorCode.MODE_UNSUPPORTED, String(mode));
  }

  return provider;
}

/*
 * 現在の設定で実行できるかどうか。
 * 実行前に画面で案内を出すために使う（ボタンの有効・無効の切り替えなど）。
 *
 * 戻り値: { ok, reason, code, mode, provider }
 * 例外は投げない。判定結果として返す。
 */
export function checkReady({ task = null, mode = getAiMode() } = {}) {
  const provider = PROVIDERS[mode];

  if (!provider) {
    return {
      ok: false,
      reason: '対応していないAI利用モードです。',
      code: AiErrorCode.MODE_UNSUPPORTED,
      mode,
      provider: null,
    };
  }

  if (task !== null && provider.CAPABILITIES?.[task] !== true) {
    return {
      ok: false,
      reason: `${provider.PROVIDER_LABEL}はこの処理に対応していません。`,
      code: AiErrorCode.TASK_UNSUPPORTED,
      mode,
      provider: provider.PROVIDER_ID,
    };
  }

  const availability = provider.isAvailable();

  if (!availability.ok) {
    return {
      ok: false,
      reason: availability.reason,
      code: availability.code ?? AiErrorCode.UNKNOWN,
      mode,
      provider: provider.PROVIDER_ID,
    };
  }

  return {
    ok: true,
    reason: null,
    code: null,
    mode,
    provider: provider.PROVIDER_ID,
  };
}

/*
 * AI処理を実行する。
 *
 * 引数:
 *   task    … AI_TASK のいずれか
 *   input   … 処理対象の文字列
 *   options … プロバイダ固有の任意設定
 *   signal  … AbortSignal（任意）
 *   mode    … モードの明示指定（省略時は現在の設定）
 *
 * ------------------------------------------------------------------
 * Phase 1 では必ず AiError を投げる（NOT_IMPLEMENTED）。
 * 呼び出し側は今のうちから catch して
 * 「この機能は準備中です」と表示できるようにしておくこと。
 * ------------------------------------------------------------------
 */
export async function runAiTask({ task, input, options = {}, signal, mode = getAiMode() } = {}) {
  if (typeof task !== 'string' || task === '') {
    throw new AiError(AiErrorCode.INVALID_INPUT, 'task_missing');
  }

  if (typeof input !== 'string' || input.trim() === '') {
    throw new AiError(AiErrorCode.INVALID_INPUT, 'input_missing');
  }

  const ready = checkReady({ task, mode });

  if (!ready.ok) {
    throw new AiError(ready.code, ready.reason);
  }

  return getProvider(mode).run({ task, input, options, signal });
}

/*
 * 画面のモード選択に出す一覧。
 * 各モードが「今すぐ使えるか」も併せて返す。
 */
export function listModes() {
  return Object.entries(PROVIDERS).map(([mode, provider]) => {
    const availability = provider.isAvailable();

    return {
      mode,
      providerId: provider.PROVIDER_ID,
      label: provider.PROVIDER_LABEL,
      available: availability.ok,
      reason: availability.reason,
    };
  });
}

/* 現在の設定の要約。APIキーの実値は含まれない。 */
export function getAiStatus() {
  const config = getAiConfig();

  return {
    ...config,
    ...checkReady({ mode: config.mode }),
  };
}
