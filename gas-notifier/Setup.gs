/**
 * セットアップと、ウェブアプリの公開。
 *
 * V2 では利用者が Apps Script のエディタを開く工程が無い。
 * サイドバー（SidebarSetup.html）から次の2つを押すだけで完了する。
 *
 *   [セットアップを実行] … setupNotifier()
 *   [公開する]           … deployWebApp()
 *
 * どちらも**何度実行しても同じ結果になる**（優等）。鍵と接続キーは既にあれば
 * 作り直さない。作り直すと録音アプリ側の設定が黙って無効になるため。
 */

/** サイドバーの②が呼ぶ。戻り値はそのまま画面へ出す。 */
function setupNotifier() {
  ensureSheets_();
  writeSettings_({});
  ensureEidHmacKey_();
  ensureConnectKey_();
  ensureTickTrigger_();

  return getSetupStatus();
}

function ensureSheets_() {
  for (var i = 0; i < SHEET_ORDER.length; i++) {
    ensureSheet_(SHEET_ORDER[i]);
  }
}

/**
 * 予定IDのハッシュ化に使う鍵を用意する。
 *
 * **この鍵は端末（このスプレッドシート）の外へ出ない。** 運営が受け取るのは
 * これで HMAC した値だけで、元の予定IDへは戻せない（design-notes §3）。
 * 作り直すと、送信済みの記録と突き合わなくなって同じ通知が再送されるため、
 * 既にあれば触らない。
 */
function ensureEidHmacKey_() {
  if (getProperty_(PROP.EID_HMAC_KEY) !== '') {
    return false;
  }

  setProperty_(PROP.EID_HMAC_KEY, randomBase64Url_(32));
  return true;
}

/**
 * 接続キーを用意する。
 * Web アプリのURLは第三者にも推測されうるため、health 以外の全 API で検証する。
 */
function ensureConnectKey_() {
  if (getProperty_(PROP.CONNECT_KEY) !== '') {
    return false;
  }

  setProperty_(PROP.CONNECT_KEY, randomBase64Url_(32));
  return true;
}

/** 接続キーを作り直す。**録音アプリ側の設定は無効になる。** */
function resetConnectKey_() {
  var fresh = randomBase64Url_(32);

  setProperty_(PROP.CONNECT_KEY, fresh);

  return fresh;
}

/**
 * tick() の毎分トリガーを作る。
 * 同名の既存トリガーを消してから作るので、実行するたびに増えることはない。
 */
function ensureTickTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();

  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'tick') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('tick').timeBased().everyMinutes(1).create();

  return true;
}

function hasTickTrigger_() {
  try {
    var triggers = ScriptApp.getProjectTriggers();

    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'tick') {
        return true;
      }
    }
  } catch (err) {
    /* 権限が無い状態（初回の承認前）では読めない。未作成として扱う。 */
  }

  return false;
}

/* ---------- ワンボタン公開 ---------- */

var SCRIPT_API_BASE = 'https://script.googleapis.com/v1/';

/** 作るデプロイの説明文。既存デプロイを見分ける手掛かりにもする。 */
var DEPLOYMENT_DESCRIPTION = 'TSAM AI 録音通知（自動公開）';

/**
 * ウェブアプリとして公開する（ウィザードの [公開する] が呼ぶ）。
 *
 * ------------------------------------------------------------------
 * 冪等にする（同じURLを保つ）
 * ------------------------------------------------------------------
 * 既存のウェブアプリ用デプロイがあれば、**新しいバージョンを作って
 * そのデプロイを update する。** create し直すと `/exec` URL が変わり、
 * 録音アプリ側の設定が黙って無効になる。
 *
 * `@HEAD` のデプロイ（versionNumber を持たない）は update できないため、
 * 探索から外す。
 * ------------------------------------------------------------------
 *
 * **アクセストークンをクライアントへ渡さない。** 呼ぶのはこのサーバー側関数だけで、
 * サイドバーへ返すのは公開URLと状態のみ。
 *
 * 戻り値は { ok, url, created, status, message }。
 * 失敗しても例外にはせず、ウィザードが次の手を案内できる形で返す。
 */
