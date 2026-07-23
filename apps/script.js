/*
 * AIアプリ一覧ページ専用スクリプト。
 * ../js/main.js はトップページのHero要素を前提とするため、
 * このページでは必要な挙動のみを独立して実装する。
 * 各要素は存在しない場合を考慮し、処理をスキップする。
 */

/* =========================
   アプリ追加方法
   =========================

   1. 下の APPS 配列の末尾に { } を1件追加する。HTMLを編集する必要はない。
   2. name（アプリ名）と description（説明文）は必須。tags は任意の文字列配列。
   3. status は "coming"（準備中）、"beta"（ベータ版）、"public"（公開中）のいずれか。
      status を書き換えるだけで、バッジの文言と配色が切り替わる。
   4. url は未公開なら null。URLを入れると「アプリを開く」リンクが自動で表示される。
      http:// または https:// で始まるURLは、自動的に別タブで開く。
   5. icon は ICONS のキー名（app / mic / receipt / contract）。
      未登録の名前を書いても app が使われるため、表示が壊れることはない。

   カードの通し番号（01, 02, ...）と表示順は、配列の並び順から自動で決まる。
   実績、提供時期、数値などの確定していない情報は記載しない。
*/
const APPS = [
  {
    name: '音声録音・MP3変換アプリ',
    description: '音声を録音し、MP3形式のファイルに変換するアプリです。',
    status: 'coming',
    url: null,
    tags: ['音声録音', 'MP3変換'],
    icon: 'mic',
  },
  {
    name: '領収書・収支管理システム',
    description: '領収書を登録し、収入と支出をまとめて管理するシステムです。',
    status: 'coming',
    url: null,
    tags: ['領収書', '収支管理'],
    icon: 'receipt',
  },
  {
    name: '電子契約書作成アプリ',
    description: '電子契約書を作成するアプリです。',
    status: 'coming',
    url: null,
    tags: ['電子契約', '書類作成'],
    icon: 'contract',
  },
];

/*
 * ステータスの定義。
 * key   … APPS の status に指定する値
 * label … カードに表示する文言
 * 配色は style.css の .app-card__status--<key> で定義する。
 */
const STATUSES = {
  coming: { label: '準備中' },
  beta: { label: 'ベータ版' },
  public: { label: '公開中' },
};

const DEFAULT_STATUS = 'coming';

/*
 * カードのアイコン。viewBox は 24x24 に統一する。
 * 追加するときは、このオブジェクトにキーとSVGの中身を足す。
 */
const ICONS = {
  app: '<rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M8 8h8M8 12h8M8 16h4"></path>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"></path>',
  receipt: '<path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21z"></path><path d="M9 8h6M9 12h6M9 16h3"></path>',
  contract: '<path d="M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h4"></path><path d="M13 3l4 4h-4z"></path><path d="M9 9h2M9 13h3"></path><path d="M20 13l-6 6-3 1 1-3 6-6a1.414 1.414 0 0 1 2 2z"></path>',
};

const DEFAULT_ICON = 'app';
const SVG_NS = 'http://www.w3.org/2000/svg';
const EXTERNAL_URL_PATTERN = /^https?:\/\//i;

document.addEventListener('DOMContentLoaded', () => {
  const header = document.getElementById('header');
  const menuToggle = document.getElementById('menu-toggle');
  const globalNav = document.getElementById('global-nav');
  const pagetop = document.getElementById('pagetop');
  const appsGrid = document.getElementById('apps-grid');
  const desktopMedia = window.matchMedia('(min-width: 1024px)');
  const reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  let revealObserver = null;

  /* ---------- App cards ---------- */

  const createElement = (tagName, className, text) => {
    const element = document.createElement(tagName);

    if (className) {
      element.className = className;
    }

    if (text !== undefined) {
      element.textContent = text;
    }

    return element;
  };

  /* 未定義のキーを指定されても既定値へ寄せ、描画を止めない。 */
  const resolveStatus = (status) => (
    Object.hasOwn(STATUSES, status) ? status : DEFAULT_STATUS
  );

  const resolveIcon = (icon) => (
    Object.hasOwn(ICONS, icon) ? ICONS[icon] : ICONS[DEFAULT_ICON]
  );

  const createAppCard = (app, index) => {
    const item = document.createElement('li');
    item.style.setProperty('--i', String(index));

    const statusKey = resolveStatus(app.status);
    const card = createElement('article', `app-card app-card--${statusKey} reveal`);
    /* リビールの遅延はここから読む。getComputedStyleによる再計算を避ける。 */
    card.dataset.stagger = String(index);

    const top = createElement('div', 'app-card__top');
    const number = createElement('span', 'app-card__num', String(index + 1).padStart(2, '0'));
    /* 通し番号は装飾。リスト位置は ul/li から伝わるため読み上げない。 */
    number.setAttribute('aria-hidden', 'true');
    top.append(number);

    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('class', 'app-card__icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    /* 挿入元はこのファイル内の ICONS 定数のみ。外部入力は渡さない。 */
    icon.innerHTML = resolveIcon(app.icon);
    top.append(icon);

    card.append(top);
    card.append(createElement(
      'p',
      `app-card__status app-card__status--${statusKey}`,
      STATUSES[statusKey].label,
    ));
    card.append(createElement('h3', 'app-card__title', app.name));

    if (app.nameEn) {
      const nameEn = createElement('p', 'app-card__name-en', app.nameEn);
      nameEn.setAttribute('lang', 'en');
      card.append(nameEn);
    }

    card.append(createElement('p', 'app-card__text', app.description));

    if (app.tags?.length) {
      const tags = createElement('ul', 'app-card__tags');
      app.tags.forEach((tag) => tags.append(createElement('li', null, tag)));
      card.append(tags);
    }

    if (app.url) {
      const isExternal = EXTERNAL_URL_PATTERN.test(app.url);
      const action = createElement('p', 'app-card__action');
      const link = createElement('a', 'app-card__link', 'アプリを開く');

      link.href = app.url;

      if (isExternal) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }

      /*
       * 「アプリを開く」だけではリンクの区別がつかないため、
       * アプリ名と別タブで開く旨を読み上げ専用テキストで補う。
       */
      link.append(createElement(
        'span',
        'apps-visually-hidden',
        `：${app.name}${isExternal ? '（新しいタブで開きます）' : ''}`,
      ));

      action.append(link);
      card.append(action);
      card.classList.add('has-link');
    }

    item.append(card);

    return item;
  };

  const renderApps = () => {
    if (!appsGrid) {
      return;
    }

    if (!APPS.length) {
      const empty = createElement(
        'li',
        'apps-empty',
        '公開中のアプリはありません。準備が整い次第、このページに掲載します。',
      );
      appsGrid.replaceChildren(empty);
      return;
    }

    /* 件数が増えても再描画は1回で済むよう、フラグメントにまとめて追加する。 */
    const fragment = document.createDocumentFragment();
    APPS.forEach((app, index) => fragment.append(createAppCard(app, index)));
    appsGrid.replaceChildren(fragment);
  };

  renderApps();

  /* ---------- Scroll reveal ---------- */

  /* カード生成後に取得する。 */
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
      const staggerInterval = window.matchMedia('(min-width: 768px)').matches ? 80 : 40;

      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }

        const staggerIndex = Number.parseInt(entry.target.dataset.stagger ?? '', 10) || 0;

        entry.target.classList.add('is-visible');
        window.setTimeout(() => {
          entry.target.classList.add('is-reveal-complete');
        }, 600 + (staggerIndex * staggerInterval));
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
