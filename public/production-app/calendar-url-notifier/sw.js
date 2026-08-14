/*
 * カレンダーURL通知アプリの Service Worker（通知の受け口）。
 *
 * 仕様は docs/specs/calendar-url-notifier-requirements-v1.md。
 *
 * ==================================================================
 * 録音アプリの Service Worker とは別物である
 * ==================================================================
 * 作りは public/apps/voice-recorder/sw.js を下敷きにした**複製**であり、
 * import はしていない（テスト環境から本番が依存すると向きが逆になる。
 * CLAUDE.md「public/apps/voice-recorder/ から import しない」）。
 *
 * 違うのは行き先の決め方だけである。
 *   録音アプリ … 固定の画面へ `?eventId=` 付きで飛ぶ
 *   このアプリ … 予定ごとの URL（GAS が解決したもの）を開く
 * ==================================================================
 *
 * ==================================================================
 * 旧式（クラシック）の Service Worker である
 * ==================================================================
 * `type: 'module'` は未対応のブラウザで登録そのものが失敗する。
 * そのため下の「app.js からの複製」は import ではなく写しである。
 * 片方だけ変えないこと。
 * ==================================================================
 */

/* ---------- app.js からの複製（接続情報の置き場） ---------- */

var DB_NAME = 'tsam-curl-notifier';
var DB_VERSION = 1;
var STORE_NAME = 'config';
var CONNECTION_KEY = 'connection';

function openDb() {
  return new Promise(function (resolve, reject) {
    var request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = function () {
      var db = request.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

function readConnection() {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var request = db.transaction(STORE_NAME, 'readonly')
        .objectStore(STORE_NAME)
        .get(CONNECTION_KEY);

      request.onsuccess = function () {
        var value = request.result;

        if (!value || typeof value.url !== 'string' || typeof value.key !== 'string') {
          resolve(null);
          return;
        }

        resolve({ url: value.url, key: value.key });
      };

      request.onerror = function () { reject(request.error); };
    }).finally(function () { db.close(); });
  });
}

/* ---------- 通知の組み立て ---------- */

var FALLBACK_TITLE = '予定の通知';
var FALLBACK_BODY = '通知の内容を取得できませんでした。アプリを開いて確認してください。';

/* ボタンのラベルに載せる予定名の長さ。超えた分は省略する。 */
var LABEL_MAX_TITLE = 12;

function notificationTag(eventId, timing) {
  var id = String(eventId === undefined || eventId === null ? '' : eventId).trim();

  if (id === '') {
    return 'tsam-curl-notifier';
  }

  return id + '|' + (timing === undefined || timing === null ? '' : timing);
}

/** ボタンの文言。何が開くのかをボタン上でも分かるようにする（要件 FR-05）。 */
function actionLabel(title) {
  var name = String(title || '').trim();

  if (name === '') {
    return '開く';
  }

  return (name.length > LABEL_MAX_TITLE ? name.slice(0, LABEL_MAX_TITLE) + '…' : name) + 'を開く';
}

function buildNotification(item) {
  var source = item && typeof item === 'object' ? item : {};
  var title = String(source.title === undefined || source.title === null ? '' : source.title).trim();
  var timing = Number(source.timing);

  return {
    title: title === '' ? FALLBACK_TITLE : title,
    body: isFinite(timing) && timing > 0
      ? timing + '分後に予定が始まります'
      : '予定の開始時刻です',
    tag: notificationTag(source.eventId, source.timing),
    label: actionLabel(title),
    url: String(source.openUrl === undefined || source.openUrl === null ? '' : source.openUrl)
  };
}

/* ---------- GAS との通信 ---------- */

/*
 * GAS の Web アプリは scriptContent 経由の302を返すため、リダイレクトを追う。
 * POST の Content-Type を text/plain にしているのはプリフライトを避けるため。
 */
function gasGet(connection, action, params) {
  var query = ['action=' + encodeURIComponent(action), 'key=' + encodeURIComponent(connection.key)];

  if (params) {
    Object.keys(params).forEach(function (name) {
      query.push(encodeURIComponent(name) + '=' + encodeURIComponent(params[name]));
    });
  }

  return fetch(connection.url + '?' + query.join('&'), {
    method: 'GET',
    redirect: 'follow'
  }).then(function (response) {
    if (!response.ok) {
      throw new Error('GAS への要求が失敗しました: ' + response.status);
    }

    return response.json();
  }).then(function (payload) {
    if (!payload || payload.ok !== true) {
      throw new Error((payload && payload.error && payload.error.code) || 'UNKNOWN');
    }

    return payload.data || {};
  });
}

