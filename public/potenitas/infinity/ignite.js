/*
 * POTENITAS INFINITY ファーストビュー「焔から文字が浮かび上がる」演出。
 * 仕様: docs/specs/potenitas-infinity-hero-v1.md
 *
 * ==================================================================
 * 構成
 * ==================================================================
 *   前半 … 時間割・炎の強さ・火の粉（Particle）の純粋なロジック。
 *          DOM に触らないので、Node のテスト（tests/unit/potenitas-infinity.mjs）
 *          からそのまま import できる。
 *   後半 … mountIgnite(): 上のロジックを Canvas 2D と CSS クラスに結びつける。
 *
 * トップレベルで document / window に触らないこと（テストが壊れる）。
 *
 * ==================================================================
 * 採らなかった選択肢
 * ==================================================================
 *   - Three.js / WebGL … LP の表現としては Canvas 2D で足り、スマホの負荷と
 *     実装量が過剰になるため現段階では入れない（仕様 §6）。
 *   - 炎の GIF / 動画の重ね貼り … 仕様 §21 で禁止。
 *   - 文字を左から右へ clip-path でワイプ … 機械的に見えるため、文字ごとに
 *     ばらつきのある遅延を与えて「炎の揺らぎで不規則に形成される」ようにした（§4）。
 * ==================================================================
 */

/* ------------------------------------------------------------------
 * 時間割（ms）。仕様 §4・§10・§11・§12 の数字をここに集約する。
 * ------------------------------------------------------------------ */
export const TIMELINE = Object.freeze({
  glowStart: 0,        // 背景のみ。画面中央付近にごく弱いオレンジの光
  sparksStart: 400,    // 火の粉が出始める
  formStart: 800,      // タイトルの形成が左端から始まる
  formEnd: 2000,       // タイトル完成（演出のピーク）
  charDuration: 450,   // 1 文字が「炎 → 金 → 白金」になるまで
  leadStart: 2400,     // サブコピー開始（タイトル完成から 0.4 秒遅れ）
  leadDuration: 1000,
  settleEnd: 4000,     // 炎がほぼ消え、通常状態へ
});

/* 火の粉の上限。PC 150〜200 / スマホ 50〜80 の目安（仕様 §20）。 */
export const PARTICLE_CAP = Object.freeze({ desktop: 180, mobile: 70 });

/* 火の粉の色（仕様 §8）。 */
export const SPARK_COLORS = Object.freeze(['#ffffff', '#ffd27a', '#ff9d32', '#ff6200']);

/* 仕様 §12: 演出後は数秒に 1 粒だけ流す。 */
export const IDLE_SPARK_INTERVAL = Object.freeze({ min: 3000, max: 6000 });

