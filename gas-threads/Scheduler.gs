/**
 * 予約リマインダー。
 *
 * intent 方式では無人投稿はできない（最後の「投稿」は人が押す）ため、
 * 予約は「時間が来たら、本文と投稿リンクを載せたメールを自分に送る」。
 * メールのリンクをタップすると本文入りの投稿画面が開く。
 *
 * 発火は5分間隔のポーリングトリガー1本（processDueReservations）。
 * 予約ごとの個別トリガーは作らない。理由:
 *   - トリガー上限（スクリプトあたり20本）に構造的に当たらない。
 *   - 取り消しが行の状態変更だけで済み、トリガー削除漏れによる
 *     誤送信が起きない。
 *
 * 状態遷移: scheduled → sending → done / failed / canceled
 * 失敗した予約は failed のまま二度と自動実行しない（要件 §3.6）。
 */

var RESERVATION_STATUS = {
  SCHEDULED: 'scheduled',
  SENDING: 'sending',
  DONE: 'done',
  FAILED: 'failed',
  CANCELED: 'canceled'
};

/** リマインダーを予約する。scheduledAtMs はエポックミリ秒。 */
function reservePost(text, scheduledAtMs) {
  var value = validatePostText_(text);
  var at = Number(scheduledAtMs);

  if (!at || isNaN(at)) {
    throw new Error('予定日時が不正です');
  }

  if (at <= Date.now()) {
    throw new Error('予定日時が過去です');
  }

  var id = Utilities.getUuid();

  appendRowTo_(SHEET.RESERVATIONS, [
    id,
    value,
    at,
    RESERVATION_STATUS.SCHEDULED,
    Date.now(),
    '',
    ''
  ]);

  return { id: id };
}

/**
 * 予約の取り消し。scheduled のときだけ取り消せる
 * （sending 以降は送信が始まっている可能性があるため触らない）。
 */
function cancelReservation(id) {
  var rows = readRowsFrom_(SHEET.RESERVATIONS);

  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i].id === id) {
      if (rows[i]['状態'] !== RESERVATION_STATUS.SCHEDULED) {
        return { ok: false, error: '状態が ' + rows[i]['状態'] + ' のため取り消せません' };
      }

      updateRowIn_(SHEET.RESERVATIONS, rows[i].rowNumber, {
        '状態': RESERVATION_STATUS.CANCELED
      });
      return { ok: true };
    }
  }

  return { ok: false, error: '予約が見つかりません' };
}

/**
 * トリガー発火点（5分ごと）。
 *
 * ロックが取れなければ何もせず戻る（前回の実行が続いている＝
 * 同じ予約を二重に処理しかねない状況で、待つ理由がない）。
 */
function processDueReservations() {
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(0)) {
    return;
  }

  try {
    processDueReservationsLocked_();
  } finally {
    lock.releaseLock();
  }
}

function processDueReservationsLocked_() {
  var rows;

  try {
    rows = readRowsFrom_(SHEET.RESERVATIONS);
  } catch (error) {
    /* シート不整合（§3.2 分岐3）。予約行を特定できないため、
       履歴にだけ記録して止まる。修復は人が行う。 */
    recordHistory_('予約リマインダー', '', false, String(error.message || error));
    return;
  }

  var now = Date.now();

  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];

    if (row['状態'] !== RESERVATION_STATUS.SCHEDULED) {
      continue;
    }

    if (Number(row['予定日時']) > now) {
      continue;
    }

    /* 先に sending へ書き換えてから（claim）送信する。
       途中でクラッシュしても scheduled へは戻さない＝二重送信より
       未送信のほうがまし、という判断。 */
    updateRowIn_(SHEET.RESERVATIONS, row.rowNumber, {
      '状態': RESERVATION_STATUS.SENDING
    });
    SpreadsheetApp.flush();

    executeReservation_(row);
  }
}

/** 1件のリマインダーを送り、結果を予約行と履歴の両方へ記録する。 */
function executeReservation_(row) {
  try {
    sendReminderMail_(row['本文']);
    finishReservation_(row, true, '');
  } catch (error) {
    finishReservation_(row, false, String(error.message || error));
  }
}

/**
 * 自分（スクリプトの所有者）へリマインダーを送る。
 * アクセス=自分のみのアプリなので、宛先は固定でよい。
 */
function sendReminderMail_(text) {
  var to = Session.getEffectiveUser().getEmail();

  if (!to) {
    throw new Error('送信先メールアドレスを取得できません');
  }

  MailApp.sendEmail({
    to: to,
    subject: '【Threads 投稿リマインダー】予約した時間になりました',
    htmlBody:
      '<p>下のリンクを開くと、本文が入った Threads の投稿画面が開きます。' +
      '内容を確かめて「投稿」を押してください。</p>' +
      '<p><a href="' + intentUrlFor_(text) + '">Threads で投稿する</a></p>' +
      '<hr><pre style="white-space:pre-wrap">' + escapeHtml_(text) + '</pre>'
  });
}

function escapeHtml_(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function finishReservation_(row, ok, errorMessage) {
  updateRowIn_(SHEET.RESERVATIONS, row.rowNumber, {
    '状態': ok ? RESERVATION_STATUS.DONE : RESERVATION_STATUS.FAILED,
    '実行日時': Date.now(),
    'エラー': errorMessage || ''
  });

  recordHistory_('予約リマインダー', row['本文'], ok, errorMessage);
}
