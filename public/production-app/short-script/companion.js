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

import {
  COMPANION_BASE_URL,
  ENGINE_START_POLL_INTERVAL_MS,
  ENGINE_START_TIMEOUT_MS,
} from './config.js';

/* 疎通確認・話者取得のタイムアウト。起動していなければ待たずに失敗させる。 */
const PING_TIMEOUT_MS = 4000;

/** 生成済み動画のURL（別オリジン＝補助サービス側）。 */
export function videoUrl(videoId) {
  return `${COMPANION_BASE_URL}/api/video/${encodeURIComponent(String(videoId ?? ''))}`;
}

/*
 * X-Engine-Status ヘッダの値を正規化する。
 * 既知の3値以外（欠落・未知の値）は null にする。
 * null を online 相当と扱う判断は app.js 側に置く。companion は事実だけ返す
 * （通信層が解釈まで持つと、後方互換の判断がここに埋もれて追えなくなる）。
 */
function normalizeEngineStatus(value) {
  return value === 'online' || value === 'offline' || value === 'mock' ? value : null;
}

/*
 * 補助サービスが応答するか＋話者一覧。
 * 戻り値: { ok, speakers, engineStatus } 。ok=false なら未起動などで取得できなかった。
 * engineStatus は X-Engine-Status ヘッダの正規化値（'online'|'offline'|'mock'|null）。
 * 補助サービスはエンジン停止中でもフォールバックの話者一覧を返すため、
 * ok=true を「エンジンが使える」証拠にしてはいけない（実際に誤判定が起きていた）。
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
      return { ok: false, speakers: [], engineStatus: null };
    }

    const engineStatus = normalizeEngineStatus(res.headers?.get?.('X-Engine-Status'));
    const list = await res.json();
    return { ok: true, speakers: Array.isArray(list) ? list : [], engineStatus };
  } catch {
    /* 未起動・CORS拒否・タイムアウト。すべて「使えない」として扱う。 */
    return { ok: false, speakers: [], engineStatus: null };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

/*
 * 音声エンジン（VOICEVOX）の稼働状況。**接続可否の判定はこちらが正**
 * （docs/engine-api-for-portal.md。/api/speakers はフォールバックを返す）。
 * 戻り値: { ok, online } 。ok=false は ai-video-app 自体に到達できなかった。
 */
export async function fetchEngineStatus() {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), PING_TIMEOUT_MS) : null;

  try {
    const res = await fetch(`${COMPANION_BASE_URL}/api/engine/status`, {
      credentials: 'omit',
      signal: controller?.signal,
    });

    if (!res.ok) {
      return { ok: false, online: false };
    }

    const body = await res.json();
    /* running は実際に VOICEVOX へ疎通した結果のみが入る（仕様書どおり）。 */
    return { ok: true, online: body?.running === true };
  } catch {
    return { ok: false, online: false };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

/*
 * 音声エンジンの起動を依頼する（冪等。起動済みなら何もせず成功が返る）。
 * 戻り値: { ok, status, reason, downloadUrl } 。status は HTTP ステータス
 * （404＝この API を持たない旧版の ai-video-app の検出に使う）。通信断は status=0。
 * reason / downloadUrl は失敗応答（非2xx）のボディから取り出す。409（not_installed）
 * のときに「未インストール」を即時に案内し、公式サイトへ誘導するために要る。
 * ボディが JSON でない・無い場合は null（旧版の404など。解釈は呼び出し側に任せる）。
 * 補助サービス側は応答まで最大60秒かかりうるため、ここでは打ち切らない
 * （打ち切っても起動処理は止まらず、待つ側の状態だけが分からなくなる）。
 */
export async function startEngine() {
  try {
    const res = await fetch(`${COMPANION_BASE_URL}/api/engine/start`, {
      method: 'POST',
      credentials: 'omit',
    });

    let reason = null;
    let downloadUrl = null;
    if (!res.ok) {
      try {
        const body = await res.json();
        reason = typeof body?.reason === 'string' ? body.reason : null;
        downloadUrl = typeof body?.downloadUrl === 'string' ? body.downloadUrl : null;
      } catch {
        /* JSON でないエラー応答。理由不明のまま status だけで判断してもらう。 */
      }
    }

    return { ok: res.ok, status: res.status, reason, downloadUrl };
  } catch {
    return { ok: false, status: 0, reason: null, downloadUrl: null };
  }
}

/*
 * エンジンが online になるまで fetchEngineStatus を繰り返す。
 * 戻り値: { online } 。期限を超えたら { online: false }。
 * ai-video-app 自体への到達失敗（ok=false）が2回連続したら、期限を待たずに
 * { online: false, unreachable: true } で抜ける。ポーリング中にアプリが落ちたのに
 * 30秒待たせた末「VOICEVOX のインストール確認」という誤った案内になっていたため。
 * 1回だけの失敗では抜けない（起動直後の瞬断・タイムアウトの揺れがありうる）。
 *
 * setInterval を使わず await で直列に回す。fetch のタイムアウト（4秒）が
 * 間隔（2秒）より長く、setInterval だと前の確認が終わる前に次が重なるため。
 *
 * intervalMs / timeoutMs は引数で差し替えられる（既定は config の定数）。
 * テストから間隔0で回すための注入口で、本番コードは既定値のまま呼ぶ。
 */
export async function waitForEngineOnline({
  intervalMs = ENGINE_START_POLL_INTERVAL_MS,
  timeoutMs = ENGINE_START_TIMEOUT_MS,
  onTick,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let consecutiveUnreachable = 0;

  for (;;) {
    const { ok, online } = await fetchEngineStatus();

    if (online) {
      return { online: true };
    }

    if (ok) {
      /* アプリには届いている（エンジンがまだなだけ）。断のカウントを戻す。 */
      consecutiveUnreachable = 0;
    } else {
      consecutiveUnreachable += 1;
      if (consecutiveUnreachable >= 2) {
        return { online: false, unreachable: true };
      }
    }

    if (typeof onTick === 'function') {
      onTick();
    }

    if (Date.now() >= deadline) {
      return { online: false };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
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