function deployWebApp() {
  var scriptId;

  try {
    scriptId = ScriptApp.getScriptId();
  } catch (err) {
    return deployFailure_('SCRIPT_ID', 'スクリプトIDを取得できませんでした。');
  }

  var listed = scriptApiFetch_('get', 'projects/' + scriptId + '/deployments', null);

  if (!listed.ok) {
    return deployFailure_(listed.error, listed.message);
  }

  var existing = findWebAppDeployment_(listed.body);

  var version = scriptApiFetch_('post', 'projects/' + scriptId + '/versions', {
    description: DEPLOYMENT_DESCRIPTION
  });

  if (!version.ok) {
    return deployFailure_(version.error, version.message);
  }

  var versionNumber = version.body && version.body.versionNumber;

  if (!versionNumber) {
    return deployFailure_('NO_VERSION', 'バージョンを作成できませんでした。');
  }

  var config = {
    scriptId: scriptId,
    versionNumber: versionNumber,
    manifestFileName: 'appsscript',
    description: DEPLOYMENT_DESCRIPTION
  };

  var applied;

  if (existing) {
    applied = scriptApiFetch_(
      'put',
      'projects/' + scriptId + '/deployments/' + existing.deploymentId,
      { deploymentConfig: config }
    );
  } else {
    applied = scriptApiFetch_('post', 'projects/' + scriptId + '/deployments', config);
  }

  if (!applied.ok) {
    return deployFailure_(applied.error, applied.message);
  }

  var url = webAppUrlFromDeployment_(applied.body);

  if (url === '') {
    return deployFailure_('NO_URL', '公開URLを取得できませんでした。');
  }

  setProperty_(PROP.WEBAPP_URL, url);

  return {
    ok: true,
    url: url,
    created: !existing,
    status: 'DEPLOYED',
    message: existing ? '公開を更新しました（URLは変わりません）。' : '公開しました。'
  };
}

/** ウェブアプリの入口を持つデプロイを探す。@HEAD は除く。 */
function findWebAppDeployment_(body) {
  var deployments = (body && body.deployments) || [];

  for (var i = 0; i < deployments.length; i++) {
    var deployment = deployments[i] || {};
    var config = deployment.deploymentConfig || {};

    /* @HEAD は versionNumber を持たず、update もできない。 */
    if (!config.versionNumber) {
      continue;
    }

    if (webAppUrlFromDeployment_(deployment) !== '') {
      return { deploymentId: String(deployment.deploymentId || '') };
    }
  }

  return null;
}

function webAppUrlFromDeployment_(deployment) {
  var entryPoints = (deployment && deployment.entryPoints) || [];

  for (var i = 0; i < entryPoints.length; i++) {
    var entry = entryPoints[i] || {};

    if (entry.webApp && entry.webApp.url) {
      return String(entry.webApp.url);
    }
  }

  return '';
}

/**
 * Apps Script API を叩く。
 *
 * 403 は「Apps Script API が未許可」であることがほとんどで、
 * ウィザードはこれを見て設定ページへ誘導する。
 */
function scriptApiFetch_(method, path, payload) {
  var options = {
    method: method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  };

  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  var response;

  try {
    response = UrlFetchApp.fetch(SCRIPT_API_BASE + path, options);
  } catch (err) {
    return { ok: false, error: 'NETWORK', message: '通信に失敗しました。', body: null };
  }

  var status = response.getResponseCode();
  var body = null;

  try {
    body = JSON.parse(response.getContentText());
  } catch (err) {
    body = null;
  }

  if (status === 403) {
    return { ok: false, error: 'API_DISABLED', message: 'Apps Script API が許可されていません。', body: body };
  }

  if (status < 200 || status >= 300) {
    var detail = (body && body.error && body.error.message) ? String(body.error.message) : ('HTTP ' + status);
    return { ok: false, error: 'API_ERROR', message: detail.slice(0, 200), body: body };
  }

  return { ok: true, error: '', message: '', body: body };
}

