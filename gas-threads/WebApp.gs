/**
 * 操作画面（1ページ）。実行=自分／アクセス=自分のみ。
 * 画面はここの公開関数（getState / saveDraft / buildIntentLink /
 * reservePost / cancelReservation）だけを google.script.run 経由で呼ぶ。
 */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Threads 投稿 MVP');
}

/** 画面表示に必要な状態をまとめて返す。 */
function getState() {
  return {
    textLimit: THREADS_TEXT_LIMIT,
    drafts: readRowsFrom_(SHEET.DRAFTS).reverse(),
    reservations: readRowsFrom_(SHEET.RESERVATIONS).reverse(),
    history: readRowsFrom_(SHEET.HISTORY).reverse().slice(0, 50)
  };
}
