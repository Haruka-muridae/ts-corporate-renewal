/*
 * ローカル補助サービス（ai-video-app）との通信。
 *
 * ==================================================================
 * 役割
 * ==================================================================
 * 音声（VOICEVOX）と動画（FFmpeg）は、利用者のPCで動くローカルの
 * 補助サービスが担う。このモジュールは、そこへ台本を渡して生成を
 * 依頼し、進捗（NDJSON）を1件ずつ返す。DOM は触らない。
 *
 * 補助サービスが起動していない・VOICEVOX が未起動、といった失敗は
 * 例外にせず、呼び出し側が案内を出せるよう扱う。
 * ==================================================================
 */

import { COMPANION_BASE_URL } from './config.js';

/* 疎通確認・話者取得のタイムアウト。起動していなければ待たずに失敗させる。 */
const PING_TIMEOUT_MS = 4000;

/** 生成済み動画のURL（別オリジン＝補助サービス側）。 */
export function videoUrl(videoId) {
  return `${COMPANION_BASE_URL}/api/video/${encodeURIComponent(String(videoId ?? ''))}`;
}

/*
 * 補助サービスが応答するか＋話者一覧。
 * 戻り値: { ok, speakers } 。ok=false なら未起動などで取得できなかった。
 */
export async function fetchSpeakers() {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), PING_TIMEOUT_MS) : null;

  try {
    const res = await fetch(`${COMPANION_BASE_URL}/api/speakers`, {
      credentials: 'omit',
      signal: controller?.signal,
    });

    if (!res.ok) {
      return { ok: false, speakers: [] };
    }

    const list = await res.json();
    return { ok: true, speakers: Array.isArray(list) ? list : [] };
  } catch {
    /* 未起動・CORS拒否・タイムアウト。すべて「使えない」として扱う。 */
    return { ok: false, speakers: [] };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

/*
 * 台本から音声・動画を生成する。進捗イベントを onEvent で1件ずつ渡す。
 *
 * options: { speakerId, speedScale, volumeScale, pitchScale, backgrounds }
 *   backgrounds … 背景画像の data URL 配列（任意）。渡すと補助サービス側で優先される。
 * 戻り値: 完了イベント { type:'done', videoId, title }
 * 失敗時は Error を投げる（error イベント・通信断・未起動を含む）。
 */
export async function renderVideo(script, options = {}, { onEvent, signal } = {}) {
  const body = JSON.stringify({
    script: { title: script.title, scenes: script.scenes },
    speakerId: options.speakerId,
    speedScale: options.speedScale,
    volumeScale: options.volumeScale,
    pitchScale: options.pitchScale,
    backgrounds: Array.isArray(options.backgrounds) ? options.backgrounds : undefined,
    duration: 30,
  });

  let res;
  try {
    res = await fetch(`${COMPANION_BASE_URL}/api/generate`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal,
    });
  } catch {
    throw new Error(
      'ローカルの動画生成サービスに接続できませんでした。ai-video-app を起動しているかご確認ください。',
    );
  }

  if (!res.ok || !res.body) {
    throw new Error(`動画生成サービスがエラーを返しました（HTTP ${res.status}）。`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;

  /* NDJSON を1行ずつ解釈する。行の途中で切れることがあるのでバッファする。 */
  for (;;) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim() === '') continue;

      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; /* 壊れた行は飛ばす。 */
      }

      if (ev.type === 'error') {
        throw new Error(ev.message || '動画生成に失敗しました。');
      }

      if (ev.type === 'done') {
        done = ev;
      }

      if (typeof onEvent === 'function') {
        onEvent(ev);
      }
    }
  }

  if (!done) {
    throw new Error('動画生成が完了しませんでした。');
  }

  return done;
}
