/**
 * Web Push の送信（本文なし・署名はゲートが発行したもの）。
 *
 * 本文を送らないのは Apps Script に ECDH / HKDF が無いためで、通知の中身は
 * Service Worker が `action=pending` で取りに来る（要件 FR-15/16）。
 * 1回の tick につき1購読あたり Push は最大1通。
 * 理由は docs/notifier-design-notes.md §6。
 *
 * V2 では ES256 の署名を自前で行わない。JWT はゲート（notifier-gate）が
 * 発行し、Gate.gs が期限まで使い回す。**ライセンスが切れれば JWT が出ず、
 * その時点で送信そのものができなくなる。**
 */

/**
 * Push サービスに預ける時間（秒）。5分を過ぎた分は破棄される。
 * 遅れて届くくらいなら届かないほうがよい、という判断（design-notes §6-2）。
 * 利用者向けの説明が docs/calendar-notifier-setup.md にあるので、変えるなら両方直す。
 */
var PUSH_TTL_SECONDS = 300;

/**
 * 期限の来た通知を送る。
 *
 * 1. notify_queue から `notifyAt <= now` の行を集める（FR-12 / AC-08）
 * 2. 1件でもあれば、購読ごとに1通だけ Push を送る
 * 3. 1つでも届いたら sent_log へ記録し、キューから外す
 *
 * 「届いてから記録する」順にしているのは、送信に失敗した通知を次の tick で
 * もう一度試せるようにするため（NFR-04）。
 */
function sendDueNotifications_(nowMs) {
  var due = collectDueRows_(nowMs);

  if (due.length === 0) {
    return { due: 0, delivered: 0, recorded: 0, removed: 0 };
  }

  var result = sendTickle_(nowMs);

  if (result.delivered === 0) {
    /* 誰にも届かなかった。sent_log へは書かない（購読が復活したら送れるように）。 */
    return { due: due.length, delivered: 0, recorded: 0, removed: result.removed };
  }

  var sentRows = [];

  for (var i = 0; i < due.length; i++) {
    var feature = String(due[i].feature || 'calendar');

    tableAppend_(SHEET.SENT_LOG, {
      key: due[i].key,
      eid: due[i].eid,
      eventId: due[i].eventId,
      feature: feature,
      timing: due[i].timing,
      title: due[i].title,
      startTime: due[i].startTime,
      sentAt: nowMs,
      /* purpose は Service Worker がどの画面へ行くかを決める手がかり。 */
      purpose: feature === 'openurl' ? 'openurl' : 'calendar',
      fetchedBy: '',
      openUrl: String(due[i].openUrl || '')
    });

    sentRows.push(due[i].__row);
  }

  /*
   * 送った行はキューから外す。V2 のキューは「これから出す通知」だけを持ち、
   * 送信済みかどうかは sent_log が持つ（ゲートへ渡す sentDigest の出どころ）。
   */
  var removedFromQueue = deleteRowsByNumbers_(SHEET.QUEUE, sentRows);

  return {
    due: due.length,
    delivered: result.delivered,
    recorded: due.length,
    removed: result.removed,
    dequeued: removedFromQueue
  };
}

/** 送信すべき行（純粋な絞り込み。ここでは何も書かない）。 */
function collectDueRows_(nowMs) {
  var rows = tableRead_(SHEET.QUEUE);
  var due = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var notifyAt = toMs_(row.notifyAt);

    if (!isFinite(notifyAt) || notifyAt > nowMs) {
      continue;
    }

    due.push({
      __row: row.__row,
      key: String(row.key),
      eid: String(row.eid),
      eventId: String(row.eventId),
      feature: String(row.feature || 'calendar'),
      timing: row.timing,
      title: String(row.title),
      startTime: toMs_(row.startTime),
      openUrl: String(row.openUrl || '')
    });
  }

  return due;
}

/**
 * 全購読へ「取りに来い」の合図を1通ずつ送る。
 *
 * 404 / 410 は購読が失効した合図なので、その場で行を消す。
 * それ以外の失敗はログに残すだけにする（次の tick でまた試される）。
 */
