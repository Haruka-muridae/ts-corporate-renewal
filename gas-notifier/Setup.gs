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
    return deployFailure_(listed.error, listed.message, listed.helpUrl);
  }

  var existing = findWebAppDeployment_(listed.body);

  /*
   * ------------------------------------------------------------------
   * 作りかけのバージョンがあれば使い回す
   * ------------------------------------------------------------------
   * バージョンの作成に成功したあとでデプロイ側が失敗すると、
   * **使われないバージョンだけが残る。** ウィザードは API の許可待ちで
   * 5秒ごとにこの関数を呼ぶため、そのまま作り直していると、
   * 失敗が続くあいだバージョンが増え続ける。
   *
   * 成功するまでは同じ番号を使い回す。デプロイが通った時点で記録を消す。
   * 再試行の間にコードが変わることはない（利用者はエディタを開かない）ので、
   * 使い回して困る場面が無い。
   * ------------------------------------------------------------------
   */
  var versionNumber = Number(getProperty_(PROP.PENDING_VERSION));

  if (!isFinite(versionNumber) || versionNumber <= 0) {
    var version = scriptApiFetch_('post', 'projects/' + scriptId + '/versions', {
      description: DEPLOYMENT_DESCRIPTION
    });

    if (!version.ok) {
      return deployFailure_(version.error, version.message, version.helpUrl);
    }

    versionNumber = version.body && version.body.versionNumber;

    if (!versionNumber) {
      return deployFailure_('NO_VERSION', 'バージョンを作成できませんでした。');
    }

    /* デプロイへ進む前に控える。ここで落ちても次回は作り直さない。 */
    setProperty_(PROP.PENDING_VERSION, String(versionNumber));
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
    return deployFailure_(applied.error, applied.message, applied.helpUrl);
  }

  var url = normalizeExecUrl_(webAppUrlFromDeployment_(applied.body));

  if (url === '') {
    return deployFailure_('NO_URL', '公開URLを取得できませんでした。');
  }

  setProperty_(PROP.WEBAPP_URL, url);
  /* 使い切ったので控えを消す。次回は新しいバージョンを作る。 */
  setProperty_(PROP.PENDING_VERSION, '');
  setProperty_(PROP.DEPLOYED_VERSION, String(versionNumber));

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

  if (status >= 200 && status < 300) {
    return { ok: true, error: '', message: '', helpUrl: '', body: body };
  }

  /*
   * ==================================================================
   * ★一時デバッグ★ 生の応答を実行ログへ出す
   * ==================================================================
   * **原因が確定したら、このブロックごと削除する**（docs/backlog.md B-07）。
   *
   * 403 には少なくとも2種類あり、応答本文を捨てていたために区別できなかった。
   *
   *   1. 利用者の設定（script.google.com/home/usersettings）が OFF
   *   2. スクリプトに紐づく **GCP プロジェクト**で Apps Script API が未有効
   *
   * 2 の場合、本文にプロジェクト番号と有効化URLが入る。それを見れば確定する。
   *
   * **Authorization ヘッダーは出さない。** 出すのは応答の本文と状態だけで、
   * ここにアクセストークンは含まれない。
   * ==================================================================
   */
  Logger.log(
    '[一時デバッグ] scriptApiFetch_ ' + method + ' ' + path
    + ' -> HTTP ' + status + '\n' + String(response.getContentText() || '').slice(0, 4000)
  );

  var detail = (body && body.error && body.error.message) ? String(body.error.message) : '';
  var reason = scriptApiReason_(body);

  if (status === 403) {
    /*
     * **どちらの 403 かを分ける。** 直す場所がまったく違う。
     * 判定は Google の文面に含まれる案内URLで行い、
     * 見分けがつかないときは利用者設定側（頻度が高い）へ倒す。
     */
    if (reason === 'SERVICE_DISABLED' || detail.indexOf('console.developers.google.com') !== -1
      || detail.indexOf('console.cloud.google.com') !== -1) {
      return {
        ok: false,
        error: 'API_DISABLED_GCP',
        message: 'このスクリプトに紐づく Google Cloud プロジェクトで Apps Script API が有効になっていません。',
        helpUrl: firstHttpsUrl_(detail),
        body: body
      };
    }

    return {
      ok: false,
      error: 'API_DISABLED',
      message: 'Apps Script API が許可されていません。',
      helpUrl: firstHttpsUrl_(detail) || 'https://script.google.com/home/usersettings',
      body: body
    };
  }

  return {
    ok: false,
    error: 'API_ERROR',
    message: (detail || ('HTTP ' + status)).slice(0, 200),
    helpUrl: '',
    body: body
  };
}

