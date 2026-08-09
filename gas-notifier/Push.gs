/**
 * Web Push の送信（VAPID 署名つき・本文なし）。
 *
 * ==================================================================
 * 本文を送らない
 * ==================================================================
 * Web Push の本文は、購読ごとの鍵（p256dh / auth）から ECDH + HKDF で
 * 導いた鍵で AES128GCM 暗号化する決まりになっている。Apps Script には
 * ECDH も HKDF も無く、実装すれば jsrsasign の外へさらに暗号処理が要る。
 *
 * 本文なしの Push（tickle）なら、必要なのは VAPID の ES256 署名だけで済む。
 * 通知の中身は Service Worker が `action=pending` で取りに来る（FR-15/16）。
 * ==================================================================
 *
 * ==================================================================
 * 1回の tick につき、1購読あたり Push は最大1通
 * ==================================================================
 * 本文なし Push は「取りに来い」という合図でしかない。Service Worker は
 * pending をまとめて受け取るので、期限が来た通知が3件あっても合図は1回でよい。
 *
 * 件数分送ると、2通目以降の push イベントでは pending が空になり、
 * Service Worker 側のフォールバック（汎用通知）が誤って表示される
 * （userVisibleOnly の約束を守るため、空でも1件は出す実装になっている）。
 * public/production-app/voice-recorder/sw.js の push ハンドラと対で読むこと。
 * ==================================================================
 */

/* VAPID JWT の有効期間。RFC 8292 の上限は24時間だが、短めに12時間とする。 */
var VAPID_JWT_TTL_MS = 12 * 60 * 60 * 1000;

/*
 * Push サービスに預ける時間（秒）。
 *
 * ブラウザが受け取れない間（プロセス終了・電源断・スリープ）、Push サービスは
 * この秒数だけ通知を預かる。**5分を過ぎた分は破棄される。**
 *
 * 短くしているのは意図的である。「10:55に知らせてほしい」通知が12時に届いても、
 * 会議はもう始まっており、役に立たないどころか混乱のもとになる。
 * **遅れて届くくらいなら届かないほうがよい。**
 *
 * この挙動は利用者から見えるため、docs/calendar-notifier-setup.md §9 に
 * 同じ説明を書いてある。値を変えるなら、そちらも直すこと。
 */
var PUSH_TTL_SECONDS = 300;

/**
 * VAPID の `sub`（連絡先）。
 *
 * RFC 8292 は `mailto:` と `https:` の URI を許す。
 * メールアドレスを取るために userinfo.email スコープを足すと、**利用者の
 * データへ届く範囲が広がる**（要件 NFR-02 の最小権限に反する）。
 * スコープは増やさず、Session.getEffectiveUser() が空を返す環境では
 * https の連絡先URIへ落とす。
 *
 * 現在のスコープ一覧とその理由は gas-notifier/README.md §1-1。
 */
var CONTACT_URI = 'https://tsam-ai.com/production-app/voice-recorder/';

function vapidSubject_() {
  try {
    var email = Session.getEffectiveUser().getEmail();

    if (email && String(email).indexOf('@') !== -1) {
      return 'mailto:' + email;
    }
  } catch (err) {
    /* 権限が無い環境では例外になる。連絡先URIへ落とすだけでよい。 */
  }

  return CONTACT_URI;
}

/** エンドポイントURLの origin（scheme + host）。JWT の aud に使う。 */
function endpointOrigin_(endpoint) {
  var match = String(endpoint).match(/^(https?:\/\/[^\/?#]+)/);

  if (!match) {
    throw new Error('Push エンドポイントの形式が不正です。');
  }

  return match[1];
}

/** VAPID の JWT を作る。署名は jsrsasign（lib_jsrsasign.gs）が行う。 */
function buildVapidJwt_(audience, nowMs) {
  var privatePem = getProperty_(PROP.VAPID_PRIVATE);

  if (privatePem === '') {
    throw new Error('VAPID の鍵がありません。セットアップを実行してください。');
  }

  var header = { typ: 'JWT', alg: 'ES256' };
  var claims = {
    aud: audience,
    exp: Math.floor((nowMs + VAPID_JWT_TTL_MS) / 1000),
    sub: vapidSubject_()
  };

  return KJUR.jws.JWS.sign('ES256', JSON.stringify(header), JSON.stringify(claims), privatePem);
}

/**
 * 期限の来た通知を送る。
 *
 * 1. notify_queue から `notifyAt <= now` かつ sent_log に無い行を集める（FR-12 / AC-08）
 * 2. 1件でもあれば、購読ごとに **1通だけ** Push を送る
 * 3. 1つでも届いたら sent_log へ記録する
 *
 * 3で「届いてから記録する」順にしているのは、送信に失敗した通知を
 * 次の tick でもう一度試せるようにするため（NFR-04 の自然なリトライ）。
 */
function sendDueNotifications_(nowMs) {
  var due = collectDueRows_(nowMs);

  if (due.length === 0) {
    return { due: 0, delivered: 0, recorded: 0, removed: 0 };
  }

  var result = sendTickle_(nowMs);

  if (result.delivered === 0) {
    /*
     * 誰にも届かなかった。**sent_log へは書かない。**
     * 書いてしまうと、購読が復活しても二度と送られない。
     */
    return { due: due.length, delivered: 0, recorded: 0, removed: result.removed };
  }

  for (var i = 0; i < due.length; i++) {
    tableAppend_(SHEET.SENT_LOG, {
      key: due[i].key,
      eventId: due[i].eventId,
      timing: due[i].timing,
      title: due[i].title,
      startTime: due[i].startTime,
      sentAt: nowMs,
      purpose: 'calendar',
      fetchedAt: ''
    });
  }

  return {
    due: due.length,
    delivered: result.delivered,
    recorded: due.length,
    removed: result.removed
  };
}

/** 送信すべき行（純粋な絞り込み。ここでは何も書かない）。 */
function collectDueRows_(nowMs) {
  var sent = sentKeySet_();
  var rows = tableRead_(SHEET.QUEUE);
  var due = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var notifyAt = toMs_(row.notifyAt);

    if (!isFinite(notifyAt) || notifyAt > nowMs) {
      continue;
    }

    if (sent[String(row.key)] === true) {
      continue;
    }

    due.push({
      key: String(row.key),
      eventId: String(row.eventId),
      timing: row.timing,
      title: String(row.title),
      startTime: toMs_(row.startTime)
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
  var publicKey = getProperty_(PROP.VAPID_PUBLIC);
  var delivered = 0;
  var gone = [];

  for (var i = 0; i < rows.length; i++) {
    var endpoint = String(rows[i].endpoint);
    var code = 0;
    var message = '';

    try {
      var jwt = buildVapidJwt_(endpointOrigin_(endpoint), nowMs);

      /*
       * payload を渡さない。UrlFetchApp は本文なしの POST を
       * Content-Length: 0 で送る（Web Push の本文なし要求と同じ形）。
       */
      var response = UrlFetchApp.fetch(endpoint, {
        method: 'post',
        headers: {
          Authorization: 'vapid t=' + jwt + ', k=' + publicKey,
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
      /* 購読が失効している。残しても毎分エラーになるだけなので消す。 */
      gone.push(rows[i].__row);
      continue;
    }

    Logger.log('push failed: ' + code + ' ' + message);

    tableUpdate_(SHEET.SUBSCRIPTIONS, rows[i].__row, {
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
