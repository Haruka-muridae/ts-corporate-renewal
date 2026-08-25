/*
 * Web 側は public/meeting-assistant/native-bridge.js が
 * globalThis.Capacitor.Plugins.NativeRecorder を直接使う。
 * PC ブラウザではこのモジュールを読み込まない。
 */

export const NativeRecorder = undefined;