function lerp(a, b, ratio) {
  return a + (b - a) * ratio;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 炎（火の粉の発生量と揺らぎ）の強さ 0〜1。
 *
 * 仕様 §10 の「100% → 50% → 10% → ほぼ消える」を、完成（2.0s）から
 * 0.6 秒ずつの 3 段で下ろす。4.0s で 0 になり、以後は idle（§12）だけ。
 */
export function flameIntensity(t) {
  const { sparksStart, formEnd, settleEnd } = TIMELINE;
  if (t < sparksStart) return 0;
  if (t < 1000) return (t - sparksStart) / (1000 - sparksStart);
  if (t < formEnd) return 1;
  const step = (settleEnd - formEnd - 200) / 3; // 600ms × 3 段、最後の 200ms は余白
  const s1 = formEnd + step;
  const s2 = s1 + step;
  const s3 = s2 + step;
  if (t < s1) return lerp(1, 0.5, (t - formEnd) / step);
  if (t < s2) return lerp(0.5, 0.1, (t - s1) / step);
  if (t < s3) return lerp(0.1, 0, (t - s2) / step);
  return 0;
}

/**
 * 各文字の形成開始時刻（ms）。
 *
 * 左 → 右へ等間隔に並べたうえで ±jitter のばらつきを足す。最後の文字が
 * formEnd で完成するよう、開始は [formStart, formEnd - charDuration] に収める。
 * jitter は文字間隔より大きいので、隣同士の順序は入れ替わりうる（意図どおり）。
 */
export function charDelays(count, options = {}) {
  const {
    start = TIMELINE.formStart,
    end = TIMELINE.formEnd,
    charDuration = TIMELINE.charDuration,
    jitter = 110,
    random = Math.random,
  } = options;

  const lastStart = end - charDuration;
  const spread = Math.max(0, lastStart - start);
  const delays = [];
  for (let i = 0; i < count; i += 1) {
    const base = count <= 1 ? start : start + (spread * i) / (count - 1);
    const offset = (random() * 2 - 1) * jitter;
    delays.push(Math.round(clamp(base + offset, start, lastStart)));
  }
  return delays;
}

/**
 * 1 文字ぶんの炎の活動量 0〜1。sinceStart は「その文字の形成開始からの経過」。
 * 直前 250ms で立ち上がり、形成中は最大、完成後 650ms かけて収まる。
 */
export function charActivity(sinceStart, charDuration = TIMELINE.charDuration) {
  if (sinceStart < -250) return 0;
  if (sinceStart < 0) return (sinceStart + 250) / 250;
  if (sinceStart <= charDuration) return 1;
  const tail = sinceStart - charDuration;
  return tail >= 650 ? 0 : 1 - tail / 650;
}

/**
 * 火の粉の集合。
 *
 * 位置と速度の単位は px と px/ms。update() には経過 ms と描画領域を渡す。
 * 上限（cap）を超える生成は拒否し、寿命切れ・画面外の粒は即座に捨てる（§20）。
 */
export function createSparkField({ cap, random = Math.random } = {}) {
  const particles = [];
  const limit = Number.isFinite(cap) ? cap : PARTICLE_CAP.desktop;

  function spawn(x, y, options = {}) {
    if (particles.length >= limit) return false;
    const { scale = 1, dim = 1 } = options;
    const bright = random() < 0.12;
    particles.push({
      x,
      y,
      // 基本は真上（↑）。左右に ±25px/s 程度散らして ↖ ↑ ↗ のばらつきにする。
      vx: (random() - 0.5) * 0.05 * scale,
      vy: -(0.03 + random() * 0.06) * scale,
      size: bright ? 5 + random() : 1 + random() * 3,
      bright,
      life: 0,
      maxLife: 700 + random() * 900,
      alpha: dim,
      dim,
      color: SPARK_COLORS[Math.floor(random() * SPARK_COLORS.length)],
      wobblePhase: random() * Math.PI * 2,
      wobbleFreq: 0.004 + random() * 0.006,
    });
    return true;
  }

  function update(dt, bounds) {
    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const p = particles[i];
      p.life += dt;
      const wobble = Math.sin(p.life * p.wobbleFreq + p.wobblePhase) * 0.012;
      p.x += (p.vx + wobble) * dt;
      p.y += p.vy * dt;
      const ratio = p.life / p.maxLife;
      p.alpha = p.dim * Math.max(0, 1 - ratio * ratio);
      const gone = p.life >= p.maxLife
        || p.x < -10 || p.x > bounds.width + 10
        || p.y < -10 || p.y > bounds.height + 10;
      if (gone) particles.splice(i, 1);
    }
  }

  return {
    particles,
    spawn,
    update,
    get count() { return particles.length; },
    get cap() { return limit; },
  };
}

/**
 * 発生量（粒/秒）。上限の半分を毎秒出す程度が「上品な火の粉」の目安。
 * intensity は flameIntensity() の値。
 */
export function sparkRate(cap, intensity) {
  return (cap / 2) * clamp(intensity, 0, 1);
}

/* ==================================================================
 * ここから DOM。mountIgnite(hero) を index.html から 1 回だけ呼ぶ。
 * ================================================================== */

