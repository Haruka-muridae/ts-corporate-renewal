/*
 * 画面の状態を1か所で持つ。
 *
 * DOM・fetch・文言をここに置かない（純粋な状態機械として保つ）。
 * 画面の更新は script.js が subscribe() で受け取って行う。
 *
 * 状態が増えたときは、CAN の表を必ず更新すること。
 * 「ボタンを押せるか」の判断をこのファイルの外へ散らさないための表である。
 */

export const State = Object.freeze({
  IDLE: 'idle',
  FILE_SELECTED: 'file-selected',
  LOADING_MODEL: 'loading-model',
  UPLOADING: 'uploading',
  TRANSCRIBING: 'transcribing',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  ERROR: 'error',
});

/* 処理中とみなす状態。ここに居る間は新しいファイルを受け付けない。 */
const BUSY_STATES = new Set([State.LOADING_MODEL, State.UPLOADING, State.TRANSCRIBING]);

/* ファイルを持っているとみなす状態。 */
const HAS_FILE_STATES = new Set([
  State.FILE_SELECTED,
  State.LOADING_MODEL,
  State.UPLOADING,
  State.TRANSCRIBING,
  State.COMPLETED,
  State.CANCELLED,
  State.ERROR,
]);

export function isBusy(state) {
  return BUSY_STATES.has(state);
}

export function hasFileIn(state) {
  return HAS_FILE_STATES.has(state);
}

/* ---------- 状態の保持 ---------- */

const listeners = new Set();

const initialSnapshot = Object.freeze({
  state: State.IDLE,
  /* { name, mimeType, size, durationSec, source, blob, objectUrl } または null */
  file: null,
  /* 'local' | 'gemini' */
  mode: 'local',
  /* 進捗 { label, ratio(0-1 または null) } */
  progress: null,
  /* 利用者に見せるエラー文言。機密情報は入れない。 */
  errorMessage: null,
  /* 文字起こし結果の本文。 */
  result: '',
  /* 結果の付帯情報 { elapsedMs, modeLabel, modelLabel } または null */
  resultMeta: null,
});

let snapshot = initialSnapshot;

export function getState() {
  return snapshot;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  listeners.forEach((listener) => listener(snapshot));
}

/*
 * 部分更新。渡したキーだけを差し替える。
 * snapshot は毎回作り直して凍結するので、受け取った側が書き換えても壊れない。
 */
export function update(patch) {
  snapshot = Object.freeze({ ...snapshot, ...patch });
  notify();
}

/* 状態遷移。付随して消すべき値もここでまとめて面倒を見る。 */
export function transition(next, patch = {}) {
  const base = { state: next, ...patch };

  if (next === State.IDLE) {
    Object.assign(base, {
      file: null,
      progress: null,
      errorMessage: null,
      result: '',
      resultMeta: null,
      ...patch,
    });
  }

  if (next === State.FILE_SELECTED) {
    /* 新しいファイルを選んだので、前回の結果とエラーは持ち越さない。 */
    Object.assign(base, { progress: null, errorMessage: null, result: '', resultMeta: null, ...patch });
  }

  if (next === State.COMPLETED || next === State.CANCELLED) {
    Object.assign(base, { progress: null, ...patch });
  }

  update(base);
}

/* テスト・画面リセット用。購読者は保持したまま値だけ初期化する。 */
export function reset() {
  snapshot = initialSnapshot;
  notify();
}
