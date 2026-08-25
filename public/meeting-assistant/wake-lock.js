/*
 * Screen Wake Lock（画面の自動消灯を抑える）。ブラウザ録音の補助。
 *
 * ------------------------------------------------------------------
 * 「画面 OFF でも録音できる」機能ではない
 * ------------------------------------------------------------------
 * 利用者が電源ボタンで消灯すれば録音は中断され得る。ここで防ぐのは
 * 「操作しないまま自動消灯して録音が止まる」ことだけ。
 * 取得に失敗しても録音は続ける（あくまで補助）。
 *
 * 非対応ブラウザでは何もしない。タブが再表示されたら取り直す
 * （非表示になるとブラウザ側で自動解放されるため）。
 * ------------------------------------------------------------------
 */

export function isWakeLockSupported(nav = globalThis.navigator) {
  return typeof nav?.wakeLock?.request === 'function';
}

export function createWakeLockKeeper({ nav = globalThis.navigator, doc = globalThis.document } = {}) {
  let sentinel = null;
  let wanted = false;
  let visibilityHandler = null;

  async function acquire() {
    if (!wanted || !isWakeLockSupported(nav) || sentinel) {
      return sentinel !== null;
    }

    try {
      sentinel = await nav.wakeLock.request('screen');
      sentinel.addEventListener?.('release', () => {
        sentinel = null;
      });
      return true;
    } catch {
      /* 省電力モード・非表示タブ・権限なし。録音は続ける。 */
      sentinel = null;
      return false;
    }
  }

  function onVisibilityChange() {
    if (doc?.visibilityState === 'visible' && wanted) {
      acquire().catch(() => {});
    }
  }

  return {
    get active() {
      return sentinel !== null;
    },

    async start() {
      wanted = true;

      if (doc && !visibilityHandler) {
        visibilityHandler = onVisibilityChange;
        doc.addEventListener('visibilitychange', visibilityHandler);
      }

      return acquire();
    },

    async stop() {
      wanted = false;

      if (doc && visibilityHandler) {
        doc.removeEventListener('visibilitychange', visibilityHandler);
        visibilityHandler = null;
      }

      const current = sentinel;
      sentinel = null;

      if (current) {
        try {
          await current.release();
        } catch {
          /* 既に解放済み。 */
        }
      }
    },
  };
}
