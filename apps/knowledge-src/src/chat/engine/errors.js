/*
 * チャット固有のエラーコードと日本語メッセージ。
 *
 * 既存の core/errors.js の仕組み（AppError / messageFor）へ相乗りする。
 * 追加するのはコードとメッセージだけで、既存のコードは書き換えない。
 */

import { registerMessages, ErrorCode } from '../../core/errors.js';

export const ChatErrorCode = Object.freeze({
  WEBGPU_UNAVAILABLE: 'WEBGPU_UNAVAILABLE',
  GPU_ADAPTER_FAILED: 'GPU_ADAPTER_FAILED',
  GPU_DEVICE_LOST: 'GPU_DEVICE_LOST',

  MODEL_NOT_SUPPORTED: 'MODEL_NOT_SUPPORTED',
  MODEL_DOWNLOAD_FAILED: 'MODEL_DOWNLOAD_FAILED',
  MODEL_INIT_FAILED: 'MODEL_INIT_FAILED',
  MODEL_NOT_READY: 'MODEL_NOT_READY',
  CACHE_QUOTA_EXCEEDED: 'CACHE_QUOTA_EXCEEDED',
  OUT_OF_MEMORY: 'OUT_OF_MEMORY',

  GENERATION_FAILED: 'GENERATION_FAILED',
  CANCELLED_BY_USER: 'CANCELLED_BY_USER',
  QUESTION_TOO_LONG: 'QUESTION_TOO_LONG',
  CONTEXT_TOO_LONG: 'CONTEXT_TOO_LONG',
  ALREADY_GENERATING: 'ALREADY_GENERATING',
  ENGINE_BUSY_OTHER_TAB: 'ENGINE_BUSY_OTHER_TAB',

  NO_KNOWLEDGE: 'NO_KNOWLEDGE',
  NO_SEARCH_RESULT: 'NO_SEARCH_RESULT',
  OFFLINE_NO_MODEL: 'OFFLINE_NO_MODEL',
  HISTORY_SAVE_FAILED: 'HISTORY_SAVE_FAILED',
});

registerMessages({
  [ChatErrorCode.WEBGPU_UNAVAILABLE]: {
    title: 'このブラウザではWebGPUを利用できません。',
    hint: '最新版の Chrome または Edge をご利用ください。',
  },
  [ChatErrorCode.GPU_ADAPTER_FAILED]: {
    title: 'GPUを取得できませんでした。',
    hint: 'ブラウザ設定でハードウェアアクセラレーションを有効にしてから、再読み込みしてください。',
  },
  [ChatErrorCode.GPU_DEVICE_LOST]: {
    title: 'GPUとの接続が切断されました。',
    hint: 'ページを再読み込みして、もう一度モデルを準備してください。',
  },

  [ChatErrorCode.MODEL_NOT_SUPPORTED]: {
    title: 'このモデルは現在のライブラリでは利用できません。',
    hint: '別のモデルを選んでください。',
  },
  [ChatErrorCode.MODEL_DOWNLOAD_FAILED]: {
    title: 'モデルファイルのダウンロードに失敗しました。',
    hint: 'ネットワーク接続をご確認のうえ、「再試行」を押してください。途中まで取得した分は再利用されます。',
  },
  [ChatErrorCode.MODEL_INIT_FAILED]: {
    title: 'AIモデルの初期化に失敗しました。',
    hint: 'ページを再読み込みしてお試しください。繰り返す場合は、より軽量なモデルをお選びください。',
  },
  [ChatErrorCode.MODEL_NOT_READY]: {
    title: 'AIモデルの準備が終わっていません。',
    hint: '「モデルを準備する」を押して、完了してから質問してください。',
  },
  [ChatErrorCode.CACHE_QUOTA_EXCEEDED]: {
    title: 'ブラウザの保存容量が足りません。',
    hint: 'モデルキャッシュを削除するか、より軽量なモデルをお選びください。',
  },
  [ChatErrorCode.OUT_OF_MEMORY]: {
    title: 'メモリまたはVRAMが不足しました。',
    hint: '他のタブを閉じるか、より軽量なモデルをお選びください。',
  },

  [ChatErrorCode.GENERATION_FAILED]: {
    title: '回答の生成に失敗しました。',
    hint: '「再試行」でやり直せます。',
  },
  [ChatErrorCode.CANCELLED_BY_USER]: {
    title: '生成を停止しました。',
    hint: '',
  },
  [ChatErrorCode.QUESTION_TOO_LONG]: {
    title: '質問が長すぎます。',
    hint: '短く分けて質問してください。',
  },
  [ChatErrorCode.CONTEXT_TOO_LONG]: {
    title: '参照する資料が多すぎます。',
    hint: '詳細設定で「検索件数」または「コンテキスト上限」を小さくしてください。',
  },
  [ChatErrorCode.ALREADY_GENERATING]: {
    title: 'すでに回答を生成しています。',
    hint: '完了するか、停止してからお試しください。',
  },
  [ChatErrorCode.ENGINE_BUSY_OTHER_TAB]: {
    title: '別のタブでAIモデルを使用しています。',
    hint: '他のタブを閉じてから、もう一度お試しください。',
  },

  [ChatErrorCode.NO_KNOWLEDGE]: {
    title: '同期済みのナレッジがありません。',
    hint: '先にナレッジ管理画面でGoogle Driveを同期してください。',
  },
  [ChatErrorCode.NO_SEARCH_RESULT]: {
    title: '質問に関連する資料が見つかりませんでした。',
    hint: '言い回しを変えるか、対象の資料が同期済みかご確認ください。',
  },
  [ChatErrorCode.OFFLINE_NO_MODEL]: {
    title: 'オフラインのため、モデルを取得できません。',
    hint: 'ネットワークに接続してから「モデルを準備する」を押してください。一度取得済みならオフラインでも利用できます。',
  },
  [ChatErrorCode.HISTORY_SAVE_FAILED]: {
    title: '会話履歴を保存できませんでした。',
    hint: '会話は続けられますが、再読み込みで消えます。',
  },
});

export { ErrorCode };
