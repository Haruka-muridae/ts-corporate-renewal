/*
 * T6-5 の検証用 Service Worker。
 *
 * 本番の実装ではない。届くかどうかと、通知からアプリへ復帰できるかだけを見る。
 *
 * 注意: 本番で使うときは、通知の中身に利用者のコンテンツを載せないこと。
 * 通知本文はOSの通知センターに残り、端末のロック画面にも出る。
 * 実装指示書 §2 の非保持方針は運営側のストアの話だが、
 * ロック画面に下書き本文が出るのは利用者にとって別種の事故になる。
 */

self.addEventListener('install', () => {
  /* 検証用なので即座に有効化する。登録し直すたびに待たされないため。 */
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: '予約リマインダー（検証）', body: '本文なし' };

  try {
    if (event.data) {
      payload = { ...payload, ...event.data.json() };
    }
  } catch {
    /* JSON でなければテキストとして扱う。 */
    payload.body = event.data ? event.data.text() : payload.body;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      /* 受信時刻の記録用。届いた時刻と予定時刻のずれを測る。 */
      data: { receivedAt: new Date().toISOString(), url: payload.url ?? '/' },
      requireInteraction: true,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  /*
   * 通知からアプリへ戻れるかが T6-5 の判定項目のひとつ。
   * 既に開いているタブがあればそれを前面に出し、無ければ開く。
   */
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            return client.focus();
          }
        }

        return self.clients.openWindow(event.notification.data?.url ?? '/');
      }),
  );
});
