/**
 * ユースケース層: 下書き保存・投稿画面の起動・履歴記録。
 *
 * 投稿は Threads の intent リンク（本文入りの投稿画面を開く）で行い、
 * 最後の「投稿」ボタンは**人が押す**。API・トークンは使わない
 * （要件 threads-mvp-requirements-v1.md v2.0 §2。60日トークン問題と
 * Meta の審査を丸ごと避けるための方式選択）。
 */

/** Threads の本文上限（文字）。 */
var THREADS_TEXT_LIMIT = 500;

/** 本文の検証。空・上限超えはリンクを作る前に日本語で止める。 */
function validatePostText_(text) {
  var value = String(text == null ? '' : text);

  if (!value.trim()) {
    throw new Error('本文が空です');
  }

  if (Array.from(value).length > THREADS_TEXT_LIMIT) {
    throw new Error('本文が ' + THREADS_TEXT_LIMIT + ' 文字を超えています');
  }

  return value;
}

/** 本文入りの投稿画面を開く URL。 */
function intentUrlFor_(text) {
  return 'https://www.threads.net/intent/post?text=' + encodeURIComponent(text);
}

/**
 * 履歴へ1件記録する（要件 §3.7）。
 * intent 方式では「Threads 側で本当に投稿されたか」は観測できないため、
 * 記録するのは「こちらで起きたこと」（画面を開いた・リマインダーを送った）まで。
 */
function recordHistory_(kind, text, ok, errorMessage) {
  appendRowTo_(SHEET.HISTORY, [
    Utilities.getUuid(),
    Date.now(),
    kind,
    String(text == null ? '' : text),
    ok ? '成功' : '失敗',
    errorMessage || ''
  ]);
}

/** 下書きを保存する。 */
function saveDraft(text) {
  var value = String(text == null ? '' : text);

  if (!value.trim()) {
    throw new Error('本文が空です');
  }

  var id = Utilities.getUuid();
  appendRowTo_(SHEET.DRAFTS, [id, value, Date.now()]);
  return { id: id };
}

/**
 * 投稿画面を開くための URL を返し、履歴に記録する。
 * 実際に window.open するのは画面側（ポップアップ扱いを避けるため、
 * クリックと同じイベント内で開く必要がある）。
 */
function buildIntentLink(text) {
  try {
    var value = validatePostText_(text);
    recordHistory_('投稿画面を開いた', value, true, '');
    return { ok: true, url: intentUrlFor_(value) };
  } catch (error) {
    var message = String(error.message || error);
    return { ok: false, error: message };
  }
}