/** エラー応答の details に入る reason（SERVICE_DISABLED など）。無ければ ''。 */
function scriptApiReason_(body) {
  var details = (body && body.error && body.error.details) || [];

  for (var i = 0; i < details.length; i++) {
    var reason = details[i] && details[i].reason;

    if (reason) {
      return String(reason);
    }
  }

  return String((body && body.error && body.error.status) || '');
}

/**
 * 文面の中の最初の https URL。
 * Google のエラーは「ここを開いて有効化せよ」というURLを本文へ入れてくる。
 * それをそのままボタンにすれば、利用者が探さずに済む。
 */
function firstHttpsUrl_(text) {
  var match = String(text || '').match(/https:\/\/[^\s"'<>)]+/);

  return match ? match[0].replace(/[.,]$/, '') : '';
}

function deployFailure_(error, message, helpUrl) {
  Logger.log('deployWebApp failed: ' + error + (message ? ' / ' + message : ''));

  return {
    ok: false,
    url: '',
    created: false,
    status: error,
    message: message,
    helpUrl: helpUrl || ''
  };
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
    /* **公開したという事実は deployWebApp() だけが知っている**（webAppUrl_ の説明）。 */
    deployed: webAppUrl_() !== '',
    deployedVersion: getProperty_(PROP.DEPLOYED_VERSION),
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
 * 公開URL。**deployWebApp() が保存した値だけを見る（fail closed）。**
 *
 * ------------------------------------------------------------------
 * getService().getUrl() を使わない
 * ------------------------------------------------------------------
 * 実機で次の壊れ方をした（2026-08-11）。
 *
 *   - **一度も公開していないのに URL が返る。** その結果
 *     getSetupStatus().deployed が true になり、ウィザードが公開の手順を
 *     飛ばして「録音アプリで仕上げ」へ直行した
 *   - 返る URL が実際に公開したデプロイと**別のID**だった。引き継ぎリンクに
 *     それが載り、録音アプリは使えないデプロイへ繋ぎに行った
 *
 * getUrl() は「このスクリプトのウェブアプリ入口」を返すもので、
 * **いま公開されているデプロイを指すとは限らない。**
 * 公開したという事実は deployWebApp() だけが知っているので、そこが
 * 保存した値のみを正とする。無ければ空（＝未公開）とする。
 * ------------------------------------------------------------------
 */
function webAppUrl_() {
  return getProperty_(PROP.WEBAPP_URL);
}

/**
 * ウェブアプリURLを正規化する。
 *
 * Google Workspace のアカウントでは、デプロイURLが
 * `https://script.google.com/a/macros/<ドメイン>/s/<ID>/exec` の形で返る。
 * この形は**そのドメインでのログインを求められることがある**ため、匿名で叩く
 * Service Worker からは使えない場合がある。同じデプロイは
 * `/macros/s/<ID>/exec` でも開けるので、そちらへ寄せる。
 *
 * 読めない形は空文字を返す（呼び出し側が未公開として扱う）。
 */
function normalizeExecUrl_(url) {
  var text = String(url === undefined || url === null ? '' : url).trim();

  if (text === '') {
    return '';
  }

  /* ドメイン付きの形。<ID> だけ取り出して素の形へ組み直す。 */
  var domainForm = text.match(/^https:\/\/script\.google\.com\/a\/macros\/[^\/]+\/s\/([\w-]+)\/exec/);

  if (domainForm) {
    return 'https://script.google.com/macros/s/' + domainForm[1] + '/exec';
  }

  var plainForm = text.match(/^https:\/\/script\.google\.com\/macros\/s\/([\w-]+)\/exec/);

  if (plainForm) {
    return 'https://script.google.com/macros/s/' + plainForm[1] + '/exec';
  }

  return '';
}

/**
 * 保存済みの公開URLの指紋（SHA-256 の先頭12文字）。
 *
 * 録音アプリが「いま自分が叩いているURL」から同じ値を計算して突き合わせる。
 * **一致しなければ、古いデプロイに繋いでいる。** 実機ではこれが分からず、
 * URLが3種類に食い違っていることの発見が遅れた。
 * URL そのものを返さないのは、health が接続キー無しで読めるためである。
 */
function execUrlDigest_() {
  var url = webAppUrl_();

  if (url === '') {
    return '';
  }

  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, url, Utilities.Charset.UTF_8);
  var hex = '';

  for (var i = 0; i < bytes.length && hex.length < 12; i++) {
    var value = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += (value < 16 ? '0' : '') + value.toString(16);
  }

  return hex.slice(0, 12);
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