function sendTickle_(nowMs) {
  var rows = tableRead_(SHEET.SUBSCRIPTIONS);

  if (rows.length === 0) {
    return { delivered: 0, removed: 0, total: 0 };
  }

  var audiences = [];

  for (var a = 0; a < rows.length; a++) {
    try {
      var origin = endpointOrigin_(String(rows[a].endpoint));

      if (audiences.indexOf(origin) === -1) {
        audiences.push(origin);
      }
    } catch (err) {
      /* 壊れた endpoint。下のループで同じ例外に当たり、行が記録される。 */
    }
  }

  var vapid = gateVapid_(audiences, nowMs);

  if (!vapid.ok) {
    /* 署名を得られなければ1通も送れない。キューはそのままで次の tick に任せる。 */
    Logger.log('vapid unavailable: ' + vapid.error);
    return { delivered: 0, removed: 0, total: rows.length };
  }

  var delivered = 0;
  var gone = [];

  for (var i = 0; i < rows.length; i++) {
    var endpoint = String(rows[i].endpoint);
    var code = 0;
    var message = '';

    try {
      var jwt = vapid.jwts[endpointOrigin_(endpoint)];

      if (!jwt) {
        throw new Error('この Push サービス向けの署名がありません。');
      }

      /* payload を渡さない（本文なしの POST になる）。 */
      var response = UrlFetchApp.fetch(endpoint, {
        method: 'post',
        headers: {
          Authorization: 'vapid t=' + jwt + ', k=' + vapid.publicKey,
          TTL: String(PUSH_TTL_SECONDS),
          Urgency: 'high'
        },
        muteHttpExceptions: true
      });

      code = response.getResponseCode();

      if (code < 200 || code >= 300) {
        message = String(response.getContentText() || '').slice(0, 200);
      }
    } catch (err) {
      message = err && err.message ? String(err.message) : String(err);
    }

    if (code >= 200 && code < 300) {
      delivered++;
      tableUpdate_(SHEET.SUBSCRIPTIONS, rows[i].__row, {
        subId: rows[i].subId,
        endpoint: endpoint,
        p256dh: rows[i].p256dh,
        auth: rows[i].auth,
        createdAt: rows[i].createdAt,
        lastSuccessAt: nowMs,
        lastErrorAt: '',
        lastError: ''
      });
      continue;
    }

    if (code === 404 || code === 410) {
      gone.push(rows[i].__row);
      continue;
    }

    Logger.log('push failed: ' + code + ' ' + message);

    tableUpdate_(SHEET.SUBSCRIPTIONS, rows[i].__row, {
      subId: rows[i].subId,
      endpoint: endpoint,
      p256dh: rows[i].p256dh,
      auth: rows[i].auth,
      createdAt: rows[i].createdAt,
      lastSuccessAt: rows[i].lastSuccessAt,
      lastErrorAt: nowMs,
      lastError: (code === 0 ? 'ERROR' : String(code)) + ' ' + message
    });
  }

  var removed = deleteRowsByNumbers_(SHEET.SUBSCRIPTIONS, gone);

  return { delivered: delivered, removed: removed, total: rows.length };
}

/**
 * テスト通知を1件出す（設定画面のボタンから）。
 *
 * ゲートに許可を取ってから、sent_log へ1行入れて Push を送る。
 * 通知の中身はカレンダーの通知と同じ経路（pending）で取りに来るため、
 * Service Worker 側に専用の分岐は要らない。
 */
function sendTestNotification_(nowMs) {
  var allowed = gateTestNotify_();

  if (!allowed.ok) {
    return { ok: false, error: allowed.error };
  }

  var subscriptions = tableRead_(SHEET.SUBSCRIPTIONS);

  if (subscriptions.length === 0) {
    return { ok: false, error: 'NO_SUBSCRIPTION' };
  }

  tableAppend_(SHEET.SENT_LOG, {
    key: 'test|' + nowMs,
    eid: '',
    eventId: '',
    feature: 'test',
    timing: 0,
    title: 'テスト通知',
    startTime: nowMs,
    sentAt: nowMs,
    purpose: 'test',
    fetchedBy: ''
  });

  var result = sendTickle_(nowMs);

  return { ok: result.delivered > 0, delivered: result.delivered, error: result.delivered > 0 ? '' : 'NOT_DELIVERED' };
}
