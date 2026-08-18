'use strict';

/*
 * 移植元: スタンドアロン版 interview-recorder リポジトリ
 * （/home/yuki9/projects/interview-recorder/public/pcm-capture-worklet.js）。
 * 移植日 2026-08-18。ロジックは変更していない（そのまま複製）。
 */

/**
 * ミックス後の音声をモノラル化して、128フレーム単位の Float32 チャンクを
 * そのままメインスレッドへ転送するだけの薄い AudioWorkletProcessor。
 * MP3 への逐次エンコードはメインスレッド側（app.js）で行う。
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    var input = inputs[0];
    if (input && input.length > 0) {
      var channelData = input[0];
      if (channelData && channelData.length > 0) {
        // process() が呼ばれるたびに同じ Float32Array バッファが
        // 使い回されるため、転送前に必ずコピーする。
        this.port.postMessage(channelData.slice());
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
