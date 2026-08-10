/*
 * スマホ完結版 体験試作(M1)のエントリ。
 * docs/specs/short-script-mobile-video-plan-v1.md §5。
 *
 * ==================================================================
 * 画面の出し方(../app.js と同じ約束)
 * ==================================================================
 *   1. setScreenDepth(3) … mobile-lab/ は ../help/ と同じ深さ(ルートから3階層)。
 *   2. guardPage() が利用者を返すまで中身(#ml-content)を出さない。
 *   3. innerHTML は使わない。すべて textContent / DOM API で組み立てる。
 * ==================================================================
 *
 * ==================================================================
 * 未解決事項(正直に書く)
 * ==================================================================
 * つくよみちゃんONNXモデルは Hugging Face 経由でしか配布されておらず、
 * この試作の作成環境では huggingface.co への通信が組織ポリシーで
 * 全面遮断されていたため取得できなかった(vendor/vendor-manifest.json の
 * tsukuyomi.model / tsukuyomi.model-config が unavailable:true)。
 * 「手順2: 音声を作る」以降のコードは実装済みだが、実機での動作確認は
 * 未実施。モデルを配置すればそのまま動く設計にしてある。
 * ==================================================================
 */

import { guardPage } from '../../../auth/session.js';
import { setScreenDepth } from '../../../auth/config.js';
import { buildAss } from './subtitle.mjs';
import {
  parseManifest,
  findAsset,
  totalDownloadBytes,
  unavailableAssets,
  formatMegabytes,
  prepareAllAssets,
  getVerifiedAssetBytes,
  getVerifiedAssetBlobUrl,
} from './vendor-loader.mjs';
import { selectRoute, negotiateResolution, ROUTE_FAST, ROUTE_UNSUPPORTED } from './route-selection.mjs';
import { computeSceneTimeline, kenBurnsScaleForFrame, frameCountForDuration } from './timeline.mjs';

setScreenDepth(3);

/* ---------- 固定の台本(3シーン・合計約30秒相当) ---------- */

const FIXED_SCRIPT = {
  title: 'スマホだけで動画ができるまで',
  scenes: [
    { text: 'パソコンがなくても、スマホだけでショート動画が作れたら便利だと思いませんか。' },
    { text: '台本を作ったら、あとはボタン一つ。声も字幕も、この画面の中だけで仕上がります。' },
    { text: 'できあがった動画は、そのまま写真アプリへ保存できます。試してみましょう。' },
  ],
};

/* ---------- DOM ---------- */

const el = (id) => document.getElementById(id);

const dom = {
  loading: el('ml-loading'),
  content: el('ml-content'),
  scenesList: el('ml-script-scenes'),
  prepareSize: el('ml-prepare-size'),
  unavailable: el('ml-unavailable'),
  prepareBtn: el('ml-prepare'),
  prepareProgress: el('ml-prepare-progress'),
  prepareStatus: el('ml-prepare-status'),
  synthesizeBtn: el('ml-synthesize'),
  synthesizeStatus: el('ml-synthesize-status'),
  audio: el('ml-audio'),
  routeStatus: el('ml-route-status'),
  renderBtn: el('ml-render'),
  renderStatus: el('ml-render-status'),
  wakeLockStatus: el('ml-wake-lock-status'),
  videoOut: el('ml-video-out'),
  videoEl: el('ml-video-el'),
  saveBtn: el('ml-save'),
  downloadLink: el('ml-video-download'),
  log: el('ml-log'),
  canvas: el('ml-canvas'),
};

/* vendor/ ディレクトリの絶対URL。マニフェストのパスはこれを基準に解決する。 */
const VENDOR_BASE_URL = new URL('../vendor/', location.href);
const CACHE_NAME_FALLBACK = 'short-script-vendor-v1';

/** 実行時の状態。DOM操作の外に出し、テストしやすい形を保つ。 */
const state = {
  manifest: null,
  cache: null,
  synthesizedScenes: null, // Array<{ text, samples: Float32Array, sampleRate, durationSec }>
  wakeLockSentinel: null,
};

