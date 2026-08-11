/**
 * 初期セットアップ。
 *
 * シートは実行時に自動生成される（SheetsIO.gs）ため、ここでやるのは
 * トリガーの整備だけ。何度実行しても増殖しないよう、
 * 同じハンドラの既存トリガーを消してから作り直す。
 */

function setupThreadsMvp() {
  /* シートも先に作っておく（初回に画面を開く前でも状態が見えるように）。 */
  ensureSheet_(SHEET.DRAFTS);
  ensureSheet_(SHEET.RESERVATIONS);
  ensureSheet_(SHEET.HISTORY);

  recreateTrigger_('processDueReservations', function (builder) {
    return builder.timeBased().everyMinutes(5).create();
  });

  return { ok: true };
}

function recreateTrigger_(handlerName, create) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  create(ScriptApp.newTrigger(handlerName));
}
