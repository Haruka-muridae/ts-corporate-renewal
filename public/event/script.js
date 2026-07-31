/*
 * 交流会ページ専用スクリプト。
 * ../js/main.js はトップページのHero要素を前提とするため、
 * このページでは必要な挙動のみを独立して実装する。
 * 各要素は存在しない場合を考慮し、処理をスキップする。
 */

/* =========================
   受付状態の切り替え方法
   =========================

   1. index.html の #event-status にある data-event-status を書き換える。
      "preparing" … 準備中（申込ボタンは押せない）
      "open"      … 受付中（APPLY_URL が設定されていれば申込ボタンが有効になる）
      "full"      … 申込状況による受付終了（申込ボタンは押せない）
      "closed"    … 受付期間の終了（申込ボタンは押せない）
   2. 申込フォームを実装したら、下の APPLY_URL に相対パスを入れる。
      null のままなら、data-event-status が "open" でもボタンは無効のままにする。
      リンク先が無い状態で押せるボタンを出さないための保険。
   3. 開催日時・会場・申込期間は index.html に直接記載する。
      開催日時は index.html の「開催概要」内 1 箇所にのみ書き、
      他の箇所では日付・時刻を繰り返さない（次回開催時の編集を1箇所で済ませるため）。
*/
const APPLY_URL = null;

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

  /* ---------- Application status ---------- */

  const statusElement = document.getElementById('event-status');
  const statusBadge = document.getElementById('event-status-badge');
  const statusText = document.getElementById('event-status-text');
  const applyButton = document.getElementById('apply-button');
  const applyNote = document.getElementById('apply-note');

  /* 未知の値が入っていても表示が壊れないよう preparing へ寄せる。 */
  const statusKey = statusElement?.dataset.eventStatus ?? 'preparing';
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
    const canApply = statusKey === 'open' && typeof APPLY_URL === 'string' && APPLY_URL !== '';
    applyButton.disabled = !canApply;

    if (canApply) {
      applyButton.addEventListener('click', () => {
        window.location.href = APPLY_URL;
      });
    }
  }

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