/* ---------- 小さなヘルパー ---------- */

function show(elm) {
  elm.hidden = false;
}
function hide(elm) {
  elm.hidden = true;
}

/** ログへ1行追加する。textContent のみを使い、innerHTML は使わない。 */
function log(message) {
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  li.textContent = `[${time}] ${message}`;
  dom.log.appendChild(li);
  console.log('[mobile-lab]', message);
}

function setStatus(elm, text) {
  elm.textContent = text;
  show(elm);
}

/* ---------- 台本の描画 ---------- */

function renderFixedScript() {
  for (const [index, scene] of FIXED_SCRIPT.scenes.entries()) {
    const li = document.createElement('li');
    li.className = 'ss-scene';

    const head = document.createElement('div');
    head.className = 'ss-scene-head';
    const num = document.createElement('span');
    num.className = 'ss-scene-num';
    num.textContent = `シーン${index + 1}`;
    head.appendChild(num);
    li.appendChild(head);

    const text = document.createElement('p');
    text.className = 'ss-scene-text';
    text.textContent = scene.text;
    li.appendChild(text);

    dom.scenesList.appendChild(li);
  }
}

/* ---------- 手順1: アセット準備 ---------- */

async function loadManifest() {
  const res = await fetch(new URL('vendor-manifest.json', VENDOR_BASE_URL));
  if (!res.ok) {
    throw new Error(`vendor-manifest.json の取得に失敗しました(${res.status})`);
  }
  const manifest = parseManifest(await res.json());
  state.manifest = manifest;

  const bytes = totalDownloadBytes(manifest);
  dom.prepareSize.textContent = `音声データを準備する(約${formatMegabytes(bytes)})`;
  dom.prepareBtn.textContent = `音声データを準備する(約${formatMegabytes(bytes)})`;

  const missing = unavailableAssets(manifest);
  if (missing.length > 0) {
    dom.unavailable.textContent =
      `同梱できていないファイルがあります: ${missing.map((a) => a.id).join(', ')}。` +
      `理由: ${missing[0].reason}`;
    show(dom.unavailable);
  }

  return manifest;
}

async function handlePrepare() {
  dom.prepareBtn.disabled = true;
  show(dom.prepareProgress);
  dom.prepareProgress.value = 0;
  setStatus(dom.prepareStatus, '準備しています…');

  try {
    const manifest = state.manifest;
    const cache = await caches.open(manifest.cacheName || CACHE_NAME_FALLBACK);
    state.cache = cache;

    const totalBytes = totalDownloadBytes(manifest);
    const loadedByAsset = new Map();

    await prepareAllAssets({
      manifest,
      baseUrl: VENDOR_BASE_URL,
      cache,
      onProgress: ({ assetId, loadedBytes }) => {
        loadedByAsset.set(assetId, loadedBytes);
        const loaded = Array.from(loadedByAsset.values()).reduce((a, b) => a + b, 0);
        dom.prepareProgress.value = totalBytes > 0 ? loaded / totalBytes : 0;
      },
    });

    dom.prepareProgress.value = 1;
    setStatus(dom.prepareStatus, '準備が完了しました(次回からはこの端末に保存された分を使います)。');
    log('アセットの準備が完了しました。');

    const modelAsset = findAsset(manifest, 'tsukuyomi.model');
    if (modelAsset && !modelAsset.unavailable) {
      dom.synthesizeBtn.disabled = false;
    } else {
      setStatus(
        dom.synthesizeStatus,
        '音声モデルが同梱されていないため、音声の合成はできません(上の「同梱できていないファイル」を参照)。'
      );
      log('音声モデル未同梱のため、手順2は実行できません。');
    }
  } catch (error) {
    setStatus(dom.prepareStatus, `準備に失敗しました: ${error.message}`);
    log(`準備エラー: ${error.message}`);
    dom.prepareBtn.disabled = false;
  }
}

/* ---------- 手順2: 音声合成 ---------- */

