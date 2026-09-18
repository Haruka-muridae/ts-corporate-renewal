/*
 * POTENITAS INFINITY ファーストビュー「焔から文字が浮かび上がる」演出。
 *
 * 仕様: docs/specs/potenitas-infinity-hero-v1.md
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 時間割が仕様どおり（火の粉 0.4s〜、形成 0.8〜2.0s、サブコピーは +0.3〜0.5s、全体 4s 以内）
 *   - 炎の強さが「100% → 50% → 10% → ほぼ消える」の順で落ち、演出後は 0 になること
 *   - 文字の形成が左 → 右へ進み、ばらつきが窓の外へ出ないこと
 *   - 火の粉の上限（PC 150〜200 / スマホ 50〜80）を超えて生成されないこと
 *   - 火の粉が上向きに動き、寿命切れ・画面外で即座に消えること
 *   - HTML の構造（レイヤー順・aria・reduced-motion・スクロール可）が仕様を満たすこと
 *   - ignite.js がトップレベルで DOM に触らない（この import 自体が通ること）
 * ==================================================================
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';
import {
  TIMELINE,
  PARTICLE_CAP,
  SPARK_COLORS,
  IDLE_SPARK_INTERVAL,
  flameIntensity,
  charDelays,
  charActivity,
  createSparkField,
  sparkRate,
} from '../../public/potenitas/infinity/ignite.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..');
const HTML = readFileSync(join(REPO_ROOT, 'public/potenitas/infinity/index.html'), 'utf8');

/* 決定的な乱数（テストを再現可能にする） */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function near(a, b, eps = 0.02) {
  return Math.abs(a - b) <= eps;
}

