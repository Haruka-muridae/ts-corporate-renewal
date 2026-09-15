/*
 * Push Assistant の Service Worker（通知の受け口）。
 *
 * 複製元: public/production-app/calendar-url-notifier/sw.js（2026-08-26 時点）
 * 複製日: 2026-08-26
 *
 * 仕様は docs/specs/push-assistant-mvp-v1.md §8-5・§8-6。
 *
 * ==================================================================
 * 複製元との違い
 * ==================================================================
 * 複製元は「本文なし Push（tickle）」を受けて GAS へ内容を取りに行く方式
 * だった（接続情報は IndexedDB に保持）。Push Assistant は Cloudflare
 * Workers が RFC 8291 で本文を暗号化して送るため、push イベントの
 * event.data に通知の中身（title/body/url/tag）がそのまま入っている。
 * そのため IndexedDB も GAS との通信も持たない。
 *
 * 変わらないのは notificationclick の考え方（同じ URL の窓があれば
 * focus、無ければ openWindow。中間画面を挟まない）。
 * ==================================================================
 *
 * ==================================================================
 * 旧式（クラシック）の Service Worker である
 * ==================================================================
 * `type: 'module'` は未対応のブラウザで登録そのものが失敗する。
 * import は使わず、var/function だけで書く。
 * ==================================================================
 */

var FALLBACK_TITLE = 'Push Assistant を開く';
var FALLBACK_BODY = '通知の内容を取得できませんでした。アプリを開いて確認してください。';

/* ---------- URL の再検証（§8-6: SW 側でも再検証） ---------- */

/**
 * http(s) の**絶対** URL かどうか。javascript: や data: はもちろん、
 * 壊れた文字列も弾く。行き先が無ければ呼び出し側で scope に落とす。
 *
 * base を渡さずに解釈する。scope を base にすると `//example.net/x` の
 * ようなプロトコル相対文字列が https として通ってしまう。Worker 側は
 * 絶対 URL しか送らない（§9）ので、相対を許す理由がない。
 */
function isHttpUrl(text) {
  if (typeof text !== 'string' || text === '') {
    return false;
  }

  try {
    var url = new URL(text);

    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveUrl(candidate) {
  return isHttpUrl(candidate) ? candidate : self.registration.scope;
}

/* ---------- push ---------- */

/*
 * ペイロードは Worker が RFC 8291 で暗号化して送る JSON
 * （{ v, kind, title, body, url, tag }）。event.data が無い／JSON でない
 * ときも、userVisibleOnly: true で購読している以上、1件は通知を出す。
 */
self.addEventListener('push', function (event) {
  var payload = null;

  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = null;
    }
  }

  var title;
  var options;

  if (payload && typeof payload === 'object') {
    var rawTitle = typeof payload.title === 'string' ? payload.title.trim() : '';

    title = rawTitle === '' ? FALLBACK_TITLE : rawTitle;
    options = {
      body: typeof payload.body === 'string' ? payload.body : '',
      tag: typeof payload.tag === 'string' && payload.tag !== '' ? payload.tag : undefined,
      data: { url: resolveUrl(payload.url) },
      icon: './icon-192.png',
      badge: './icon-192.png',
      renotify: false
    };
  } else {
    title = FALLBACK_TITLE;
    options = {
      body: FALLBACK_BODY,
      data: { url: self.registration.scope },
      icon: './icon-192.png',
      badge: './icon-192.png',
      renotify: false
    };
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

/* ---------- notificationclick ---------- */

/*
 * **開くのは操作した端末だけである。** 中間画面は挟まない（§8-6）。
 * data.url は push 側で一度検証済みだが、ここでも再検証する
 * （ブラウザの実装差やデータの取り扱われ方に依存しない）。
 */
self.addEventListener('notificationclick', function (event) {
  var raw = event.notification && event.notification.data ? event.notification.data.url : '';
  var url = resolveUrl(raw);

  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
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
 * scope からの相対で API を組む（複製元と同じく、配置場所を直書きしない）。
 */
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(
    fetch(new URL('api/me', self.registration.scope).toString(), { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('api/me への要求が失敗しました: ' + response.status);
        }

        return response.json();
      })
      .then(function (data) {
        var publicKey = data && data.vapidPublicKey;

        if (!publicKey) {
          throw new Error('vapidPublicKey を取得できませんでした');
        }

        return self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(publicKey)
        });
      })
      .then(function (subscription) {
        return fetch(new URL('api/subscriptions', self.registration.scope).toString(), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: subscription.toJSON() })
        });
      })
      .catch(function (error) {
        console.error('[push-assistant:sw] 購読の再登録に失敗', error);
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
 * 通知の受け口はキャッシュを持たない（古い版を残す意味がない、§8-6）。
 */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