/*
 * piper-plus の G2P(Rust wasm)は25MiB超のため3分割で同梱している(§4.2)。
 * PiperPlus.initialize() の options.wasmLoader は「WASMモジュールを返す
 * 非同期関数」を差し込める公式のDIフックで、これを使えば piper-plus 本体の
 * コードを一切書き換えずに、分割ファイルを結合したバイト列を渡せる。
 * (options.wasmUrl 経由だと `import(url)` の後 `fetch(既定パス)` が単一
 * ファイルを前提にしてしまい、分割ファイルとかみ合わない。)
 *
 * 指摘1(独立レビュー)修正: 以前はここで part.path をキーに cache.match して
 * いたが、handlePrepare(prepareAllAssets)は結合後の論理パス(asset.path)を
 * キーに cache.put するため常に不一致(cache miss)になり、合成のたびに
 * 約58MBを再取得していた。vendor-loader.mjs の getVerifiedAssetBytes に
 * 取得・結合・SHA-256検証・キー解決を一本化し、キーを asset.path 基準に
 * 統一した(assetVirtualUrl)。
 */
async function loadPiperWasmModule() {
  const combined = await getVerifiedAssetBytes({
    manifest: state.manifest,
    assetId: 'piper-plus.g2p-wasm',
    baseUrl: VENDOR_BASE_URL,
    cache: state.cache,
  });

  const glueUrl = new URL('../vendor/piper/dist/rust-wasm/piper_plus_wasm.js', import.meta.url);
  const glue = await import(/* @vite-ignore */ glueUrl.href);
  await glue.default(combined);
  return glue;
}

async function handleSynthesize() {
  dom.synthesizeBtn.disabled = true;
  setStatus(dom.synthesizeStatus, '音声モデルを読み込んでいます…');

  const startedAt = performance.now();
  try {
    // ort.wasm.min.mjs(グルーJS)は manifest でSHA-256検証済みだが、この
    // import() 自体は同一オリジンへの再取得になる(独立レビュー指摘1 修正方針b。
    // 実行バイトの完全一致保証はM3のService Workerで行う。§4.4改訂0.2)。
    const ortUrl = new URL('../vendor/ort/ort.wasm.min.mjs', import.meta.url);
    const ort = await import(/* @vite-ignore */ ortUrl.href);
    // 単スレッドwasm(SharedArrayBuffer不要。§2.2)。
    ort.env.wasm.numThreads = 1;
    // wasm本体(.wasm)はcache.matchで検証済みバイト列を取得し、
    // env.wasm.wasmBinary(ort.wasm.min.mjs が公式に読む Module.wasmBinary 相当。
    // 同梱ort.wasm.min.mjs のソースで `l=e.wasmBinary` → `m.wasmBinary=l` を
    // 確認済み)へ直接渡す。これによりwasm本体側はURL経由のfetchが一切発生せず、
    // 検証済みバイト列がそのまま実行される(指摘1 修正方針a)。
    ort.env.wasm.wasmBinary = await getVerifiedAssetBytes({
      manifest: state.manifest,
      assetId: 'onnxruntime-web.wasm',
      baseUrl: VENDOR_BASE_URL,
      cache: state.cache,
    });

    // piper-plus本体もmanifestでSHA-256検証済みだが、相対importで同ディレクトリ内の
    // 他ファイル(webgpu-session-manager.js等)を参照するため、Blob URL化すると
    // それらの相対解決が壊れる。ort.wasm.min.mjs と同じ理由で同一オリジン再取得
    // のまま残す(§4.4改訂0.2)。
    const piperUrl = new URL('../vendor/piper/src/index.js', import.meta.url);
    const { PiperPlus } = await import(/* @vite-ignore */ piperUrl.href);

    // モデルの取得元。§4.4の説明どおり Hugging Face には出ない
    // (このアプリはモデルを同梱・同一オリジン配信する設計。現状は
    // unavailable のため、この関数はモデルが揃わないと呼ばれない)。
    const modelAsset = findAsset(state.manifest, 'tsukuyomi.model');
    if (!modelAsset || modelAsset.unavailable) {
      throw new Error('音声モデルが同梱されていません。');
    }
    const modelUrl = new URL(modelAsset.path, VENDOR_BASE_URL).href;

    const piper = await PiperPlus.initialize({
      model: modelUrl,
      ort,
      wasmLoader: loadPiperWasmModule,
      onProgress: ({ message }) => setStatus(dom.synthesizeStatus, message || '準備中…'),
    });

    const results = [];
    for (const scene of FIXED_SCRIPT.scenes) {
      setStatus(dom.synthesizeStatus, `合成中: ${scene.text.slice(0, 12)}…`);
      const audio = await piper.synthesize(scene.text, { language: 'ja' });
      results.push({
        text: scene.text,
        samples: audio.samples,
        sampleRate: audio.sampleRate,
        durationSec: audio.duration,
      });
    }
    piper.dispose();

    state.synthesizedScenes = results;

    const elapsedSec = (performance.now() - startedAt) / 1000;
    const totalSec = results.reduce((a, r) => a + r.durationSec, 0);
    setStatus(
      dom.synthesizeStatus,
      `合成完了(合成時間 ${elapsedSec.toFixed(1)}秒、音声の長さ 合計${totalSec.toFixed(1)}秒)。`
    );
    log(`音声合成: ${elapsedSec.toFixed(1)}秒で完了(音声長 ${totalSec.toFixed(1)}秒)。`);

    const combined = concatenateScenes(results);
    const blob = floatPcmToWavBlob(combined.samples, combined.sampleRate);
    dom.audio.src = URL.createObjectURL(blob);
    show(dom.audio);

    dom.renderBtn.disabled = false;
  } catch (error) {
    setStatus(dom.synthesizeStatus, `音声合成に失敗しました: ${error.message}`);
    log(`音声合成エラー: ${error.message}`);
  } finally {
    dom.synthesizeBtn.disabled = false;
  }
}

