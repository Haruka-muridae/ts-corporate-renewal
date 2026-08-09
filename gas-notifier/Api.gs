/**
 * Web アプリの入口（録音アプリ・Service Worker との通信窓口）。
 *
 * ------------------------------------------------------------------
 * 方針（gas-auth/Main.gs と同じ形にそろえてある）
 * ------------------------------------------------------------------
 *   - action はホワイトリスト方式。tick() や setupNotifier() などの
 *     管理関数はここから呼べない。
 *   - POST の本文は text/plain の JSON。プリフライトを避けるためで、
 *     フロント（notifier-client.js）の実装と対になっている。
 *   - 例外は握りつぶさず、内部情報を含まない定型メッセージだけを返す。
 * ------------------------------------------------------------------
 *
 * 応答は常に JSON。
 *   成功: { ok: true,  data: {...} }
 *   失敗: { ok: false, error: { code, message } }
 *
 * ------------------------------------------------------------------
 * health 以外は接続キーが要る
 * ------------------------------------------------------------------
 * Web アプリのURLは「リンクを知っている全員」に開かれている
 * （Service Worker から匿名で叩くため、この設定でなければ動かない）。
 * URLだけで予定名が読めてしまわないよう、health 以外の全 action で
 * 接続キーを検証する。health を素通しにしているのは、
 * 「URLが正しいか」と「接続キーが正しいか」を利用者が切り分けられるようにするため。
 * ------------------------------------------------------------------
 */

var ALLOWED_GET_ACTIONS = ['health', 'publicKey', 'getSettings', 'pending', 'event'];
var ALLOWED_POST_ACTIONS = ['saveSettings', 'saveSubscription'];

/* pending が拾う範囲。これより古い通知は「もう出す意味がない」として捨てる。 */
var PENDING_WINDOW_MS = 10 * 60 * 1000;

var API_ERRORS = {
  INVALID_ACTION: ['INVALID_ACTION', 'サポートされていない操作です。'],
  INVALID_REQUEST: ['INVALID_REQUEST', 'リクエストの形式が不正です。'],
  UNAUTHORIZED: ['UNAUTHORIZED', '接続キーが正しくありません。'],
  NOT_CONFIGURED: ['NOT_CONFIGURED', 'セットアップが完了していません。'],
  NOT_FOUND: ['NOT_FOUND', '対象の予定が見つかりません。'],
  SERVER_ERROR: ['SERVER_ERROR', 'サーバーでエラーが発生しました。時間をおいてお試しください。']
};

function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function apiOk_(data) {
  return jsonOutput_({ ok: true, data: data || {} });
}

function apiFail_(pair) {
  return jsonOutput_({ ok: false, error: { code: pair[0], message: pair[1] } });
}

/**
 * 接続キーの照合。
 *
 * 先頭から順に比較して途中で抜けると、応答時間から正解の文字数が推測できる。
 * 長さを見たあと全文字を XOR で畳み込み、比較時間を入力に依存させない。
 */
function connectKeyMatches_(candidate) {
  var expected = getProperty_(PROP.CONNECT_KEY);

  if (expected === '') {
    return false;
  }

  var given = String(candidate === undefined || candidate === null ? '' : candidate);

  if (given.length !== expected.length) {
    return false;
  }

  var diff = 0;

  for (var i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }

  return diff === 0;
}

function doGet(e) {
  try {
    var params = (e && e.parameter) ? e.parameter : {};
    var action = String(params.action || '').trim();

    if (ALLOWED_GET_ACTIONS.indexOf(action) === -1) {
      return apiFail_(API_ERRORS.INVALID_ACTION);
    }

    if (action === 'health') {
      return apiOk_(buildHealth_());
    }

    if (!connectKeyMatches_(params.key)) {
      return apiFail_(API_ERRORS.UNAUTHORIZED);
    }

    if (action === 'publicKey') {
      var publicKey = getProperty_(PROP.VAPID_PUBLIC);

      if (publicKey === '') {
        return apiFail_(API_ERRORS.NOT_CONFIGURED);
      }

      return apiOk_({ publicKey: publicKey });
    }

    if (action === 'getSettings') {
      return apiOk_({ settings: readSettings_() });
    }

    if (action === 'pending') {
      return apiOk_({ notifications: takePending_(Date.now()) });
    }

    if (action === 'event') {
      var found = findEventSummary_(params.id);

      if (!found) {
        return apiFail_(API_ERRORS.NOT_FOUND);
      }

      return apiOk_({ event: found });
    }

    return apiFail_(API_ERRORS.INVALID_ACTION);
  } catch (err) {
    return handleUnexpected_('doGet', err);
  }
}

