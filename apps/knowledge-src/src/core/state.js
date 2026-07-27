/*
 * アプリ全体の状態機械。
 *
 * 「今どの状態か」をここ以外で推測しない。UIは状態を購読して描画するだけにする。
 * 状態はフラットな1本の列挙で持ち、遷移可能な組み合わせを明示する。
 */

import { logger } from './logger.js';

export const AppState = Object.freeze({
  UNAUTHENTICATED: 'unauthenticated', // 未認証
  AUTHENTICATED: 'authenticated',     // 認証済み
  NO_FOLDER: 'no-folder',             // フォルダ未選択
  SYNC_IDLE: 'sync-idle',             // 同期待機
  SYNCING: 'syncing',                 // 同期中（Driveのメタデータ取得・差分判定）
  PARSING: 'parsing',                 // 解析中（抽出・正規化・チャンク・索引）
  DONE: 'done',                       // 完了
  CANCELLED: 'cancelled',             // キャンセル
  ERROR: 'error',                     // エラー
});

export const STATE_LABEL_JA = Object.freeze({
  [AppState.UNAUTHENTICATED]: '未認証',
  [AppState.AUTHENTICATED]: '認証済み',
  [AppState.NO_FOLDER]: 'フォルダ未選択',
  [AppState.SYNC_IDLE]: '同期待機',
  [AppState.SYNCING]: '同期中',
  [AppState.PARSING]: '解析中',
  [AppState.DONE]: '完了',
  [AppState.CANCELLED]: 'キャンセル',
  [AppState.ERROR]: 'エラー',
});

/*
 * 遷移表。ここに無い遷移は不正として扱い、開発者ログへ残す（画面は壊さない）。
 * ERROR からは再認証・再同期のためにほぼ全方向へ戻れるようにする。
 */
const TRANSITIONS = Object.freeze({
  [AppState.UNAUTHENTICATED]: [AppState.AUTHENTICATED, AppState.ERROR],
  [AppState.AUTHENTICATED]: [AppState.NO_FOLDER, AppState.SYNC_IDLE, AppState.UNAUTHENTICATED, AppState.ERROR],
  [AppState.NO_FOLDER]: [AppState.SYNC_IDLE, AppState.UNAUTHENTICATED, AppState.ERROR],
  [AppState.SYNC_IDLE]: [AppState.SYNCING, AppState.NO_FOLDER, AppState.UNAUTHENTICATED, AppState.ERROR],
  /* SYNC_IDLE へ戻る経路は「一覧取得だけして終わった」場合に使う。 */
  [AppState.SYNCING]: [
    AppState.PARSING, AppState.DONE, AppState.CANCELLED, AppState.ERROR, AppState.SYNC_IDLE,
  ],
  [AppState.PARSING]: [AppState.SYNCING, AppState.DONE, AppState.CANCELLED, AppState.ERROR],
  [AppState.DONE]: [AppState.SYNC_IDLE, AppState.SYNCING, AppState.NO_FOLDER, AppState.UNAUTHENTICATED, AppState.ERROR],
  [AppState.CANCELLED]: [AppState.SYNC_IDLE, AppState.SYNCING, AppState.NO_FOLDER, AppState.UNAUTHENTICATED, AppState.ERROR],
  [AppState.ERROR]: [
    AppState.UNAUTHENTICATED, AppState.AUTHENTICATED, AppState.NO_FOLDER,
    AppState.SYNC_IDLE, AppState.SYNCING, AppState.DONE,
  ],
});

/* ファイル単位の同期状態。AppState とは別軸。 */
export const FileSyncState = Object.freeze({
  PENDING: 'pending',       // 未処理
  FETCHING: 'fetching',     // 取得中
  PARSING: 'parsing',       // 解析中
  INDEXED: 'indexed',       // 索引済み
  SKIPPED: 'skipped',       // 対象外（スプレッドシート等）
  UNCHANGED: 'unchanged',   // 変更なしのため再解析せず
  ERROR: 'error',           // エラー
});

export const FILE_STATE_LABEL_JA = Object.freeze({
  [FileSyncState.PENDING]: '未処理',
  [FileSyncState.FETCHING]: '取得中',
  [FileSyncState.PARSING]: '解析中',
  [FileSyncState.INDEXED]: '索引済み',
  [FileSyncState.SKIPPED]: '対象外',
  [FileSyncState.UNCHANGED]: '変更なし',
  [FileSyncState.ERROR]: 'エラー',
});

/*
 * 最小限の観測可能ストア。
 * フレームワークを使わないため、購読／通知だけを提供する。
 */
export function createStore(initial = {}) {
  let value = {
    appState: AppState.UNAUTHENTICATED,
    /* 表示用プロフィール（未検証。アクセス制御には使わない）。 */
    profile: null,
    folder: null,          // { id, name, path }
    folderResolve: null,   // 固定パス探索の結果（folder-path.js の戻り値）
    folderResolving: false,
    files: [],             // files テーブルのスナップショット
    progress: null,        // { phase, done, total, currentName }
    lastError: null,       // { code, message }
    stats: null,           // ストレージ集計
    ...initial,
  };

  const listeners = new Set();

  const notify = () => {
    listeners.forEach((listener) => {
      try {
        listener(value);
      } catch {
        /* 1つの購読者の例外で他を止めない。 */
      }
    });
  };

  return {
    get() {
      return value;
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(value);
      return () => listeners.delete(listener);
    },

    /* 部分更新。同一参照なら通知しない、といった最適化は行わない（規模が小さいため）。 */
    patch(partial) {
      value = { ...value, ...partial };
      notify();
    },

    /*
     * 状態遷移。
     * 遷移表に無い組み合わせは、適用したうえで開発者ログへ残す。
     * 画面を固まらせないことを優先するため、例外は投げない。
     */
    setAppState(next) {
      const current = value.appState;

      if (current === next) {
        return { ok: true, changed: false };
      }

      const allowed = TRANSITIONS[current] ?? [];
      const ok = allowed.includes(next);

      if (!ok) {
        logger.warn('state:unexpected-transition', { from: current, to: next });
      }

      value = { ...value, appState: next };
      notify();

      return { ok, changed: true, from: current, to: next };
    },
  };
}
