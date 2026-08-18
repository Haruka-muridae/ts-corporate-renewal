/*
 * 面談録音アプリ（本番 production-app/interview-recorder/）の config.js。
 *
 * ------------------------------------------------------------------
 * ここで見るのは「ブラウザが要らない部分」だけ
 * ------------------------------------------------------------------
 * 対象は config.js の公開値のみ。app.js は document / navigator.mediaDevices /
 * AudioWorklet 等の実ブラウザ機能に強く依存し、Node からは直接 import
 * できない（音声文字起こしアプリの script.js と同じ理由。audio-transcriber.mjs
 * の冒頭コメントを参照）。
 *
 * 録音ロジック・同意ゲート・状態機械そのものの検証は、実ブラウザでの
 * 動作確認に委ねる（要件定義書 §11 を参照）。
 * ------------------------------------------------------------------
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

try {
  const config = await import('../../public/production-app/interview-recorder/config.js');

  /* ================================================================ */
  section('画面の深さ');

  check('画面の深さは2（production-app/interview-recorder/）', config.SCREEN_DEPTH === 2);

  /* ================================================================ */
  section('MP3 エンコード設定');

  check('MP3ビットレートは64kbps', config.MP3_BITRATE_KBPS === 64);
  check(
    'PCMフラッシュ単位はMP3の1フレーム（1152サンプル）の倍数',
    Number.isInteger(config.PCM_FLUSH_SAMPLES / 1152),
  );
  check('PCMフラッシュ単位は移植元と同じ1152*8', config.PCM_FLUSH_SAMPLES === 1152 * 8);

  check(
    'AudioWorkletのURLは同一オリジンの相対パス（外部URLではない）',
    typeof config.MP3_WORKLET_URL === 'string'
    && config.MP3_WORKLET_URL !== ''
    && !/^https?:\/\//.test(config.MP3_WORKLET_URL),
  );

  check(
    'ミックス時のソースゲインは0より大きく1以下（クリッピング対策で1未満）',
    typeof config.MIX_SOURCE_GAIN === 'number'
    && config.MIX_SOURCE_GAIN > 0
    && config.MIX_SOURCE_GAIN <= 1,
  );
} catch (error) {
  fatal(error);
}

finish();
