/**
 * スプレッドシートのメニュー。
 *
 * 利用者がこのファイルで触るのはメニューだけにする。
 * エディタで関数を選んで実行させると、選び間違いで tick() を手動実行するなど、
 * 説明のつかない状態になりやすい。
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('録音通知')
    .addItem('セットアップを開始', 'showSetupSidebar')
    .addSeparator()
    .addItem('接続コードを表示', 'showConnectionCode')
    .addItem('jsrsasign を検証', 'showJsrsasignCheck')
    .addToUi();
}

function showSetupSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('SidebarSetup')
    .setTitle('録音通知のセットアップ');

  SpreadsheetApp.getUi().showSidebar(html);
}

/** サイドバーを閉じたあとでも接続コードを見られるようにする。 */
function showConnectionCode() {
  var code = getConnectionCode();
  var ui = SpreadsheetApp.getUi();

  if (code.url === '') {
    ui.alert(
      '接続コード',
      'まだ公開（デプロイ）されていません。'
      + '「デプロイ」→「新しいデプロイ」→種類「ウェブアプリ」で公開してから、もう一度開いてください。',
      ui.ButtonSet.OK
    );
    return;
  }

  ui.alert(
    '接続コード',
    '録音アプリの設定画面へ、次の2つを貼り付けてください。\n\n'
    + 'GAS の URL:\n' + code.url + '\n\n'
    + '接続キー:\n' + code.key + '\n\n'
    + '接続キーは第三者へ渡さないでください。',
    ui.ButtonSet.OK
  );
}

function showJsrsasignCheck() {
  var ui = SpreadsheetApp.getUi();

  try {
    ui.alert('jsrsasign の検証', verifyJsrsasign(), ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('jsrsasign の検証', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}