/** 複数シーンのPCMを1本につなげる(全シーン同じサンプルレート前提)。 */
function concatenateScenes(scenes) {
  const sampleRate = scenes[0].sampleRate;
  const totalLength = scenes.reduce((a, s) => a + s.samples.length, 0);
  const samples = new Float32Array(totalLength);
  let offset = 0;
  for (const scene of scenes) {
    samples.set(scene.samples, offset);
    offset += scene.samples.length;
  }
  return { samples, sampleRate };
}

/** Float32 PCM(モノラル) を16bit WAVのBlobにする(<audio>プレビュー用)。 */
function floatPcmToWavBlob(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/* ---------- 手順3: 動画の書き出し ---------- */

/** 生成中は画面を消させない(§2.1)。取得できなくても続行する。 */
async function acquireWakeLock() {
  try {
    if (!('wakeLock' in navigator)) {
      setStatus(dom.wakeLockStatus, '画面を消さないでください(このブラウザは自動維持に対応していません)。');
      return null;
    }
    const sentinel = await navigator.wakeLock.request('screen');
    log('Wake Lockを取得しました。');
    return sentinel;
  } catch (error) {
    setStatus(dom.wakeLockStatus, '画面を消さないでください(Wake Lockの取得に失敗しました)。');
    log(`Wake Lock取得エラー: ${error.message}`);
    return null;
  }
}

async function releaseWakeLock() {
  if (state.wakeLockSentinel) {
    try {
      await state.wakeLockSentinel.release();
      log('Wake Lockを解放しました。');
    } catch {
      /* 解放エラーは致命的でないため無視する。 */
    }
    state.wakeLockSentinel = null;
  }
  hide(dom.wakeLockStatus);
}

/** ページが裏に回ったら(タブ切替・画面ロック)Wake Lockが自動解除されるため、戻ってきたら取り直す。 */
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.wakeLockSentinel === null && state.renderingInProgress) {
    state.wakeLockSentinel = await acquireWakeLock();
  }
});

/** avc1.42001f(Baseline Profile Level 3.1相当)。汎用的で対応端末が広い。 */
const VIDEO_CODEC = 'avc1.42001f';
const AUDIO_CODEC = 'mp4a.40.2'; // AAC-LC
const FPS = 30;

