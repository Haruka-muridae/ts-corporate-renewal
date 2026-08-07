/*
 * スクロールに応じた Fade Up の表示制御。このファイルの役割はこれだけ。
 *
 * ------------------------------------------------------------------
 * 設計の前提
 * ------------------------------------------------------------------
 * - 要素を隠しているのは CSS の `.js .reveal` で、`.js` は index.html の
 *   <head> で付けている。したがって JavaScript が動かない環境では
 *   何も隠れず、本文は最初から読める。
 * - 一度表示した要素は監視をやめる。行きつ戻りつで再生し直さない。
 * - 「動きを減らす」設定のときは監視自体を行わず、その場で表示する。
 *   CSS 側でも打ち消しているが、こちらでも止めて二重に担保する。
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  var targets = document.querySelectorAll('.reveal');

  if (targets.length === 0) {
    return;
  }

  function showAll() {
    Array.prototype.forEach.call(targets, function (el) {
      el.classList.add('is-visible');
    });
  }

  var prefersReducedMotion =
    typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /*
   * IntersectionObserver が無い環境では、隠したまま取り残すほうが害が大きい。
   * 演出をあきらめて全部出す。
   */
  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    showAll();
    return;
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) {
          return;
        }

        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    },
    {
      /* 画面に入りきる少し手前で出す。下端ぎりぎりでの発火を避ける。 */
      rootMargin: '0px 0px -10% 0px',
      threshold: 0.1,
    }
  );

  Array.prototype.forEach.call(targets, function (el) {
    observer.observe(el);
  });
})();
