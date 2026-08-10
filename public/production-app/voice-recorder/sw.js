/*
 * ブラウザ録音アプリの Service Worker（カレンダー通知の受け口）。
 *
 * ==================================================================
 * ここに録音のコードを書かない
 * ==================================================================
 * 通知やそのクリックで録音を始めてはならない（FR-20 / NFR-06）。
 * 録音の開始は、画面上の明示的な操作だけとする。
 *
 * マイクの取得・録音APIの生成・レコーダーの開始にあたる識別子が
 * このファイルに現れないことを、自動テスト
 * （tests/unit/voice-recorder-notifier.mjs の「配信物の見張り」）が
 * **文字列として**見ている。禁止語そのものは、そちらに書いてある。
 * ==================================================================
 *
 * ==================================================================
 * 旧式（クラシック）の Service Worker である
 * ==================================================================
 * `type: 'module'` は未対応のブラウザで登録そのものが失敗する。
 * 対応表を追いかけるより、import を諦めるほうが確実だと判断した。
 *
 * その代わり、下の2節は他のファイルからの**複製**である。
 * 片方だけ変えないこと。
 *   - 「notifier-config.js からの複製」 … IndexedDB の定義と読み出し
 *   - 「notifier-messages.js からの複製」 … 通知本文の整形とURL組み立て
 * ==================================================================
 *
 * ==================================================================
 * パスを直書きしない
 * ==================================================================
 * 開く先も、自分の窓かどうかの判定も `self.registration.scope` から作る。
 * scope は登録した場所（このファイルが置かれたディレクトリ）の絶対URL。
 * 直書きすると、配信構成を変えたときにここだけ取り残される。
 * ==================================================================
 */

/* ---------- notifier-config.js からの複製 ---------- */

var DB_NAME = 'tsam-vr-notifier';
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

/* ---------- notifier-messages.js からの複製 ---------- */

var FALLBACK_TITLE = '予定の通知';
var FALLBACK_BODY = '通知の内容を取得できませんでした。録音アプリを開いて確認してください。';

function formatClock(value) {
  var date = value instanceof Date ? value : new Date(value);

  if (isNaN(date.getTime())) {
    return '';
  }

  var hours = String(date.getHours());
  var minutes = String(date.getMinutes());

  return (hours.length < 2 ? '0' + hours : hours) + ':' + (minutes.length < 2 ? '0' + minutes : minutes);
}

function notificationTag(eventId, timing) {
  var id = String(eventId === undefined || eventId === null ? '' : eventId).trim();

  if (id === '') {
    return 'tsam-vr-notifier';
  }

  return id + '|' + (timing === undefined || timing === null ? '' : timing);
}

function buildNotification(item) {
  var source = item && typeof item === 'object' ? item : {};
  var title = String(source.title === undefined || source.title === null ? '' : source.title).trim();
  var clock = formatClock(source.startTime);

  return {
    title: title === '' ? FALLBACK_TITLE : title,
    body: clock === ''
      ? 'まもなく開始します。録音しますか？'
      : clock + 'から開始します。録音しますか？',
    tag: notificationTag(source.eventId, source.timing),
    eventId: String(source.eventId === undefined || source.eventId === null ? '' : source.eventId)
  };
}

function buildFallbackNotification() {
  return {
    title: FALLBACK_TITLE,
    body: FALLBACK_BODY,
    tag: 'tsam-vr-notifier-fallback',
    eventId: ''
  };
}

function buildEventUrl(scope, eventId) {
  var base = String(scope === undefined || scope === null ? '' : scope);
  var id = String(eventId === undefined || eventId === null ? '' : eventId).trim();

  if (id === '') {
    return base;
  }

  return base + '?eventId=' + encodeURIComponent(id);
}

function isAppClientUrl(clientUrl, scope) {
  var url = String(clientUrl === undefined || clientUrl === null ? '' : clientUrl);
  var base = String(scope === undefined || scope === null ? '' : scope);

  return base !== '' && url.indexOf(base) === 0;
}

/* ---------- GAS との通信 ---------- */

/*
 * GAS の Web アプリは scriptContent 経由の302を返すため、リダイレクトを追う。
 * POST の Content-Type を text/plain にしているのはプリフライトを避けるため
 * （notifier-client.js と同じ約束）。
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
 *
 * GAS 側は「1 tick につき1購読あたり1通」しか送らない（Push.gs の冒頭）。
 * したがってここでは pending を**まとめて**受け取り、件数分の通知を出す。
 *
 * pending が空でも1件は出す。userVisibleOnly: true で購読している以上、
 * 表示せずに終わるとブラウザが購読を打ち切ることがあるためである。
 */
self.addEventListener('push', function (event) {
  event.waitUntil(
    readConnection()
      .then(function (connection) {
        if (!connection) {
          return [];
        }

        /*
         * **この端末の endpoint を必ず添える（宿題 B-04）。**
         * 省略すると GAS は要求を受け付けない。V1 は「誰が取りに来たか」を
         * 見ておらず、2台目の端末には汎用の通知しか出せなかった。
         */
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
        console.error('[voice-recorder:sw] pending の取得に失敗', error);
        return [];
      })
      .then(function (items) {
        if (!items || items.length === 0) {
          var fallback = buildFallbackNotification();

          return self.registration.showNotification(fallback.title, {
            body: fallback.body,
            tag: fallback.tag,
            data: { eventId: '' }
          });
        }

        return Promise.all(items.map(function (item) {
          var view = buildNotification(item);

          return self.registration.showNotification(view.title, {
            body: view.body,
            tag: view.tag,
            data: { eventId: view.eventId }
          });
        }));
      })
  );
});

/* ---------- notificationclick ---------- */

/*
 * 開いている録音アプリがあればそれを前面に出し、無ければ開く（FR-17〜19）。
 * **ここで録音を始めない**（FR-20）。画面は「対象の予定」を出すだけにする。
 */
self.addEventListener('notificationclick', function (event) {
  var scope = self.registration.scope;
  var eventId = (event.notification.data && event.notification.data.eventId) || '';

  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];

          if (isAppClientUrl(client.url, scope)) {
            return client.focus().then(function (focused) {
              (focused || client).postMessage({ type: 'SHOW_EVENT', eventId: eventId });
            });
          }
        }

        return self.clients.openWindow(buildEventUrl(scope, eventId));
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
        console.error('[voice-recorder:sw] 購読の再登録に失敗', error);
      })
  );
});

/*
 * base64url の公開鍵を Uint8Array にする。
 * pushManager.subscribe が受け取るのはこの形だけ。
 * （notifier-panel.js にも同じ関数がある。用途が同じなので形も揃えてある。）
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