try {
  section('時間割（仕様 §4・§10・§11）');
  check('火の粉は 0.4 秒から', TIMELINE.sparksStart === 400);
  check('タイトル形成は 0.8〜2.0 秒', TIMELINE.formStart === 800 && TIMELINE.formEnd === 2000);
  check('サブコピーはタイトル完成の 0.3〜0.5 秒後',
    TIMELINE.leadStart - TIMELINE.formEnd >= 300 && TIMELINE.leadStart - TIMELINE.formEnd <= 500);
  check('サブコピーは約 1 秒', TIMELINE.leadDuration === 1000);
  check('全体は約 4 秒以内に収まる', TIMELINE.settleEnd <= 4000
    && TIMELINE.leadStart + TIMELINE.leadDuration <= TIMELINE.settleEnd);

  section('炎の強さ（仕様 §4・§10）');
  check('0.4 秒までは炎が無い', flameIntensity(0) === 0 && flameIntensity(399) === 0);
  check('1.0〜2.0 秒は 100%', flameIntensity(1000) === 1 && flameIntensity(1500) === 1 && flameIntensity(1999) === 1);
  check('立ち上がりは単調増加', flameIntensity(500) < flameIntensity(700) && flameIntensity(700) < flameIntensity(900));
  check('完成の 0.6 秒後に 50%', near(flameIntensity(2600), 0.5), flameIntensity(2600));
  check('その 0.6 秒後に 10%', near(flameIntensity(3200), 0.1), flameIntensity(3200));
  check('3.8 秒でほぼ消える', flameIntensity(3800) === 0 && flameIntensity(4000) === 0 && flameIntensity(99999) === 0);
  {
    let monotone = true;
    for (let t = 2000; t < 4000; t += 10) if (flameIntensity(t + 10) > flameIntensity(t)) monotone = false;
    check('完成後は一度も強くならない（永遠に燃え続けない）', monotone);
  }

  section('文字の形成順（仕様 §4）');
  {
    const n = 17; // POTENITAS + INFINITY
    const noJitter = charDelays(n, { random: () => 0.5 });
    check('ばらつき無しなら左から右へ単調', noJitter.every((d, i) => i === 0 || d > noJitter[i - 1]));
    check('最初の文字は 0.8 秒に始まる', noJitter[0] === TIMELINE.formStart);
    check('最後の文字は 2.0 秒に完成する', noJitter[n - 1] + TIMELINE.charDuration === TIMELINE.formEnd);

    const jittered = charDelays(n, { random: seeded(7) });
    check('ばらつきがあっても窓 [0.8s, 2.0s - 1文字] の外へ出ない',
      jittered.every((d) => d >= TIMELINE.formStart && d + TIMELINE.charDuration <= TIMELINE.formEnd));
    check('全体としては左 → 右（前半の平均 < 後半の平均）', (() => {
      const half = Math.floor(n / 2);
      const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
      return avg(jittered.slice(0, half)) < avg(jittered.slice(half));
    })());
    check('機械的なワイプにならない（等間隔ではない）', (() => {
      const gaps = jittered.slice(1).map((d, i) => d - jittered[i]);
      return new Set(gaps).size > 1;
    })());
    check('1 文字なら開始時刻のみ', charDelays(1, { random: () => 0.5 })[0] === TIMELINE.formStart);
  }

  section('1 文字の炎の活動量');
  check('形成のかなり前は 0', charActivity(-1000) === 0);
  check('形成中は 1', charActivity(0) === 1 && charActivity(TIMELINE.charDuration) === 1);
  check('完成後は減って 0 になる', charActivity(TIMELINE.charDuration + 300) < 1
    && charActivity(TIMELINE.charDuration + 650) === 0);

  section('火の粉（仕様 §7・§8・§20）');
  check('上限は PC 150〜200', PARTICLE_CAP.desktop >= 150 && PARTICLE_CAP.desktop <= 200);
  check('上限はスマホ 50〜80', PARTICLE_CAP.mobile >= 50 && PARTICLE_CAP.mobile <= 80);
  check('色は指定の 4 色', JSON.stringify(SPARK_COLORS) === JSON.stringify(['#ffffff', '#ffd27a', '#ff9d32', '#ff6200']));
  check('演出後は数秒に 1 粒', IDLE_SPARK_INTERVAL.min >= 2000 && IDLE_SPARK_INTERVAL.max <= 8000);
  {
    const field = createSparkField({ cap: 5, random: seeded(1) });
    for (let i = 0; i < 5; i += 1) check(`生成 ${i + 1} 粒目は受け付ける`, field.spawn(100, 100) === true);
    check('上限を超える生成は拒否される', field.spawn(100, 100) === false && field.count === 5);
    check('速度は上向き（vy < 0）で、左右のばらつきは小さい',
      field.particles.every((p) => p.vy < 0 && Math.abs(p.vx) <= 0.03));
    check('大きさは 1〜6px', field.particles.every((p) => p.size >= 1 && p.size <= 6));
    check('生成時の必須プロパティを持つ', field.particles.every((p) =>
      ['x', 'y', 'vx', 'vy', 'size', 'life', 'maxLife', 'alpha'].every((k) => typeof p[k] === 'number')));

    const y0 = field.particles.map((p) => p.y);
    field.update(100, { width: 1000, height: 1000 });
    check('更新で上へ動く', field.particles.every((p, i) => p.y < y0[i]));
    check('透明度は寿命とともに下がる', field.particles.every((p) => p.alpha < 1 && p.alpha > 0));

    field.update(3000, { width: 1000, height: 1000 });
    check('寿命切れの粒は消える', field.count === 0);

    const edge = createSparkField({ cap: 10, random: seeded(2) });
    /* 最も遅い粒（30px/s）でも 0.5 秒で 15px 上がり、上端の外（-10px）を越える */
    edge.spawn(500, 2);
    edge.update(500, { width: 1000, height: 1000 });
    check('画面外（上端）へ出た粒は即削除される', edge.count === 0);
  }
  check('発生量は強さに比例し、上限の半分/秒を超えない',
    sparkRate(180, 1) === 90 && sparkRate(180, 0.5) === 45 && sparkRate(180, 0) === 0 && sparkRate(180, 2) === 90);

  section('HTML の構造（仕様 §2・§3・§13・§19・§21）');
  const heroIdx = HTML.indexOf('class="hero"');
  const bgIdx = HTML.indexOf('class="hero-background"');
  const canvasIdx = HTML.indexOf('class="fire-particles"');
  const copyIdx = HTML.indexOf('class="hero-copy"');
  check('hero > 背景 > canvas > 文字 の順で重なる', heroIdx > 0 && bgIdx > heroIdx && canvasIdx > bgIdx && copyIdx > canvasIdx);
  check('背景は cover / center / no-repeat',
    /background-size:cover/.test(HTML) && /background-position:center/.test(HTML) && /background-repeat:no-repeat/.test(HTML));
  check('高さは 100svh を基本にする', /min-height:100svh/.test(HTML));
  check('h1 は POTENITAS INFINITY を読み上げに一本化', /<h1 class="hero-title" aria-label="POTENITAS INFINITY">/.test(HTML));
  check('タイトルは 17 文字を 1 文字ずつ span にする', (HTML.match(/<span class="ch">/g) || []).length === 17);
  check('サブコピー「人の可能性を、無限に。」がある', /<p class="hero-lead">人の可能性を、無限に。<\/p>/.test(HTML));
  check('文字は初期状態で透明・blur(10px)', /\.ignite \.hero-title \.ch\{\s*opacity:0;\s*filter:blur\(10px\)/.test(HTML));
  check('形成中の強い発光は指定の text-shadow',
    /--glow-strong:0 0 6px #ffffff, 0 0 12px #ffd27a, 0 0 24px #ff8a00, 0 0 48px rgba\(255,80,0,\.8\)/.test(HTML));
  check('reduced-motion で炎を止める指定がある', /prefers-reduced-motion: reduce/.test(HTML));
  check('演出中もスクロールできる（html/body に overflow:hidden が無い）',
    !/(html|body)\s*\{[^}]*overflow\s*:\s*hidden/.test(HTML));
  check('スマホの文字サイズは clamp(36px, 10vw, 72px)', /clamp\(36px, 10vw, 72px\)/.test(HTML));
  check('スマホのサブコピーは clamp(16px, 4vw, 28px)', /clamp\(16px, 4vw, 28px\)/.test(HTML));
  check('背景画像は事前読込される', /rel="preload" as="image" href="\/potenitas\/infinity\/hero\.jpg"/.test(HTML)
    && /data-hero-image="\/potenitas\/infinity\/hero\.jpg"/.test(HTML));
  check('炎の GIF / 動画を使っていない', !/<video|\.gif/i.test(HTML));
  check('演出は ES モジュールから 1 回だけ起動する', /import \{ mountIgnite \} from "\.\/ignite\.js"/.test(HTML));
  check('JS 無効時に備えて ignite クラスは JS で付ける', /document\.documentElement\.className \+= " ignite"/.test(HTML));

  finish();
} catch (error) {
  fatal(error);
}
