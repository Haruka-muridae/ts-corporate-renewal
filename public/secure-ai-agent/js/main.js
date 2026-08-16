/*
 * このLPのクライアント処理は2つだけ。
 *   1. スクロールに応じた Fade Up の表示制御
 *      （public/labs/ai-corporate-training/js/main.js を複製したもの）
 *   2. 問い合わせフォームの送信
 *
 * ------------------------------------------------------------------
 * 設計の前提
 * ------------------------------------------------------------------
 * - 要素を隠しているのは CSS の `.js .reveal` で、`.js` は index.html の
 *   <head> で付けている。したがって JavaScript が動かない環境では
 *   何も隠れず、本文は最初から読める。
 * - 一度表示した要素は監視をやめる。行きつ戻りつで再生し直さない。
 * - 「動きを減らす」設定のときは監視自体を行わず、その場で表示する。
 * - フォームは fetch で JSON を送る。JS が動かない環境では送信できないため、
 *   フォーム直下に mailto の代替導線を常設している（index.html 側）。
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  /* ----------------------------------------------------------------
   * 1. スクロール表示（Fade Up）
   * ---------------------------------------------------------------- */
  var targets = document.querySelectorAll('.reveal');

  function showAll() {
    Array.prototype.forEach.call(targets, function (el) {
      el.classList.add('is-visible');
    });
  }

  var prefersReducedMotion =
    typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (targets.length > 0) {
    /*
     * IntersectionObserver が無い環境では、隠したまま取り残すほうが害が大きい。
     * 演出をあきらめて全部出す。
     */
    if (prefersReducedMotion || !('IntersectionObserver' in window)) {
      showAll();
    } else {
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
    }
  }

  /* ----------------------------------------------------------------
   * 2. 問い合わせフォーム
   * ----------------------------------------------------------------
   * 送信先は Next.js のルートハンドラ。trailingSlash: true のため
   * 末尾スラッシュを外さないこと（外すと 308 になり POST 本文が落ちる）。
   * ---------------------------------------------------------------- */
  var ENDPOINT = '/secure-ai-agent/api/contact/';

  var form = document.getElementById('contact-form');
  var submitButton = document.getElementById('cf-submit');
  var status = document.getElementById('cf-status');

  if (!form || !submitButton || !status) {
    return;
  }

  function setStatus(message) {
    status.textContent = message;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    /*
     * novalidate を付けているため、必須チェックはここで行う。
     * ブラウザ既定の吹き出しではなく、ステータス欄で日本語の文言を出すため。
     */
    var company = form.elements.company.value.trim();
    var name = form.elements.name.value.trim();
    var email = form.elements.email.value.trim();

    if (company === '' || name === '' || email === '') {
      setStatus('会社名・担当者名・メールアドレスは必須です。');
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus('メールアドレスの形式を確認してください。');
      return;
    }

    var services = [];
    Array.prototype.forEach.call(
      form.querySelectorAll('input[name="services"]:checked'),
      function (input) {
        services.push(input.value);
      }
    );

    var payload = {
      company: company,
      name: name,
      email: email,
      aiPreference: form.elements.aiPreference.value,
      services: services,
      tasks: form.elements.tasks.value.trim(),
      challenges: form.elements.challenges.value.trim(),
      timing: form.elements.timing.value,
      /* honeypot。人間なら空のまま。 */
      website: form.elements.website.value,
    };

    /* 二重送信を防ぐ。応答が返るまで押せない。 */
    submitButton.disabled = true;
    setStatus('送信しています…');

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }

        return response.json();
      })
      .then(function () {
        /*
         * 送信済みのフォームを残すと再送を誘うため、成功したら畳む。
         * 文言はステータス欄（aria-live）で読み上げにも届く。
         */
        form.reset();
        submitButton.disabled = false;
        setStatus('送信しました。内容を確認のうえ、担当よりご連絡します。');
      })
      .catch(function () {
        /*
         * 失敗の内訳（ネットワーク断・検証エラー・サーバー障害）を
         * 利用者が切り分ける必要はない。代替の連絡手段だけ示す。
         */
        submitButton.disabled = false;
        setStatus('送信できませんでした。時間をおいて再度お試しいただくか、ページ下部のメールアドレスへ直接ご連絡ください。');
      });
  });
})();