async function detectRoute(sampleRate) {
  const hasVideoEncoder = 'VideoEncoder' in window;
  let aacEncodeSupported = false;
  if (hasVideoEncoder && 'AudioEncoder' in window) {
    try {
      const support = await AudioEncoder.isConfigSupported({
        codec: AUDIO_CODEC,
        sampleRate,
        numberOfChannels: 1,
        bitrate: 128000,
      });
      aacEncodeSupported = !!support.supported;
    } catch {
      aacEncodeSupported = false;
    }
  }
  return selectRoute({ hasVideoEncoder, aacEncodeSupported });
}

async function handleRender() {
  if (!state.synthesizedScenes) {
    setStatus(dom.renderStatus, '先に音声を合成してください。');
    return;
  }

  dom.renderBtn.disabled = true;
  state.renderingInProgress = true;
  state.wakeLockSentinel = await acquireWakeLock();

  const startedAt = performance.now();
  try {
    const sampleRate = state.synthesizedScenes[0].sampleRate;
    const route = await detectRoute(sampleRate);

    if (route === ROUTE_UNSUPPORTED) {
      setStatus(
        dom.routeStatus,
        '経路: 非対応(このブラウザはWebCodecsに対応していません。iOSは最新版に更新してください)。'
      );
      log('経路判定: 非対応。');
      return;
    }

    let resolution = null;
    if (route === ROUTE_FAST) {
      resolution = await negotiateResolution(async ({ width, height }) => {
        try {
          const support = await VideoEncoder.isConfigSupported({
            codec: VIDEO_CODEC,
            width,
            height,
            bitrate: 4_000_000,
            framerate: FPS,
          });
          return !!support.supported;
        } catch {
          return false;
        }
      });
      if (!resolution) {
        setStatus(dom.routeStatus, '経路: 非対応(この端末はどの解像度でもH.264エンコードができません)。');
        return;
      }
      setStatus(dom.routeStatus, `経路: 高速(WebCodecs)。解像度 ${resolution.label}。`);
      log(`経路: 高速。解像度 ${resolution.label}。`);
      await renderFastRoute({ resolution, sampleRate });
    } else {
      resolution = { width: 1080, height: 1920, label: '1080x1920' };
      setStatus(dom.routeStatus, '経路: リアルタイム(録画)。実時間と同じだけかかります。');
      log('経路: リアルタイム。');
      await renderRealtimeRoute({ resolution, sampleRate });
    }

    const elapsedSec = (performance.now() - startedAt) / 1000;
    setStatus(dom.renderStatus, `動画の書き出しが完了しました(${elapsedSec.toFixed(1)}秒)。`);
    log(`動画書き出し完了: ${elapsedSec.toFixed(1)}秒。`);
  } catch (error) {
    setStatus(dom.renderStatus, `動画の書き出しに失敗しました: ${error.message}`);
    log(`書き出しエラー: ${error.message}`);
  } finally {
    state.renderingInProgress = false;
    await releaseWakeLock();
    dom.renderBtn.disabled = false;
  }
}

