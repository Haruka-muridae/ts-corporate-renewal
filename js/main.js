document.addEventListener('DOMContentLoaded', () => {
  const header = document.getElementById('header');
  const menuToggle = document.getElementById('menu-toggle');
  const globalNav = document.getElementById('global-nav');
  const menuLinks = globalNav.querySelectorAll('a[href]');
  const pagetop = document.getElementById('pagetop');
  const hero = document.getElementById('hero');
  const revealElements = [...document.querySelectorAll('.reveal')];
  const desktopMedia = window.matchMedia('(min-width: 1024px)');
  const reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  let revealObserver = null;

  const showAllRevealElements = () => {
    revealObserver?.disconnect();
    revealObserver = null;
    document.documentElement.classList.remove('reveal-ready');
    revealElements.forEach((element) => {
      element.classList.add('is-visible', 'is-reveal-complete');
    });
  };

  const initializeScrollReveal = () => {
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

        const staggerIndex = Number.parseInt(
          window.getComputedStyle(entry.target).getPropertyValue('--i'),
          10,
        ) || 0;
        const staggerInterval = window.matchMedia('(min-width: 768px)').matches ? 80 : 40;

        entry.target.classList.add('is-visible');
        window.setTimeout(() => {
          entry.target.classList.add('is-reveal-complete');
        }, 600 + (staggerIndex * staggerInterval));
        observer.unobserve(entry.target);
      });
    }, {
      threshold: 0.15,
      rootMargin: '0px 0px -10% 0px',
    });

    revealElements.forEach((element) => revealObserver.observe(element));
  };

  if (reducedMotionMedia.matches) {
    hero.classList.add('is-motion-reduced');
  } else {
    window.requestAnimationFrame(() => {
      hero.classList.add('is-animated');
    });
  }

  initializeScrollReveal();

  reducedMotionMedia.addEventListener('change', (event) => {
    if (!event.matches) {
      hero.classList.remove('is-motion-reduced');
      return;
    }

    hero.classList.remove('is-animated');
    hero.classList.add('is-motion-reduced');
    showAllRevealElements();
  });

  const memberDetails = document.querySelectorAll('.member-details');

  memberDetails.forEach((details) => {
    const summary = details.querySelector('summary');

    if (!summary) {
      return;
    }

    const syncDetailsState = () => {
      const isOpen = details.open;

      details.classList.toggle('is-open', isOpen);
      summary.setAttribute('aria-expanded', String(isOpen));
    };

    syncDetailsState();
    details.addEventListener('toggle', syncDetailsState);
  });

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
    if (desktopMedia.matches) {
      closeMenu(false);
      globalNav.removeAttribute('aria-hidden');
      return;
    }

    closeMenu(false);
  };

  menuToggle.addEventListener('click', () => {
    if (isMenuOpen()) {
      closeMenu();
      return;
    }

    openMenu();
  });

  menuLinks.forEach((link) => {
    link.addEventListener('click', () => {
      if (!desktopMedia.matches && isMenuOpen()) {
        closeMenu();
      }
    });
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

  let scrollTicking = false;

  const updateScrollState = () => {
    const scrollPosition = window.scrollY;
    const showPagetop = scrollPosition > 600;

    header.classList.toggle('is-scrolled', scrollPosition > 80);
    pagetop.classList.toggle('is-visible', showPagetop);
    pagetop.setAttribute('aria-hidden', String(!showPagetop));
    pagetop.tabIndex = showPagetop ? 0 : -1;
    scrollTicking = false;
  };

  window.addEventListener('scroll', () => {
    if (scrollTicking) {
      return;
    }

    scrollTicking = true;
    window.requestAnimationFrame(updateScrollState);
  }, { passive: true });

  pagetop.addEventListener('click', () => {
    window.scrollTo({
      top: 0,
      behavior: reducedMotionMedia.matches ? 'auto' : 'smooth',
    });
  });

  updateScrollState();
});
