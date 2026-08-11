/**
 * Web アプリの入口（録音アプリ・Service Worker との通信窓口）。
 *
 * 方針（gas-auth/Main.gs と同じ形）:
 *   - action はホワイトリスト方式。tick() や deployWebApp() は呼べない
 *   - POST の本文は text/plain の JSON（プリフライトを避けるため）
 *   - 例外は握りつぶさず、内部情報を含まない定型メッセージだけを返す
 *
 * health 以外は接続キーが要る。Web アプリのURLは匿名アクセス可（Service Worker
 * から叩くため）なので、URLだけで予定名が読めないようにしている。
 * 理由は docs/notifier-design-notes.md §7。
 */

var ALLOWED_GET_ACTIONS = ['health', 'publicKey', 'getSettings', 'pending', 'event', 'upcoming'];
var ALLOWED_POST_ACTIONS = [
  'ping',
  'saveSettings',
  'saveSubscription',
  'saveLicense',
  'syncNow',
  'sendTestNotification',
  'regenerateConnectKey'
];

/* pending が拾う範囲。これより古い通知は「もう出す意味がない」として捨てる。 */
var PENDING_WINDOW_MS = 10 * 60 * 1000;

/* upcoming が返す件数の上限。設定画面に並べるぶんだけあればよい。 */
var UPCOMING_LIMIT = 5;

