/* ============================================================
   AIパーソナル教育プログラム LP - script.js
   役割:
   1. スクロール連動のフェードイン表示(IntersectionObserver)
   2. カード類の時間差アニメーション
   3. ヘッダーのスクロール時スタイル切替
   4. モバイル追従CTAの表示制御
   ※ prefers-reduced-motion(動きを減らす設定)を尊重します
   ============================================================ */

(function () {
  'use strict';

  var prefersReducedMotion =
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------
     1. スクロール演出(.reveal 要素のフェードイン)
     ------------------------------------------------------------ */
  var revealTargets = document.querySelectorAll('.reveal');

  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    // 動きを減らす設定・非対応ブラウザでは即時表示
    revealTargets.forEach(function (el) {
      el.classList.add('is-inview');
    });
  } else {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-inview');
            observer.unobserve(entry.target); // 一度表示したら監視を解除
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );

    revealTargets.forEach(function (el) {
      observer.observe(el);
    });
  }

  /* ------------------------------------------------------------
     2. カード類の時間差アニメーション
        (同じグリッド内の要素に遅延を割り当て)
     ------------------------------------------------------------ */
  var staggerGroups = document.querySelectorAll(
    '.card-grid, .feature-grid, .worry-list'
  );

  staggerGroups.forEach(function (group) {
    var children = group.querySelectorAll('.reveal');
    children.forEach(function (child, index) {
      // 1枚ごとに 0.08 秒ずらす(最大 0.4 秒)
      var delay = Math.min(index * 0.08, 0.4);
      child.style.setProperty('--stagger', delay + 's');
    });
  });

  /* ------------------------------------------------------------
     3. ヘッダー:スクロール時に下線を表示
     ------------------------------------------------------------ */
  var header = document.getElementById('siteHeader');

  function updateHeader() {
    if (window.scrollY > 10) {
      header.classList.add('is-scrolled');
    } else {
      header.classList.remove('is-scrolled');
    }
  }

  /* ------------------------------------------------------------
     4. モバイル追従CTA:ファーストビューを過ぎたら表示
     ------------------------------------------------------------ */
  var floatingCta = document.getElementById('floatingCta');
  var hero = document.querySelector('.hero');
  var ctaSection = document.getElementById('cta');

  function updateFloatingCta() {
    if (!floatingCta || !hero) return;

    var heroBottom = hero.offsetTop + hero.offsetHeight;
    var passedHero = window.scrollY > heroBottom - 80;

    // 最終CTAセクションが見えている間は重複を避けて隠す
    var nearFinalCta = false;
    if (ctaSection) {
      var rect = ctaSection.getBoundingClientRect();
      nearFinalCta = rect.top < window.innerHeight && rect.bottom > 0;
    }

    floatingCta.classList.toggle('is-visible', passedHero && !nearFinalCta);
  }

  /* ------------------------------------------------------------
     スクロールイベント(requestAnimationFrameで間引き)
     ------------------------------------------------------------ */
  var ticking = false;

  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      updateHeader();
      updateFloatingCta();
      ticking = false;
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  onScroll(); // 初期状態を反映

  /* ------------------------------------------------------------
     5. 申込みボタン(フォーム未設定時の案内)
        公開時は index.html 内の .js-apply の href を
        実際の申込みフォームURLへ差し替えてください。
     ------------------------------------------------------------ */
  document.querySelectorAll('.js-apply').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      var href = btn.getAttribute('href');
      if (!href || href === '#') {
        e.preventDefault();
        alert(
          '申込みフォームのURLが未設定です。\n' +
            'index.html 内の .js-apply の href を、実際のフォームURLに差し替えてください。'
        );
      }
    });
  });
})();
