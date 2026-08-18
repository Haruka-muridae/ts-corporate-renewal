/*
 * 交流会ページ専用スクリプト。
 * ../js/main.js はトップページのHero要素を前提とするため、
 * このページでは必要な挙動のみを独立して実装する。
 * 各要素は存在しない場合を考慮し、処理をスキップする。
 */

/* =========================
   受付状態・開催日一覧の決め方（2026-08 改訂）
   =========================

   開催日はGoogleカレンダー（主催者の予定）が真実源で、サーバー側
   （lib/event/calendar-sync.mjs）が定期的にDBへ取り込んでいる。
   このページは /event/api/schedule/ を叩いて、その結果をそのまま表示する。

   1. 取得できたとき（正）
      - 開催日一覧（#event-schedule-list）を応答の events で描き直す。
      - 受付状態は自動で決める。
        accepting な回が1件以上     … "open"（受付中）
        1件以上あるが全回 soldOut   … "full"（満席で受付終了）
        1件以上あるがそれ以外       … "closed"（受付期間の外）
        events が0件                … "preparing"（準備中）
      - index.html の data-event-status・静的な <time> は使わない。
   2. 取得できなかったとき（フォールバック）
      - index.html に直接書いてある data-event-status の値と、
        「開催日時」の静的な <time> 表記をそのまま使う（このJSは書き換えない）。
      - API側の障害時にもページの体裁が崩れないようにするための保険であり、
        日常の更新はカレンダー側で行う（このファイル・index.htmlを編集しない）。
   3. 申込フォームを実装したら、下の APPLY_URL に相対パスを入れる。
      null のままなら、"open" でもボタンは無効のままにする。
      リンク先が無い状態で押せるボタンを出さないための保険。
*/
const APPLY_URL = '/event/apply/';
const SCHEDULE_API_URL = '/event/api/schedule/';

const STATUS_TEXT = {
  preparing: {
    badge: '準備中',
    text: 'お申し込みの受付開始までお待ちください。',
    note: 'お申し込みの受付開始までお待ちください。',
  },
  open: {
    badge: '受付中',
    text: 'お申し込みを受け付けています。',
    note: '金額は次の画面でご確認いただけます。',
  },
  full: {
    badge: '受付終了',
    text: '申込状況により、お申し込みの受付を終了しました。',
    note: '申込状況により、お申し込みの受付を終了しました。',
  },
  closed: {
    badge: '受付終了',
    text: 'お申し込みの受付期間は終了しました。',
    note: 'お申し込みの受付期間は終了しました。',
  },
};