/** JASSUB用のASSを組み立て、字幕描画インスタンスを用意する。 */
async function setupSubtitleRenderer({ width, height }) {
  const timeline = computeSceneTimeline(state.synthesizedScenes.map((s) => ({ durationSec: s.durationSec })));
  const scenesForAss = state.synthesizedScenes.map((s, i) => ({
    text: s.text,
    startSec: timeline[i].startSec,
    durationSec: timeline[i].durationSec,
  }));
  const assText = buildAss(scenesForAss);

  // jassub.js自体はmanifestでSHA-256検証済みだが、importは同一オリジン再取得に
  // なる(独立レビュー指摘1 修正方針b。§4.4改訂0.2)。
  const jassubUrl = new URL('../vendor/jassub/dist/jassub.js', import.meta.url);
  const { default: JASSUB } = await import(/* @vite-ignore */ jassubUrl.href);

  const subtitleCanvas = document.createElement('canvas');
  // フォント・wasmはJASSUBのWorker内で `_fetch(url)` により取得される
  // (jassub.js/worker.jsのソースで確認済み。importではなくfetchなのでBlob URLを
  // 受け付ける)。検証済みバイト列からBlob URLを作り、実行バイトを一致させる
  // (指摘1 修正方針a)。
  const fontUrl = await getVerifiedAssetBlobUrl({
    manifest: state.manifest,
    assetId: 'noto-sans-jp.font',
    baseUrl: VENDOR_BASE_URL,
    cache: state.cache,
    mimeType: 'font/ttf',
  });
  const wasmUrl = await getVerifiedAssetBlobUrl({
    manifest: state.manifest,
    assetId: 'jassub.wasm',
    baseUrl: VENDOR_BASE_URL,
    cache: state.cache,
    mimeType: 'application/wasm',
  });
  // worker.js は同ディレクトリの renderers/*.js 等を相対importするため、
  // Blob URL化すると相対解決が壊れる。`new Worker(workerUrl)` はメインスレッド
  // 自身が生成するため同一オリジンのままで問題なく、jassub.worker-js として
  // manifestでSHA-256検証はしているが、importは同一オリジン再取得のまま残す
  // (piper-plus.js・ort.wasm.min.mjsと同じ理由。§4.4改訂0.2)。
  const workerUrl = new URL('../vendor/jassub/dist/worker/worker.js', import.meta.url).href;

  const sub = new JASSUB({
    canvas: subtitleCanvas,
    subContent: assText,
    workerUrl,
    wasmUrl,
    // modernWasmUrl の既定値は同梱していない jassub-worker-modern.wasm を
    // 指してしまう(SIMD対応端末では既定でこちらが選ばれる)。
    // 未同梱ファイルへの404を避けるため、標準wasmで明示的に上書きする
    // (§7「採用しなかった案」に準じた、M1でのサイズ削減の判断)。
    modernWasmUrl: wasmUrl,
    // ASSスタイル名("Noto Sans CJK JP")と同梱フォント(Noto Sans JP)は
    // 別の書体名のため、明示的に対応付ける(subtitle.mjs 冒頭コメント参照)。
    availableFonts: { 'noto sans cjk jp': fontUrl },
    fonts: [fontUrl],
  });
  await sub.ready;
  await sub.resize(true, width, height);

  return { sub, subtitleCanvas, timeline: scenesForAss };
}

/** 背景グラデーションを1回だけ生成する(同梱のサンプル画像は使わず、Canvas生成側を採用。§5からの逸脱として報告)。 */
function drawBackground(ctx, width, height) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#0f2b46');
  gradient.addColorStop(1, '#173a63');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

/**
 * Ken Burns(ズームのみ)を1フレーム分描画する。
 * 背景は縦横比を保ったまま中央を基準に拡大する。
 */
function drawKenBurnsFrame(ctx, backgroundCanvas, width, height, scale) {
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  const dx = (width - drawWidth) / 2;
  const dy = (height - drawHeight) / 2;
  ctx.drawImage(backgroundCanvas, dx, dy, drawWidth, drawHeight);
}

