document.addEventListener('DOMContentLoaded', () => {
  const header = document.getElementById('header');
  const menuToggle = document.getElementById('menu-toggle');
  const globalNav = document.getElementById('global-nav');
  const menuLinks = globalNav.querySelectorAll('a[href]');
  const pagetop = document.getElementById('pagetop');
  const desktopMedia = window.matchMedia('(min-width: 1024px)');
  const reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');

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