document.addEventListener('DOMContentLoaded', () => {
  const header = document.getElementById('header');
  const menuToggle = document.getElementById('menu-toggle');
  const globalNav = document.getElementById('global-nav');
  const pagetop = document.getElementById('pagetop');
  const desktopMedia = window.matchMedia('(min-width: 1024px)');
  const reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  let revealObserver = null;

  /* ---------- Application status & schedule ---------- */

  const statusElement = document.getElementById('event-status');
  const statusBadge = document.getElementById('event-status-badge');
  const statusText = document.getElementById('event-status-text');
  const applyButton = document.getElementById('apply-button');
  const applyNote = document.getElementById('apply-note');
  const scheduleList = document.getElementById('event-schedule-list');

  /* ボタンの有効・無効は applyStatus() が都度切り替える。押下時の遷移だけ先に決めておく。 */
  if (applyButton && typeof APPLY_URL === 'string' && APPLY_URL !== '') {
    applyButton.addEventListener('click', () => {
      if (!applyButton.disabled) {
        window.location.href = APPLY_URL;
      }
    });
  }

  /* 未知の値が入っていても表示が壊れないよう preparing へ寄せる。 */
  function applyStatus(statusKey) {
    const status = STATUS_TEXT[statusKey] ?? STATUS_TEXT.preparing;

    if (statusBadge) {
      statusBadge.textContent = status.badge;
    }

    if (statusText) {
      statusText.textContent = status.text;
    }

    if (applyNote) {
      applyNote.textContent = status.note;
    }

    if (applyButton) {
      /*
       * 受付中でも、遷移先が無ければ押せるようにしない。
       * リンク先の無いボタンを押せる状態で出すと、押しても何も起きない。
       * 上の click ハンドラも同じ条件で登録している（条件を揃えること）。
       */
      applyButton.disabled = !(
        statusKey === 'open' && typeof APPLY_URL === 'string' && APPLY_URL !== ''
      );
    }
  }

  /*
   * 開催日一覧から受付状態を決める。
   *
   *   accepting が1件以上         … open（受付中）
   *   公開回はあるが全て soldOut … full（満席で終了）
   *   公開回はあるがどちらでもない … closed（受付期間の外）
   *   1件も無い                   … preparing（準備中）
   *
   * full と closed を分けるのは、出す文言が違うため（満席なのか、
   * まだ受付が始まっていない・すでに締め切ったのか）。両方を full に
   * まとめると、受付開始前の回しか無いときに「満席」と出てしまう。
   */
  function resolveStatusFromSchedule(items) {
    if (items.length === 0) {
      return 'preparing';
    }

    if (items.some((item) => item.accepting)) {
      return 'open';
    }

    if (items.every((item) => item.soldOut)) {
      return 'full';
    }

    return 'closed';
  }

  function renderScheduleList(items) {
    if (!scheduleList) {
      return;
    }

    scheduleList.innerHTML = '';

    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'schedule-list__item';
      li.textContent = '現在、開催予定はありません。';
      scheduleList.appendChild(li);
      return;
    }

    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'schedule-list__item';

      const label = document.createElement('span');
      label.className = 'nowrap';
      label.textContent = item.label;
      li.appendChild(label);

      if (item.soldOut) {
        const badge = document.createElement('span');
        badge.className = 'schedule-list__badge';
        badge.textContent = '満席';
        li.appendChild(badge);
      }

      scheduleList.appendChild(li);
    });

    /* API側のデータで描き直したことを示す（フォールバックの静的表記と区別するため）。 */
    scheduleList.dataset.source = 'api';
  }

  /* フォールバック: index.html の data-event-status と静的な <time> をそのまま使う。 */
  function applyFallbackStatus() {
    applyStatus(statusElement?.dataset.eventStatus ?? 'preparing');
  }

  async function loadSchedule() {
    try {
      const response = await fetch(SCHEDULE_API_URL);

      if (!response.ok) {
        throw new Error(`schedule api responded with ${response.status}`);
      }

      const payload = await response.json();
      const items = Array.isArray(payload?.events) ? payload.events : [];

      renderScheduleList(items);
      applyStatus(resolveStatusFromSchedule(items));
    } catch {
      /* 取得できない間はフォールバックのままにする（静的HTML・data-event-status）。 */
      applyFallbackStatus();
    }
  }

  applyFallbackStatus();
  loadSchedule();

  /* ---------- Scroll reveal ---------- */

  const revealElements = [...document.querySelectorAll('.reveal')];

  const showAllRevealElements = () => {
    revealObserver?.disconnect();
    revealObserver = null;
    document.documentElement.classList.remove('reveal-ready');
    revealElements.forEach((element) => {
      element.classList.add('is-visible', 'is-reveal-complete');
    });
  };

  const initializeScrollReveal = () => {
    if (!revealElements.length) {
      return;
    }

    if (reducedMotionMedia.matches || !('IntersectionObserver' in window)) {
      showAllRevealElements();
      return;
    }

    document.documentElement.classList.add('reveal-ready');
    revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }

        entry.target.classList.add('is-visible');
        window.setTimeout(() => {
          entry.target.classList.add('is-reveal-complete');
        }, 600);
        /* 一度表示したら監視を外し、以降の交差判定を発生させない。 */
        observer.unobserve(entry.target);
      });
    }, {
      threshold: 0.15,
      rootMargin: '0px 0px -10% 0px',
    });

    revealElements.forEach((element) => revealObserver.observe(element));
  };

  initializeScrollReveal();

  reducedMotionMedia.addEventListener('change', (event) => {
    if (event.matches) {
      showAllRevealElements();
    }
  });

  /* ---------- Global navigation ---------- */

  if (menuToggle && globalNav) {
    const menuLinks = [...globalNav.querySelectorAll('a[href]')];
    const isMenuOpen = () => menuToggle.getAttribute('aria-expanded') === 'true';

    const closeMenu = (restoreFocus = true) => {
      const wasOpen = isMenuOpen();

      menuToggle.setAttribute('aria-expanded', 'false');
      menuToggle.setAttribute('aria-label', 'メニューを開く');
      document.body.classList.remove('is-menu-open');

      if (!desktopMedia.matches) {
        globalNav.setAttribute('aria-hidden', 'true');
      }

      if (wasOpen && restoreFocus) {
        menuToggle.focus();
      }
    };

    const openMenu = () => {
      menuToggle.setAttribute('aria-expanded', 'true');
      menuToggle.setAttribute('aria-label', 'メニューを閉じる');
      globalNav.setAttribute('aria-hidden', 'false');
      document.body.classList.add('is-menu-open');

      window.requestAnimationFrame(() => {
        menuLinks[0]?.focus();
      });
    };

    const syncNavigationMode = () => {
      closeMenu(false);

      if (desktopMedia.matches) {
        globalNav.removeAttribute('aria-hidden');
      }
    };

    menuToggle.addEventListener('click', () => {
      if (isMenuOpen()) {
        closeMenu();
        return;
      }

      openMenu();
    });

    /* リンクは件数が固定のため、個別登録ではなく委譲で1つにまとめる。 */
    globalNav.addEventListener('click', (event) => {
      if (!event.target.closest('a[href]')) {
        return;
      }

      if (!desktopMedia.matches && isMenuOpen()) {
        closeMenu();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (!isMenuOpen() || desktopMedia.matches) {
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const focusableElements = [menuToggle, ...menuLinks];
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    });

    desktopMedia.addEventListener('change', syncNavigationMode);
    syncNavigationMode();
  }

  /* ---------- Header state and back to top ---------- */

  let scrollTicking = false;
  /* 直前の状態を保持し、変化があるときだけDOMへ書き込む。 */
  let isHeaderScrolled = null;
  let isPagetopVisible = null;

  const updateScrollState = () => {
    const scrollPosition = window.scrollY;
    const nextHeaderScrolled = scrollPosition > 80;
    const nextPagetopVisible = scrollPosition > 600;

    if (header && nextHeaderScrolled !== isHeaderScrolled) {
      header.classList.toggle('is-scrolled', nextHeaderScrolled);
      isHeaderScrolled = nextHeaderScrolled;
    }

    if (pagetop && nextPagetopVisible !== isPagetopVisible) {
      pagetop.classList.toggle('is-visible', nextPagetopVisible);
      pagetop.setAttribute('aria-hidden', String(!nextPagetopVisible));
      pagetop.tabIndex = nextPagetopVisible ? 0 : -1;
      isPagetopVisible = nextPagetopVisible;
    }

    scrollTicking = false;
  };

  window.addEventListener('scroll', () => {
    if (scrollTicking) {
      return;
    }

    scrollTicking = true;
    window.requestAnimationFrame(updateScrollState);
  }, { passive: true });

  pagetop?.addEventListener('click', () => {
    window.scrollTo({
      top: 0,
      behavior: reducedMotionMedia.matches ? 'auto' : 'smooth',
    });
  });

  updateScrollState();
});