var API_ERRORS = {
  INVALID_ACTION: ['INVALID_ACTION', 'サポートされていない操作です。'],
  INVALID_REQUEST: ['INVALID_REQUEST', 'リクエストの形式が不正です。'],
  UNAUTHORIZED: ['UNAUTHORIZED', '接続キーが正しくありません。'],
  NOT_CONFIGURED: ['NOT_CONFIGURED', 'セットアップが完了していません。'],
  NOT_FOUND: ['NOT_FOUND', '対象の予定が見つかりません。'],
  NO_LICENSE: ['NO_LICENSE', 'ご契約が確認できないため、通知を停止しています。'],
  GATE_ERROR: ['GATE_ERROR', '通知サーバーへ接続できませんでした。時間をおいてお試しください。'],
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
 * 接続キーの照合。長さを見たあと全文字を XOR で畳み込み、
 * 比較時間を入力に依存させない。
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
        /*
         * まだゲートから受け取っていない。購読の登録に必要なので、
         * ここで取りに行く（以後は tick が更新する）。
         *
         * 以前はここで gateVapid_([], ...) も呼んでいたが、宛先が空だと
         * 保存済みの値を返すだけで**必ず空になる**。読む人を惑わせるので外した。
         */
        publicKey = primeVapid_(Date.now()).publicKey || '';
      }

      if (publicKey === '') {
        /*
         * **「セットアップが未完了」と「ライセンスがまだ届いていない」を分ける。**
         * 実機では、鍵が取れない原因がライセンス未着信であることが読み取れず、
         * 「セットアップをやり直す」という誤った方向へ切り分けが進んだ。
         * ライセンスさえ届けば解ける状態なら、そう言う。
         */
        return apiFail_(
          getProperty_(PROP.LICENSE_KEY) === '' ? API_ERRORS.NO_LICENSE : API_ERRORS.NOT_CONFIGURED
        );
      }

      return apiOk_({ publicKey: publicKey });
    }

    if (action === 'getSettings') {
      return apiOk_({ settings: readSettings_(), license: licenseSummary_() });
    }

    if (action === 'pending') {
      /*
       * **どの端末が取りに来たかを受け取る（宿題 B-04 の解決）。**
       * endpoint を渡さない要求は受け付けない。受け付けると、
       * 「最初に来た端末が全部さらう」という V1 の不具合に戻る。
       */
      var subscription = findSubscriptionByEndpoint_(params.endpoint);

      if (!subscription) {
        return apiFail_(API_ERRORS.INVALID_REQUEST);
      }

      return apiOk_({ notifications: takePending_(String(subscription.subId), Date.now()) });
    }

    if (action === 'event') {
      var found = findEventSummary_(params.id);

      if (!found) {
        return apiFail_(API_ERRORS.NOT_FOUND);
      }

      return apiOk_({ event: found });
    }

    if (action === 'upcoming') {
      return apiOk_({ upcoming: listUpcoming_(Date.now()) });
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

    if (action === 'ping') {
      /*
       * POST の疎通確認。**副作用は持たない。**
       *
       * GET だけ通って POST が通らない状態が実際に起きた（古いデプロイに
       * 繋がっていて、新しい action が INVALID_ACTION になる）。GET 系の
       * 成功だけを見ていると気づけないため、接続テストはここも叩く。
       *
       * この action の存在自体が「新しいスナップショットか」の判定にもなる
       * （古いデプロイなら INVALID_ACTION が返る）。
       */
      return apiOk_(buildIdentity_());
    }

    if (action === 'saveSettings') {
      /* 画面から来た値はそのまま信じず正規化して書く。 */
      return apiOk_({ settings: writeSettings_(body.settings) });
    }

    if (action === 'saveSubscription') {
      var result = upsertSubscription_(body.subscription, Date.now());
      return apiOk_({ saved: true, created: result.created, subId: result.subId });
    }

    if (action === 'saveLicense') {
      return handleSaveLicense_(body.licenseKey);
    }

    if (action === 'syncNow') {
      return handleSyncNow_();
    }

    if (action === 'sendTestNotification') {
      var test = sendTestNotification_(Date.now());

      if (!test.ok) {
        return apiFail_(test.error === 'NO_LICENSE' ? API_ERRORS.NO_LICENSE : API_ERRORS.GATE_ERROR);
      }

      return apiOk_({ sent: true, delivered: test.delivered });
    }

    if (action === 'regenerateConnectKey') {
      /*
       * 誤って接続コードを共有してしまったときの失効手段。
       * **現在のキーを知っている相手だけが呼べる**（上で検証済み）。
       * 呼んだ時点で、他の端末に入っている古いキーは使えなくなる。
       */
      var fresh = resetConnectKey_();
      return apiOk_({ url: webAppUrl_(), key: fresh });
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
 * ライセンスキーを受け取って保存する。
 *
 * ------------------------------------------------------------------
 * 引き継ぎの向き
 * ------------------------------------------------------------------
 * ライセンスキーは録音アプリ（＝ログイン済みの利用者）が認証系から受け取る。
 * それをこの action で**すでに確立した接続（接続キー）越しに**渡す。
 *
 * 逆向き（ウィザードのリンクへ載せる）にしなかった理由は
 * docs/notifier-design-notes.md §8。**利用者がキーを貼る欄は作らない。**
 * ------------------------------------------------------------------
 */
function handleSaveLicense_(licenseKey) {
  var key = String(licenseKey === undefined || licenseKey === null ? '' : licenseKey).trim();

  if (!/^[A-Za-z0-9_-]{22,128}$/.test(key)) {
    return apiFail_(API_ERRORS.INVALID_REQUEST);
  }

  if (key !== getProperty_(PROP.LICENSE_KEY)) {
    setProperty_(PROP.LICENSE_KEY, key);
    /* 別のライセンスになったら、前のキーで受け取った署名は捨てる。 */
    clearVapidCache_();
  }

  var primed = primeVapid_(Date.now());

  if (!primed.ok) {
    return apiFail_(primed.error === 'NO_LICENSE' ? API_ERRORS.NO_LICENSE : API_ERRORS.GATE_ERROR);
  }

  return apiOk_({ saved: true, publicKey: primed.publicKey, license: licenseSummary_() });
}

/**
 * ゲートから公開鍵を取り寄せる。
 *
 * 購読の登録には applicationServerKey（公開鍵）が要るが、購読がまだ無い時点では
 * 送信先の aud が分からない。主要な Push サービスをまとめて頼んでおく。
 */
function primeVapid_(nowMs) {
  var result = gateVapid_([
    'https://fcm.googleapis.com',
    'https://updates.push.services.mozilla.com',
    'https://web.push.apple.com'
  ], nowMs);

  return { ok: result.ok, publicKey: result.publicKey, error: result.error };
}

/** 手動の同期（エディタから tick を実行させないための正式な代替）。 */
function handleSyncNow_() {
  var summary = syncCalendar_(Date.now());

  setProperty_(PROP.LAST_SYNC_AT, String(Date.now()));

  if (summary.error) {
    return apiFail_(summary.error === 'NO_LICENSE' ? API_ERRORS.NO_LICENSE : API_ERRORS.GATE_ERROR);
  }

  return apiOk_({
    added: summary.added,
    updated: summary.updated,
    removed: summary.removed,
    licenseState: summary.licenseState,
    queued: tableRead_(SHEET.QUEUE).length
  });
}

/**
 * セットアップ状態チェッカーが読む健康状態（接続キー不要）。
 * **予定の内容は一切含めない。** ここは接続キー無しで読める。
 */
function buildHealth_() {
  var identity = buildIdentity_();

  return {
    ok: true,
    version: identity.version,
    /*
     * 公開のたびに増える番号と、公開URLの指紋。
     * **どちらも「いま話している相手が想定のデプロイか」を見るためのもの。**
     * version は手で上げる値なので、スナップショットの取り違えを検出できない。
     */
    deployedVersion: identity.deployedVersion,
    execUrlDigest: identity.execUrlDigest,
    lastTickAt: toIsoOrEmpty_(getProperty_(PROP.LAST_TICK_AT)),
    triggerActive: hasTickTrigger_(),
    configured: getProperty_(PROP.CONNECT_KEY) !== '' && getProperty_(PROP.EID_HMAC_KEY) !== '',
    licensed: getProperty_(PROP.LICENSE_KEY) !== '',
    /*
     * ゲートとの最後のやり取りが失敗していれば、その符号。
     * **鍵も応答本文も入らない**（Gate.gs の gateFailure_）。
     * 「通知の鍵が × のまま」の原因を、画面から辿れるようにするためのもの。
     */
    lastGateError: getProperty_(PROP.LAST_GATE_ERROR)
  };
}

/** 「どのスナップショットか」を示す値。health と ping が同じものを返す。 */
function buildIdentity_() {
  return {
    version: NOTIFIER_VERSION,
    deployedVersion: getProperty_(PROP.DEPLOYED_VERSION),
    execUrlDigest: execUrlDigest_()
  };
}

/**
 * ライセンスの状態。**キーそのものは返さない。**
 *
 * state はゲートが最後に返した値（同期のたびに更新される）。
 * まだ一度も同期していない間は `unknown` になる。
 */
function licenseSummary_() {
  var present = getProperty_(PROP.LICENSE_KEY) !== '';
  var recorded = getProperty_(PROP.LICENSE_STATE);

  if (!present) {
    return { present: false, state: LICENSE_STATE.EXPIRED, checkedAt: '' };
  }

  return {
    present: true,
    state: recorded === '' ? LICENSE_STATE.UNKNOWN : recorded,
    checkedAt: toIsoOrEmpty_(getProperty_(PROP.LICENSE_CHECKED_AT))
  };
}

/**
 * 未取得の通知を取り出し、この購読について取得済みにする（FR-15/16）。
 *
 * 取得済みを**購読ごと**に持つのが V2 の変更点（宿題 B-04）。
 * V1 は行に1つの `fetchedAt` しか持たず、2台目の端末には本文が届かなかった。
 */
function takePending_(subId, nowMs) {
  var rows = tableRead_(SHEET.SENT_LOG);
  var out = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var fetchedBy = parseFetchedBy_(row.fetchedBy);

    if (fetchedBy.indexOf(subId) !== -1) {
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
      timing: Number(row.timing),
      purpose: String(row.purpose || 'calendar')
    });

    fetchedBy.push(subId);

    tableUpdate_(SHEET.SENT_LOG, row.__row, {
      key: row.key,
      eid: row.eid,
      eventId: row.eventId,
      feature: row.feature,
      timing: row.timing,
      title: row.title,
      startTime: row.startTime,
      sentAt: row.sentAt,
      purpose: row.purpose,
      fetchedBy: formatFetchedBy_(fetchedBy)
    });
  }

  return out;
}