function doPost(e) {
  try {
    var body = parsePostBody_(e);

    if (!body) {
      return apiFail_(API_ERRORS.INVALID_REQUEST);
    }

    var action = String(body.action || '').trim();

    if (ALLOWED_POST_ACTIONS.indexOf(action) === -1) {
      return apiFail_(API_ERRORS.INVALID_ACTION);
    }

    if (!connectKeyMatches_(body.key)) {
      return apiFail_(API_ERRORS.UNAUTHORIZED);
    }

    if (action === 'saveSettings') {
      /* 金額と同じ考え方で、画面から来た値はそのまま信じず正規化して書く。 */
      return apiOk_({ settings: writeSettings_(body.settings) });
    }

    if (action === 'saveSubscription') {
      var result = upsertSubscription_(body.subscription, Date.now());
      return apiOk_({ saved: true, created: result.created });
    }

    return apiFail_(API_ERRORS.INVALID_ACTION);
  } catch (err) {
    return handleUnexpected_('doPost', err);
  }
}

/** POST本文（text/plain の JSON文字列）を安全に解析する。 */
function parsePostBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return null;
  }

  /* 想定外に大きい本文は読まない。 */
  if (e.postData.contents.length > 100000) {
    return null;
  }

  try {
    var parsed = JSON.parse(e.postData.contents);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch (err) {
    return null;
  }
}

/**
 * セットアップ状態チェッカーが読む健康状態（接続キー不要）。
 *
 * **予定の内容は一切含めない。** ここは接続キー無しで読めるため、
 * 含めるとURLを知っているだけで予定が漏れる。
 */
function buildHealth_() {
  return {
    ok: true,
    version: NOTIFIER_VERSION,
    lastTickAt: toIsoOrEmpty_(getProperty_(PROP.LAST_TICK_AT)),
    triggerActive: hasTickTrigger_(),
    configured: getProperty_(PROP.VAPID_PUBLIC) !== '' && getProperty_(PROP.CONNECT_KEY) !== ''
  };
}

/**
 * 未取得の通知を取り出し、取得済みにする（FR-15/16）。
 *
 * 取得済みの印をここで付けるのは、同じ通知が push のたびに何度も
 * 表示されるのを防ぐため。取り出しと印付けを分けると、その間に
 * 別の push が入って二重表示になる。
 */
function takePending_(nowMs) {
  var rows = tableRead_(SHEET.SENT_LOG);
  var out = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];

    if (String(row.fetchedAt || '') !== '') {
      continue;
    }

    var sentAt = toMs_(row.sentAt);

    if (!isFinite(sentAt) || sentAt < nowMs - PENDING_WINDOW_MS) {
      continue;
    }

    out.push({
      eventId: String(row.eventId),
      title: String(row.title),
      startTime: toIsoOrEmpty_(row.startTime),
      timing: Number(row.timing)
    });

    tableUpdate_(SHEET.SENT_LOG, row.__row, {
      key: row.key,
      eventId: row.eventId,
      timing: row.timing,
      title: row.title,
      startTime: row.startTime,
      sentAt: row.sentAt,
      purpose: row.purpose,
      fetchedAt: nowMs
    });
  }

  return out;
}

/**
 * 通知から開いた画面が「どの予定か」を出すための1件取得（要件書 5.3）。
 * notify_queue を先に見て、無ければ sent_log を見る
 * （通知の直後は queue にまだ残っているが、開始時刻を過ぎると消える）。
 */
function findEventSummary_(eventId) {
  var id = String(eventId === undefined || eventId === null ? '' : eventId).trim();

  if (id === '') {
    return null;
  }

  var sources = [SHEET.QUEUE, SHEET.SENT_LOG];

  for (var s = 0; s < sources.length; s++) {
    var rows = tableRead_(sources[s]);

    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].eventId) === id) {
        return {
          eventId: id,
          title: String(rows[i].title),
          startTime: toIsoOrEmpty_(rows[i].startTime)
        };
      }
    }
  }

  return null;
}

/**
 * 想定外の例外。内部情報（スタックトレース・シートの内容）は返さない。
 */
function handleUnexpected_(scope, err) {
  var message = (err && err.message) ? String(err.message) : String(err);

  Logger.log(scope + ' error: ' + message);

  return apiFail_(API_ERRORS.SERVER_ERROR);
}
