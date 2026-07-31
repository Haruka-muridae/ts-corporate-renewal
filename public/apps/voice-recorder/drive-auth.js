/*
 * Drive 認可の実体は ../drive-auth.js へ移した（名刺アプリと共有するため）。
 * 既存の import 文を壊さないよう、このファイルは再エクスポートだけを行う。
 * voice-recorder 固有のデバッグログは、ここで logger を注入して従来どおり出す。
 *
 * ここに認可のロジックを書き足さないこと。処理を変えるときは ../drive-auth.js を直す。
 */
import { setDriveAuthLogger } from '../drive-auth.js';
import { debugLog } from './debug-log.js';

setDriveAuthLogger(debugLog);

export * from '../drive-auth.js';
