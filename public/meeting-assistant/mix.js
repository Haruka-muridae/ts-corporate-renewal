/*
 * オンライン録音の音源ミックス。
 *
 * interview-recorder の startRecordingSession と同じ接続図:
 * getDisplayMedia（タブ音声）+ getUserMedia（マイク）を GainNode(0.7) で混ぜ、
 * 単一の MediaStream として返す。
 *
 * エンコードは voice-recorder の Recorder に渡す。
 */

import { MIX_SOURCE_GAIN } from './config.js';

function createMixAudioContext() {
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;

  try {
    return new AudioContextCtor({ sampleRate: 44100 });
  } catch {
    return new AudioContextCtor();
  }
}

export function canCaptureTabAudio() {
  return typeof navigator?.mediaDevices?.getDisplayMedia === 'function';
}

export async function startOnlineMix() {
  if (!canCaptureTabAudio()) {
    const error = new Error('display_capture_unsupported');
    error.code = 'DISPLAY_UNSUPPORTED';
    throw error;
  }

  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });

  let micStream = null;
  let micDenied = false;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    micDenied = true;
  }

  const audioContext = createMixAudioContext();
  const destination = audioContext.createMediaStreamDestination();
  const mixNode = audioContext.createGain();
  mixNode.gain.value = 1;
  mixNode.connect(destination);

  const tabAudioTracks = displayStream.getAudioTracks();
  const hasTabAudio = tabAudioTracks.length > 0;

  if (hasTabAudio) {
    const tabGain = audioContext.createGain();
    tabGain.gain.value = MIX_SOURCE_GAIN;
    audioContext.createMediaStreamSource(new MediaStream(tabAudioTracks)).connect(tabGain).connect(mixNode);
  }

  if (micStream) {
    const micGain = audioContext.createGain();
    micGain.gain.value = MIX_SOURCE_GAIN;
    audioContext.createMediaStreamSource(micStream).connect(micGain).connect(mixNode);
  }

  try {
    const resumeResult = audioContext.resume();
    if (resumeResult && typeof resumeResult.catch === 'function') {
      resumeResult.catch(() => {});
    }
  } catch {
    /* resume 失敗でも録音は続ける。 */
  }

  return {
    stream: destination.stream,
    audioContext,
    displayStream,
    micStream,
    hasTabAudio,
    micDenied,
    stop() {
      displayStream.getTracks().forEach((track) => {
        try { track.stop(); } catch { /* noop */ }
      });

      micStream?.getTracks().forEach((track) => {
        try { track.stop(); } catch { /* noop */ }
      });

      try { mixNode.disconnect(); } catch { /* noop */ }

      if (audioContext.state !== 'closed') {
        audioContext.close().catch(() => {});
      }
    },
  };
}