async function renderFastRoute({ resolution, sampleRate }) {
  const { width, height } = resolution;
  const canvas = dom.canvas;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });

  const backgroundCanvas = document.createElement('canvas');
  backgroundCanvas.width = width;
  backgroundCanvas.height = height;
  drawBackground(backgroundCanvas.getContext('2d'), width, height);

  const { sub, subtitleCanvas, timeline } = await setupSubtitleRenderer({ width, height });

  // mediabunny.min.mjsは単一バンドル・manifestでSHA-256検証済みだが、importは
  // 同一オリジン再取得になる(独立レビュー指摘1 修正方針b。§4.4改訂0.2)。
  const mediabunnyUrl = new URL('../vendor/mediabunny/mediabunny.min.mjs', import.meta.url);
  const mb = await import(/* @vite-ignore */ mediabunnyUrl.href);

  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
  const videoSource = new mb.EncodedVideoPacketSource('avc');
  const audioSource = new mb.EncodedAudioPacketSource('aac');
  output.addVideoTrack(videoSource, { frameRate: FPS });
  output.addAudioTrack(audioSource);

  let videoEncoderError = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, metadata) => {
      videoSource.add(mb.EncodedPacket.fromEncodedChunk(chunk), metadata);
    },
    error: (e) => {
      videoEncoderError = e;
    },
  });
  videoEncoder.configure({ codec: VIDEO_CODEC, width, height, bitrate: 4_000_000, framerate: FPS });

  let audioEncoderError = null;
  const audioEncoder = new AudioEncoder({
    output: (chunk, metadata) => {
      audioSource.add(mb.EncodedPacket.fromEncodedChunk(chunk), metadata);
    },
    error: (e) => {
      audioEncoderError = e;
    },
  });
  audioEncoder.configure({ codec: AUDIO_CODEC, sampleRate, numberOfChannels: 1, bitrate: 128000 });

  await output.start();

  // --- 音声(AAC)をエンコード。20msフレーム単位で投入する ---
  const combinedAudio = concatenateScenes(state.synthesizedScenes);
  const frameSamples = Math.round(sampleRate * 0.02);
  let audioTimestampUs = 0;
  for (let offset = 0; offset < combinedAudio.samples.length; offset += frameSamples) {
    const chunkSamples = combinedAudio.samples.subarray(offset, Math.min(offset + frameSamples, combinedAudio.samples.length));
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: chunkSamples.length,
      numberOfChannels: 1,
      timestamp: audioTimestampUs,
      data: chunkSamples,
    });
    audioEncoder.encode(data);
    data.close();
    audioTimestampUs += (chunkSamples.length / sampleRate) * 1_000_000;
    while (audioEncoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
  }

  // --- 映像(H.264)をシーンごと・フレームごとに描画してエンコード ---
  let frameIndex = 0;
  for (const [sceneIndex, scene] of timeline.entries()) {
    const totalFrames = frameCountForDuration(scene.durationSec, FPS);
    for (let f = 0; f < totalFrames; f++) {
      const t = scene.startSec + f / FPS;
      const scale = kenBurnsScaleForFrame(f, totalFrames);
      drawKenBurnsFrame(ctx, backgroundCanvas, width, height, scale);

      await sub.manualRender({ mediaTime: t, width, height, expectedDisplayTime: 0 });
      ctx.drawImage(subtitleCanvas, 0, 0, width, height);

      const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1_000_000) });
      videoEncoder.encode(frame, { keyFrame: frameIndex % FPS === 0 });
      frame.close();
      frameIndex += 1;

      if (videoEncoderError) throw videoEncoderError;
      while (videoEncoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 0));
    }
    log(`シーン${sceneIndex + 1}の描画が完了しました。`);
  }

  await videoEncoder.flush();
  await audioEncoder.flush();
  videoEncoder.close();
  audioEncoder.close();
  await sub.destroy();

  if (audioEncoderError) throw audioEncoderError;

  await output.finalize();
  const buffer = output.target.buffer;
  presentVideo(new Blob([buffer], { type: 'video/mp4' }));
}

/**
 * AAC不可端末向けのフォールバック。canvas.captureStream() + MediaRecorder。
 * 実時間30秒かかる(§3補足)。Ken Burns・字幕はrequestAnimationFrameで
 * リアルタイムに描画しながら録画する。
 */