function gasPost(connection, action, body) {
  var payload = Object.assign({ action: action, key: connection.key }, body || {});

  return fetch(connection.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  }).then(function (response) {
    if (!response.ok) {
      throw new Error('GAS への要求が失敗しました: ' + response.status);
    }

    return response.json();
  });
}

/* ---------- push ---------- */

/*
 * 本文なし Push（tickle）を受けたら、内容を GAS へ取りに行く。
 * **URL がこの端末へ渡るのはここが初めてである。** 運営のゲートは通らない
 * （要件 §2-2）。
 *
 * pending が空でも1件は出す。userVisibleOnly: true で購読している以上、
 * 表示せずに終わるとブラウザが購読を打ち切ることがある。
 */
self.addEventListener('push', function (event) {
  event.waitUntil(
    readConnection()
      .then(function (connection) {
        if (!connection) {
          return [];
        }

        /* この端末の endpoint を必ず添える。省略すると GAS は受け付けない。 */
        return self.registration.pushManager.getSubscription().then(function (subscription) {
          if (!subscription) {
            return [];
          }

          return gasGet(connection, 'pending', { endpoint: subscription.endpoint })
            .then(function (data) {
              return (data && data.notifications) || [];
            });
        });
      })
      .catch(function (error) {
        console.error('[calendar-url-notifier:sw] pending の取得に失敗', error);
        return [];
      })
      .then(function (items) {
        var targets = (items || []).filter(function (item) {
          /* 録音アプリ向けの通知が混ざっていても、こちらでは出さない。 */
          return String((item && item.purpose) || '') === 'openurl';
        });

        if (targets.length === 0) {
          /*
           * 行き先が分からないまま「開く」ボタンだけ出すと、押しても何も起きない。
           * このアプリの画面を開く通知にして、そこで直近の予定を確認してもらう。
           */
          return self.registration.showNotification(FALLBACK_TITLE, {
            body: FALLBACK_BODY,
            tag: 'tsam-curl-notifier-fallback',
            data: { url: self.registration.scope }
          });
        }

        return Promise.all(targets.map(function (item) {
          var view = buildNotification(item);
          var url = view.url === '' ? self.registration.scope : view.url;

          return self.registration.showNotification(view.title, {
            body: view.body,
            tag: view.tag,
            /* 通知本体のタップでも開けるよう、URL は data にも持たせる。 */
            data: { url: url },
            actions: [{ action: 'open', title: view.label }]
          });
        }));
      })
  );
});

/* ---------- notificationclick ---------- */

/*
 * 通知本体でもボタンでも、開くのは同じ URL とする（要件 FR-04 / FR-05）。
 * 押し分けで結果が変わると、ボタンが見えない端末の利用者だけ別の体験になる。
 *
 * **開くのは操作した端末だけである。** 他の端末では通知が残るだけで何も起きない。
 */
self.addEventListener('notificationclick', function (event) {
  var url = (event.notification.data && event.notification.data.url) || self.registration.scope;

  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        /* 同じ URL を開いている窓があれば、増やさずにそれを前へ出す。 */
        for (var i = 0; i < clientList.length; i++) {
          if (clientList[i].url === url && typeof clientList[i].focus === 'function') {
            return clientList[i].focus();
          }
        }

        return self.clients.openWindow(url);
      })
  );
});

/* ---------- pushsubscriptionchange ---------- */

/*
 * ブラウザ都合で購読が作り直されたときに来る。
 * 取り直して GAS へ送らないと、以後の通知が届かなくなる。
 */
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(
    readConnection()
      .then(function (connection) {
        if (!connection) {
          return null;
        }

        return gasGet(connection, 'publicKey')
          .then(function (data) {
            return self.registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: base64UrlToUint8Array(data.publicKey)
            });
          })
          .then(function (subscription) {
            return gasPost(connection, 'saveSubscription', {
              subscription: subscription.toJSON()
            });
          });
      })
      .catch(function (error) {
        console.error('[calendar-url-notifier:sw] 購読の再登録に失敗', error);
      })
  );
});

/*
 * base64url の公開鍵を Uint8Array にする。
 * pushManager.subscribe が受け取るのはこの形だけ。
 */
function base64UrlToUint8Array(text) {
  var padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
  var padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  var binary = atob(padded + padding);
  var bytes = new Uint8Array(binary.length);

  for (var i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/*
 * 更新したらすぐ有効にする。
 * 通知の受け口はキャッシュを持たないため、古い版を残す意味がない。
 */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
