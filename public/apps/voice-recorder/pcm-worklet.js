/*
 * AudioWorkletProcessor。
 * 役割は「入力をモノラル化して一定量ためて、まとめてメインへ送る」だけ。
 * MP3変換・OPFS操作・重い計算はここで行わない（オーディオスレッドを止めない）。
 *
 * process() は 128 サンプル刻みで呼ばれるため、内部リングに貯めて
 * 閾値（約0.2秒）に達したときだけ新しい Float32Array を transfer で送る。
 */

const CHUNK_SECONDS = 0.2;

class PcmWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /* sampleRate は AudioWorkletGlobalScope のグローバル。 */
    const target = Math.round(sampleRate * CHUNK_SECONDS);
    /* 48kHz→9600, 44.1kHz→8820 前後。 */
    this.chunkSize = Math.max(1, target);
    this.buffer = new Float32Array(this.chunkSize);
    this.filled = 0;
    this.stopped = false;

    this.port.onmessage = (event) => {
      if (event.data === 'stop') {
        /* 残っている端数を最後に送ってから終了する。 */
        this.flushBuffer();
        this.stopped = true;
      }
    };
  }

  flushBuffer() {
    if (this.filled === 0) {
      return;
    }
    const out = new Float32Array(this.filled);
    out.set(this.buffer.subarray(0, this.filled));
    this.port.postMessage(out, [out.buffer]);
    this.filled = 0;
  }

  process(inputs) {
    if (this.stopped) {
      return false;
    }

    const input = inputs[0];
    if (!input || input.length === 0) {
      /* 入力が無い（マイク未接続など）。処理は継続する。 */
      return true;
    }

    const frames = input[0].length;
    const channelCount = input.length;

    for (let i = 0; i < frames; i += 1) {
      /* 複数チャンネルは平均でモノラル化。 */
      let sample = 0;
      for (let ch = 0; ch < channelCount; ch += 1) {
        sample += input[ch][i];
      }
      sample /= channelCount;

      this.buffer[this.filled] = sample;
      this.filled += 1;

      if (this.filled >= this.chunkSize) {
        /* 閾値到達。新しい配列にコピーして transfer で送る。 */
        const out = new Float32Array(this.chunkSize);
        out.set(this.buffer);
        this.port.postMessage(out, [out.buffer]);
        this.filled = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorkletProcessor);