/** 直近の通知予定（設定画面の「次に届く通知」）。 */
function listUpcoming_(nowMs) {
  var rows = tableRead_(SHEET.QUEUE);
  var items = [];

  for (var i = 0; i < rows.length; i++) {
    var notifyAt = toMs_(rows[i].notifyAt);

    if (!isFinite(notifyAt)) {
      continue;
    }

    items.push({
      title: String(rows[i].title),
      startTime: toIsoOrEmpty_(rows[i].startTime),
      notifyAt: new Date(notifyAt).toISOString(),
      timing: Number(rows[i].timing),
      sortKey: notifyAt
    });
  }

  items.sort(function (a, b) { return a.sortKey - b.sortKey; });

  var out = [];

  for (var k = 0; k < items.length && out.length < UPCOMING_LIMIT; k++) {
    if (items[k].sortKey < nowMs - PENDING_WINDOW_MS) {
      continue;
    }

    out.push({
      title: items[k].title,
      startTime: items[k].startTime,
      notifyAt: items[k].notifyAt,
      timing: items[k].timing
    });
  }

  return out;
}

/**
 * 通知から開いた画面が「どの予定か」を出すための1件取得（要件書 5.3）。
 * notify_queue を先に見て、無ければ sent_log を見る。
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

/** 想定外の例外。内部情報（スタックトレース・シートの内容）は返さない。 */
function handleUnexpected_(scope, err) {
  var message = (err && err.message) ? String(err.message) : String(err);

  Logger.log(scope + ' error: ' + message);

  return apiFail_(API_ERRORS.SERVER_ERROR);
}
