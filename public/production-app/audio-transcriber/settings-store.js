/*
 * 音声文字起こしアプリの「選択・設定」の永続化。
 *
 * 対象は利用者が選ぶ設定値だけ（文字起こしの方法・言語・
 * タイムスタンプの有無・端末内AIモデル・Geminiモデルの選択）。
 * 次回起動時にそのまま復元する。
 *
 * 廃止した項目: `fileSource`（よく使う入力元）。設定そのものを
 * 要件書 v1.4 で廃止したが、**既存利用者の保存値には残っている**。
 * 読み込み側（script.js の applySavedSettings）は知らないキーを
 * 読み捨てるだけで、キー名を再利用しないこと。
 *
 * ------------------------------------------------------------------
 * ここに絶対に置いてはならないもの
 * ------------------------------------------------------------------
 * Gemini APIキーなどの秘密情報。キーの唯一の置き場所は KeyStore
 * （public/auth/keystore.js）であり、このファイルは触らない
 * （KeyStore の外で localStorage を触らない。keystore-spec-v1.md §2-1）。
 * 音声ファイル本体も対象外（Blob / ファイル名を localStorage へ置かない）。
 * ------------------------------------------------------------------
 *
 * KeyStore と同じ理由（プライベートモード等で使えないことがある）で、
 * 保存できなくても画面を止めない。読めない・書けない・壊れた値が
 * 入っているときは、すべて「何も保存されていない」として扱う。
 */

/* 保存キー。バージョンを持たせ、形を変えるときは番号を上げて別名にする。 */
export const SETTINGS_STORAGE_KEY = 'tsam-audio-transcriber-settings-v1';

function getStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function isSettingsStoreAvailable() {
  return getStorage() !== null;
}

/*
 * 保存済みの設定を読む。
 * 壊れた値（不正なJSON・配列・文字列など）は例外を投げず「保存されていない」
 * として扱う（開発者ツールから書き換えられる場所のため。KeyStore §3-3 と同じ判断）。
 */
export function loadSettings() {
  const storage = getStorage();

  if (!storage) {
    return {};
  }

  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);

    if (typeof raw !== 'string' || raw === '') {
      return {};
    }

    const parsed = JSON.parse(raw);

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

/*
 * 部分更新で保存する。既存の保存内容と統合してから書き込む。
 * 保存できたかどうかを返す（容量超過・保存禁止のときは false）。
 */
export function saveSettings(patch) {
  const storage = getStorage();

  if (!storage) {
    return false;
  }

  try {
    const merged = { ...loadSettings(), ...patch };
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(merged));
    return true;
  } catch {
    return false;
  }
}