function preloadImage(win, src) {
  return new Promise((resolve) => {
    if (!src) { resolve(false); return; }
    const img = new win.Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

/* Web フォントが後から効くと文字の実測位置がずれるため fonts.ready を待つ（上限 1.5 秒）。 */
function fontsReady(doc, win, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (doc.fonts && doc.fonts.ready && doc.fonts.ready.then) doc.fonts.ready.then(finish);
    else finish();
    win.setTimeout(finish, timeout);
  });
}

/**
 * @param {HTMLElement} hero  .hero セクション
 * @param {object} [options]
 * @param {number} [options.imageTimeout] 背景画像を待つ上限 ms（既定 10 秒）
 */
export function mountIgnite(hero, options = {}) {
  const doc = hero.ownerDocument;
  const win = doc.defaultView;
  const root = doc.documentElement;
  const canvas = hero.querySelector('.fire-particles');
  const chars = Array.prototype.slice.call(hero.querySelectorAll('.hero-title .ch'));
  const lead = hero.querySelector('.hero-lead');
  const imageSrc = hero.getAttribute('data-hero-image');
  const imageTimeout = options.imageTimeout ?? 10000;

  const reduced = !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const mobile = !!(win.matchMedia && win.matchMedia('(max-width: 767px), (pointer: coarse)').matches);

  /* 仕様 §18: 背景が読み込まれる前に炎だけ出さない。
     ただし画像が極端に遅い・落ちている場合に文字が永遠に出ないのは避けたいので、
     上限時間で打ち切って続行する（その場合は CSS のフォールバック背景が見える）。 */
  const imageReady = Promise.race([
    preloadImage(win, imageSrc),
    new Promise((resolve) => win.setTimeout(() => resolve(false), imageTimeout)),
  ]);

  Promise.all([imageReady, fontsReady(doc, win, 1500)]).then(([loaded]) => {
    hero.classList.add(loaded ? 'is-loaded' : 'is-fallback');
    if (reduced || !canvas || chars.length === 0 || !canvas.getContext) {
      /* 仕様 §19: 炎なしで背景・タイトル・サブコピーを通常のフェードインにする */
      hero.classList.add('is-static');
      return;
    }
    play();
  });

  function play() {
    const ctx = canvas.getContext('2d');
    const cap = mobile ? PARTICLE_CAP.mobile : PARTICLE_CAP.desktop;
    const field = createSparkField({ cap });
    const delays = charDelays(chars.length);
    const licksPerChar = mobile ? 2 : 3;

    chars.forEach((el, i) => { el.style.setProperty('--d', `${delays[i]}ms`); });

    let rects = [];
    let leadRect = null;
    let width = 0;
    let height = 0;

    function measure() {
      const dpr = Math.min(win.devicePixelRatio || 1, mobile ? 1.5 : 2);
      const box = hero.getBoundingClientRect();
      width = Math.max(1, Math.round(box.width));
      height = Math.max(1, Math.round(box.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rects = chars.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height, bottom: r.bottom - box.top };
      });
      if (lead) {
        const r = lead.getBoundingClientRect();
        leadRect = { left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height, bottom: r.bottom - box.top };
      }
    }

    /* 火の粉の発生元を選ぶ。形成中の文字ほど選ばれやすく、形成前は全体から薄く出る。 */
    function pickEmitter(t) {
      let total = 0;
      const weights = rects.map((_, i) => {
        const w = 0.15 + charActivity(t - delays[i]);
        total += w;
        return w;
      });
      let r = Math.random() * total;
      for (let i = 0; i < weights.length; i += 1) {
        r -= weights[i];
        if (r <= 0) return rects[i];
      }
      return rects[rects.length - 1];
    }

    function spawnFrom(rect, opts) {
      if (!rect) return;
      /* 特に文字の下部から（仕様 §7）。 */
      const x = rect.left + Math.random() * rect.width;
      const y = rect.bottom - Math.random() * rect.height * 0.35;
      field.spawn(x, y, opts);
    }

    function drawLicks(t, intensity) {
      if (intensity <= 0) return;
      ctx.globalCompositeOperation = 'lighter';
      rects.forEach((rect, i) => {
        const since = t - delays[i];
        const formed = since > 0 ? 0.35 : 0;
        const strength = intensity * Math.max(formed, charActivity(since));
        if (strength <= 0.01) return;
        for (let j = 0; j < licksPerChar; j += 1) {
          const xFrac = 0.2 + 0.6 * ((j + 0.5) / licksPerChar) + 0.1 * Math.sin(t / 150 + j * 2.1 + i * 0.9);
          const flicker = 0.5 + 0.5 * Math.sin(t / 60 + j * 1.7 + i * 0.5);
          /* 炎の高さは文字高の 10〜25%（仕様 §9） */
          const h = rect.height * (0.10 + 0.15 * flicker) * strength;
          const x = rect.left + rect.width * xFrac;
          const baseY = rect.bottom - rect.height * 0.08;
          ctx.save();
          ctx.translate(x, baseY);
          ctx.scale(0.45, 1);
          const g = ctx.createRadialGradient(0, -h * 0.5, 0, 0, -h * 0.5, Math.max(h, 2));
          g.addColorStop(0, `rgba(255,190,90,${0.45 * strength})`);
          g.addColorStop(0.4, `rgba(255,110,0,${0.25 * strength})`);
          g.addColorStop(1, 'rgba(255,60,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(0, -h * 0.5, Math.max(h, 2), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawSparks() {
      ctx.globalCompositeOperation = 'lighter';
      field.particles.forEach((p) => {
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
        if (p.bright) {
          ctx.globalAlpha = p.alpha * 0.25;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      });
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    let raf = 0;
    let idleTimer = 0;
    let last = 0;
    let acc = 0;      // 発生量の端数（粒/ms の積み残し）
    let leadAcc = 0;
    let done = false;
    let hidden = false;
    let visible = true;
    const t0 = win.performance.now();

    function frame(now) {
      raf = 0;
      const t = now - t0;
      const dt = Math.min(48, last ? now - last : 16);
      last = now;

      if (!done) {
        const intensity = flameIntensity(t);
        acc += (sparkRate(cap, intensity) / 1000) * dt;
        while (acc >= 1) { spawnFrom(pickEmitter(t)); acc -= 1; }

        /* サブコピーは小さな火の粉だけ（仕様 §11）。開始から 0.5 秒だけ、低い量で。 */
        if (leadRect && t >= TIMELINE.leadStart && t < TIMELINE.leadStart + 500) {
          leadAcc += (8 / 1000) * dt;
          while (leadAcc >= 1) { spawnFrom(leadRect, { scale: 0.6, dim: 0.6 }); leadAcc -= 1; }
        }

        if (t >= TIMELINE.formEnd + 200) hero.classList.add('is-settled');
        if (t >= TIMELINE.settleEnd) {
          done = true;
          hero.classList.add('is-done');
          scheduleIdleSpark();
        }
      }

      field.update(dt, { width, height });
      ctx.clearRect(0, 0, width, height);
      if (!done) drawLicks(t, flameIntensity(t));
      drawSparks();

      /* 演出後は粒が残っている間だけ描く（バッテリー配慮、仕様 §20） */
      if (!done || field.count > 0) raf = win.requestAnimationFrame(frame);
      else last = 0;
    }

    function ensureLoop() {
      if (!raf && !hidden) { last = 0; raf = win.requestAnimationFrame(frame); }
    }

    function scheduleIdleSpark() {
      win.clearTimeout(idleTimer);
      if (hidden || !visible) return;
      const wait = IDLE_SPARK_INTERVAL.min + Math.random() * (IDLE_SPARK_INTERVAL.max - IDLE_SPARK_INTERVAL.min);
      idleTimer = win.setTimeout(() => {
        spawnFrom(rects[Math.floor(Math.random() * rects.length)], { dim: 0.8 });
        ensureLoop();
        scheduleIdleSpark();
      }, wait);
    }

    /* タブが隠れている間・ヒーローが画面外の間は止める */
    doc.addEventListener('visibilitychange', () => {
      hidden = doc.visibilityState === 'hidden';
      if (hidden) {
        if (raf) { win.cancelAnimationFrame(raf); raf = 0; }
        win.clearTimeout(idleTimer);
      } else {
        ensureLoop();
        if (done) scheduleIdleSpark();
      }
    });
    if (win.IntersectionObserver) {
      new win.IntersectionObserver((entries) => {
        visible = entries.some((e) => e.isIntersecting);
        if (done) {
          if (visible) scheduleIdleSpark();
          else win.clearTimeout(idleTimer);
        }
      }).observe(hero);
    }

    let resizeTimer = 0;
    win.addEventListener('resize', () => {
      win.clearTimeout(resizeTimer);
      resizeTimer = win.setTimeout(measure, 120);
    });

    measure();
    hero.classList.add('is-playing');
    root.classList.add('is-igniting');
    ensureLoop();
  }
}
