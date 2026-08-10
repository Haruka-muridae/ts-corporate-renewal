/**
 * スプレッドシートのメニュー。
 *
 * 利用者がこのファイルで触るのはメニューだけにする。
 * エディタで関数を選んで実行させると、選び間違いで tick() を手動実行するなど、
 * 説明のつかない状態になりやすい。
 * 手動同期が要るときは、録音アプリの設定画面から `syncNow` を呼ぶ。
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('録音通知')
    .addItem('セットアップを開く', 'showSetupSidebar')
    .addSeparator()
    .addItem('録音アプリへの引き継ぎリンクを表示', 'showHandoffLink')
    .addToUi();
}

function showSetupSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('SidebarSetup')
    .setTitle('録音通知のセットアップ');

  SpreadsheetApp.getUi().showSidebar(html);
}

/** サイドバーを閉じたあとでも引き継ぎリンクを取り直せるようにする。 */
function showHandoffLink() {
  var ui = SpreadsheetApp.getUi();
  var result = getHandoffLink();

  if (!result.ok) {
    ui.alert(
      '引き継ぎリンク',
      'まだ公開されていません。メニューの「セットアップを開く」から'
      + '［公開する］を実行してください。',
      ui.ButtonSet.OK
    );
    return;
  }

  ui.alert(
    '引き継ぎリンク',
    '次のリンクを開くと、録音アプリへ接続情報が引き継がれます。\n'
    + '**このリンクには接続キーが含まれます。第三者へ渡さないでください。**\n\n'
    + result.link,
    ui.ButtonSet.OK
  );
}
