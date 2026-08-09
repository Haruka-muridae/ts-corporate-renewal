/*
 * Main.gs — 画面の配信と、google.script.run から呼ばれる入口
 *
 * ==================================================================
 * ここは薄く保つ
 * ==================================================================
 * 処理は Api.gs にある。ここは実シートのポートを作って渡すだけ。
 * 薄いままなら、テストできない層（SpreadsheetApp に触る層）が
 * ここだけに閉じる。
 *
 * ==================================================================
 * デプロイ設定（変えないこと）
 * ==================================================================
 *   次のユーザーとして実行 … 自分
 *   アクセスできるユーザー … 自分のみ
 *
 * 画面ごと GAS 上に置いているので「自分のみ」で成立する。
 * 「全員」にすると、URL を知っている人が誰でも操作できるようになる。
 * ==================================================================
 */

/** 画面を返す。 */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('一想 ISSO')
    /* スマホのホーム画面から使うため、拡大縮小を既定に任せる。 */
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Index.html から Style / Script を差し込むための定石。 */
function include(fileName) {
  return HtmlService.createHtmlOutputFromFile(fileName).getContent();
}

/** 実シートのポート。入口はすべてこれを使う。 */
function IssoMain_store() {
  return IssoSheets_open();
}

/* ------------------------------------------------------------------
 * google.script.run の入口
 * ------------------------------------------------------------------
 * 返す値は素のオブジェクト・配列・文字列・数値・真偽値に限る。
 * 例外はそのまま withFailureHandler へ渡る。
 * ------------------------------------------------------------------ */

function issoBootstrap() {
  return IssoApi_bootstrap(IssoMain_store());
}

function issoCreateTheme(input) {
  return IssoApi_createTheme(IssoMain_store(), input);
}

function issoListThemes(includeArchived) {
  return IssoApi_listThemes(IssoMain_store(), includeArchived);
}

function issoWorkspace(themeId) {
  return IssoApi_workspace(IssoMain_store(), themeId);
}

function issoRequestGeneration(themeId, stage) {
  return IssoApi_requestGeneration(IssoMain_store(), themeId, stage);
}

function issoRefresh(requestId) {
  return IssoApi_refresh(IssoMain_store(), requestId);
}

function issoSubmitResult(requestId, text) {
  return IssoApi_submitResult(IssoMain_store(), requestId, text);
}

function issoAdopt(versionId) {
  return IssoApi_adopt(IssoMain_store(), versionId);
}

function issoEditBody(versionId, body) {
  return IssoApi_editBody(IssoMain_store(), versionId, body);
}

/**
 * 投稿する。**実際に外部へ通信する唯一の入口。**
 *
 * `IssoHttp_fetch()` をここで作って渡す。テストはこの引数を差し替えて、
 * **実キー・実通信なしで失敗時の振る舞いまで確かめている。**
 */
function issoPost(versionId, platform) {
  return IssoApi_post(IssoMain_store(), versionId, platform, { fetch: IssoHttp_fetch() });
}

/**
 * Threads の長期トークンを更新する（手順書 §D-3 の60日）。
 *
 * エディタから手で実行してもよいし、画面の設定からも呼べる。
 */
function issoRefreshThreadsToken() {
  return IssoThreads_refreshToken({ fetch: IssoHttp_fetch() });
}

function issoSaveSettings(values) {
  return IssoApi_saveSettings(IssoMain_store(), values);
}

function issoRemoveTheme(themeId) {
  return IssoApi_removeTheme(IssoMain_store(), themeId);
}

/**
 * エディタから手で実行する初期化。
 *
 * 画面を開けば `issoBootstrap()` が同じことをするが、**権限の承認を
 * 先に済ませたいとき**（初回デプロイ前）にここから実行する。
 */
function issoSetup() {
  var created = IssoSheets_open().ensureSheets();

  return created.length === 0
    ? 'シートはすべてそろっています。'
    : '作成したシート: ' + created.join(', ');
}
