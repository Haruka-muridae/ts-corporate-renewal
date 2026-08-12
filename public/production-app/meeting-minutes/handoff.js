/*
 * audio-transcriber からの引継ぎデータの読取り・検証（純ロジック。DOM非依存）。
 *
 * ==================================================================
 * 信頼できない入力として扱う（要件書 §5-2）
 * ==================================================================
 * sessionStorage の中身は、同一オリジンで動く他のスクリプトや、
 * 利用者自身が開発者ツールで書き換えた値でありうる。
 * 「audio-transcriber が書いたはず」という前提を置かず、次をすべて確認する。
 *   - version のメジャー不一致は拒否する
 *   - transcript が文字列でなければ拒否する
 *   - createdAt + TTL を過ぎていれば無効化する
 *   - 未知の項目は無視する（型が合わなければ既定値へ丸める）
 * ==================================================================
 *
 * storage を引数注入できるようにしてあるのはテスト用（sessionStorage の
 * 実装を持たない Node からも検証できるようにするため。keystore-spec-v1.md
 * の方針と同じ）。
 */

import { HANDOFF_KEY, HANDOFF_TTL_MS, HANDOFF_MAJOR_VERSION, HANDOFF_SOURCE_APP } from './config.js';

/* 引継ぎデータ不正時の文言。§9-2 の表現をそのまま使う。 */
export const HANDOFF_ERROR = '文字起こしを引き継げませんでした。音声文字起こしアプリからもう一度お試しください。';

function getStorage(storage) {
  if (storage) {
    return storage;
  }

  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function isHandoffStorageAvailable(storage = undefined) {
  return getStorage(storage) !== null;
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/*
 * metadata は完全に任意（要件書 §5-2「transcript 以外の項目は任意」）。
 * 型が合わない値は「無かったこと」にする（丸めたり作り直したりしない。
 * auth/session.js の safeNextParams と同じ考え方）。
 */
function normalizeMetadata(raw) {
  const metadata = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  return {
    title: asString(metadata.title),
    recordedAt: asString(metadata.recordedAt),
    durationSeconds: Number.isFinite(metadata.durationSeconds) ? metadata.durationSeconds : null,
    speakers: asStringArray(metadata.speakers),
  };
}

/*
 * 引継ぎデータを検証・正規化する。
 * 不正であれば null を返す（呼び出し側は HANDOFF_ERROR を表示する）。
 *
 * now を注入できるのは期限判定をテストで固定するため。
 */
export function validateHandoffPayload(raw, { now = Date.now() } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  /*
   * version はメジャー番号の一致だけを見る。要件書 §5-2 は「未知のメジャー
   * バージョンは取り込まない」とのみ定めており、マイナー番号の概念は
   * 現状無い（version は整数として扱う）。
   */
  if (raw.version !== HANDOFF_MAJOR_VERSION) {
    return null;
  }

  if (raw.sourceApp !== HANDOFF_SOURCE_APP) {
    return null;
  }

  if (typeof raw.transcript !== 'string') {
    return null;
  }

  const createdAt = typeof raw.createdAt === 'string' ? Date.parse(raw.createdAt) : Number.NaN;

  if (!Number.isFinite(createdAt)) {
    return null;
  }

  if (now - createdAt > HANDOFF_TTL_MS) {
    /* 期限切れ。要件書 §5-3「有効期限を過ぎた引継ぎデータは自動で無効化する」。 */
    return null;
  }

  if (now - createdAt < 0) {
    /* 未来時刻は改ざんの疑いがあるとみなし、素直に信頼しない。 */
    return null;
  }

  return {
    version: HANDOFF_MAJOR_VERSION,
    sourceApp: HANDOFF_SOURCE_APP,
    createdAt: new Date(createdAt).toISOString(),
    transcript: raw.transcript,
    metadata: normalizeMetadata(raw.metadata),
  };
}

/*
 * sessionStorage から引継ぎデータを読み、検証済みの形で返す。
 * 存在しない・壊れている・期限切れのいずれも null（「引継ぎ無し」として扱う。
 * 呼び出し側が個別にエラーを出す必要はない。明示的に取込みを試みて
 * 失敗した場合にだけ HANDOFF_ERROR を出す）。
 */
export function readHandoff({ storage = undefined, now = Date.now() } = {}) {
  const store = getStorage(storage);

  if (!store) {
    return null;
  }

  let raw = null;

  try {
    const text = store.getItem(HANDOFF_KEY);

    if (typeof text !== 'string' || text === '') {
      return null;
    }

    raw = JSON.parse(text);
  } catch {
    return null;
  }

  return validateHandoffPayload(raw, { now });
}

/*
 * sessionStorage に「何か」引継ぎデータが残っているかだけを見る（検証しない）。
 *
 * readHandoff() は「無い」ときも「あるが不正」なときも同じ null を返すため、
 * これだけでは §9-2 の「引継ぎデータ不正」を「引継ぎなし」と区別できない。
 * app.js はこの関数と readHandoff() の両方を見て、
 *   - 何も無い                       → 何も表示しない
 *   - 何かあるが readHandoff() が null → HANDOFF_ERROR を表示し、消去する
 * を判定する。
 */
export function isHandoffDataPresent({ storage = undefined } = {}) {
  const store = getStorage(storage);

  if (!store) {
    return false;
  }

  try {
    const text = store.getItem(HANDOFF_KEY);
    return typeof text === 'string' && text !== '';
  } catch {
    return false;
  }
}

/*
 * 引継ぎデータを消去する。
 * 正常取込み後・取込みキャンセル後のいずれからも呼ばれる（要件書 §5-3）。
 */
export function clearHandoff({ storage = undefined } = {}) {
  const store = getStorage(storage);

  if (!store) {
    return;
  }

  try {
    store.removeItem(HANDOFF_KEY);
  } catch {
    /* 消せなくても、次回読み出し時に期限切れ等で弾かれる可能性が高い。 */
  }
}