async function renderRealtimeRoute({ resolution, sampleRate }) {
  const { width, height } = resolution;
  const canvas = dom.canvas;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });

  const backgroundCanvas = document.createElement('canvas');
  backgroundCanvas.width = width;
  backgroundCanvas.height = height;
  drawBackground(backgroundCanvas.getContext('2d'), width, height);

  const { sub, subtitleCanvas, timeline } = await setupSubtitleRenderer({ width, height });

  const combinedAudio = concatenateScenes(state.synthesizedScenes);
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx({ sampleRate });
  const audioBuffer = audioCtx.createBuffer(1, combinedAudio.samples.length, sampleRate);
  audioBuffer.copyToChannel(combinedAudio.samples, 0);
  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  const destination = audioCtx.createMediaStreamDestination();
  source.connect(destination);
  source.connect(audioCtx.destination);

  const videoStream = canvas.captureStream(FPS);
  const combinedStream = new MediaStream([...videoStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);

  const mimeType = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : null;
  if (!mimeType) {
    // 設計方針: webmへは倒さない(写真アプリ・SNS互換のため。§3補足)。
    throw new Error('この端末はvideo/mp4での録画に対応していません。');
  }
  const recorder = new MediaRecorder(combinedStream, { mimeType });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const totalDuration = timeline.reduce((a, s) => a + s.durationSec, 0);

  const recordingDone = new Promise((resolve, reject) => {
    recorder.onstop = resolve;
    recorder.onerror = (e) => reject(e.error || new Error('MediaRecorderでエラーが発生しました'));
  });

  recorder.start();
  source.start();
  const renderStartedAt = performance.now();

  await new Promise((resolve) => {
    function frameLoop() {
      const elapsed = (performance.now() - renderStartedAt) / 1000;
      if (elapsed >= totalDuration) {
        resolve();
        return;
      }
      const sceneIndex = timeline.findIndex((s) => elapsed >= s.startSec && elapsed < s.startSec + s.durationSec);
      if (sceneIndex >= 0) {
        const scene = timeline[sceneIndex];
        const progress = (elapsed - scene.startSec) / scene.durationSec;
        const totalFrames = frameCountForDuration(scene.durationSec, FPS);
        const scale = kenBurnsScaleForFrame(Math.round(progress * totalFrames), totalFrames);
        drawKenBurnsFrame(ctx, backgroundCanvas, width, height, scale);
        sub.manualRender({ mediaTime: elapsed, width, height, expectedDisplayTime: 0 }).then(() => {
          ctx.drawImage(subtitleCanvas, 0, 0, width, height);
        });
      }
      requestAnimationFrame(frameLoop);
    }
    requestAnimationFrame(frameLoop);
  });

  recorder.stop();
  source.stop();
  await recordingDone;
  await sub.destroy();
  await audioCtx.close();

  presentVideo(new Blob(chunks, { type: 'video/mp4' }));
}

function presentVideo(blob) {
  const url = URL.createObjectURL(blob);
  dom.videoEl.src = url;
  dom.downloadLink.href = url;
  dom.downloadLink.download = 'short-script-mobile-lab.mp4';
  show(dom.downloadLink);
  show(dom.videoOut);
  state.lastVideoBlob = blob;
}

async function handleSave() {
  const blob = state.lastVideoBlob;
  if (!blob) return;
  const file = new File([blob], 'short-script-mobile-lab.mp4', { type: 'video/mp4' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: FIXED_SCRIPT.title });
      log('共有シートから保存しました。');
      return;
    } catch (error) {
      // 利用者がキャンセルした場合(AbortError)は静かに終える。
      if (error.name !== 'AbortError') {
        log(`共有に失敗しました: ${error.message}`);
      } else {
        return;
      }
    }
  }
  // フォールバック: ダウンロードリンクを直接クリックさせる。
  dom.downloadLink.click();
  log('ダウンロードリンクから保存しました。');
}

/* ---------- 起動 ---------- */

async function init() {
  const user = await guardPage();
  if (!user) {
    return;
  }

  hide(dom.loading);
  show(dom.content);

  renderFixedScript();

  try {
    await loadManifest();
  } catch (error) {
    setStatus(dom.prepareStatus, `マニフェストの読み込みに失敗しました: ${error.message}`);
    dom.prepareBtn.disabled = true;
    return;
  }

  dom.prepareBtn.addEventListener('click', handlePrepare);
  dom.synthesizeBtn.addEventListener('click', handleSynthesize);
  dom.renderBtn.addEventListener('click', handleRender);
  dom.saveBtn.addEventListener('click', handleSave);
}

init();