function deployFailure_(error, message) {
  Logger.log('deployWebApp failed: ' + error);

  return { ok: false, url: '', created: false, status: error, message: message };
}

/* ---------- サイドバーが読む状態 ---------- */

/**
 * セットアップの進み具合。サイドバーはこれを見て状態を切り替える。
 * **接続キーとライセンスキーそのものはここに入れない。**
 */
function getSetupStatus() {
  var book = null;

  try {
    book = getBook_();
  } catch (err) {
    book = null;
  }

  var sheetsReady = book !== null;

  if (book) {
    for (var i = 0; i < SHEET_ORDER.length; i++) {
      if (!book.getSheetByName(SHEET_ORDER[i])) {
        sheetsReady = false;
      }
    }
  }

  return {
    sheets: sheetsReady,
    eidKey: getProperty_(PROP.EID_HMAC_KEY) !== '',
    connectKey: getProperty_(PROP.CONNECT_KEY) !== '',
    trigger: hasTickTrigger_(),
    deployed: webAppUrl_() !== '',
    license: getProperty_(PROP.LICENSE_KEY) !== '',
    version: NOTIFIER_VERSION
  };
}

/**
 * 録音アプリへ渡す引き継ぎリンク。
 *
 * URL のフラグメント（`#`）に載せるのは、**サーバーへ送信されない**ため。
 * 受け取った録音アプリは、保存した直後に history.replaceState で消す。
 * ライセンスキーはここに載せない（逆向きに録音アプリから届く。design-notes §8）。
 */
function getHandoffLink() {
  var url = webAppUrl_();

  if (url === '') {
    return { ok: false, link: '', reason: 'NOT_DEPLOYED' };
  }

  var payload = JSON.stringify({
    execUrl: url,
    connectKey: getProperty_(PROP.CONNECT_KEY),
    version: NOTIFIER_VERSION
  });

  var encoded = stripBase64Padding_(
    Utilities.base64EncodeWebSafe(Utilities.newBlob(payload).getBytes())
  );

  return { ok: true, link: RECORDER_APP_URL + '#setup=' + encoded, reason: '' };
}

/**
 * 公開URL。deployWebApp() が保存した値を先に見る。
 * getService().getUrl() は、公開直後だと空を返すことがある。
 */
function webAppUrl_() {
  var saved = getProperty_(PROP.WEBAPP_URL);

  if (saved !== '') {
    return saved;
  }

  try {
    var url = ScriptApp.getService().getUrl();
    return url ? String(url) : '';
  } catch (err) {
    return '';
  }
}

/* ---------- バイト列の変換 ---------- */

/**
 * ランダムな base64url 文字列。
 *
 * Apps Script には暗号用の乱数が無い。getUuid() は v4 UUID（122ビットの
 * ランダム）なので、必要バイト数ぶんつなげて使う。Math.random() は使わない。
 */
function randomBase64Url_(byteLength) {
  var bytes = [];

  while (bytes.length < byteLength) {
    var hex = Utilities.getUuid().replace(/-/g, '');

    for (var i = 0; i + 1 < hex.length && bytes.length < byteLength; i += 2) {
      var value = parseInt(hex.substr(i, 2), 16);
      /* Apps Script のバイト配列は符号付き（-128..127）。 */
      bytes.push(value > 127 ? value - 256 : value);
    }
  }

  return stripBase64Padding_(Utilities.base64EncodeWebSafe(bytes));
}

/** base64url の '=' を落とす。 */
function stripBase64Padding_(text) {
  return String(text).replace(/=+$/, '');
}
