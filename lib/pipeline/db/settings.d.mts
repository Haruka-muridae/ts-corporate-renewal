import type { Store } from './port.d.mts';

export const DEFAULT_SETTINGS: Readonly<Record<string, string | number>>;
export function getSetting(store: Store, key: string): Promise<unknown>;
export function setSetting(store: Store, key: string, value: unknown): Promise<unknown>;
export function getAllSettings(store: Store): Promise<Record<string, unknown>>;
export function getMeta(store: Store, key: string): Promise<unknown>;
export function setMeta(store: Store, key: string, value: unknown): Promise<unknown>;
export function hasSeenWelcome(store: Store): Promise<boolean>;
export function markWelcomeSeen(store: Store): Promise<unknown>;
