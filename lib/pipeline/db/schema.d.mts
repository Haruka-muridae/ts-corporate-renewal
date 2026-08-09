import type { Store, Stage } from './port.d.mts';

export const DB_NAME: string;
export const DB_VERSION: number;
export const STORE: {
  readonly PROJECTS: 'projects'; readonly VERSIONS: 'versions'; readonly SCENES: 'scenes';
  readonly SETTINGS: 'settings'; readonly META: 'meta';
};
export interface StoreDef {
  name: string; keyPath: string;
  indexes: Array<{ name: string; keyPath: string | string[]; options?: IDBIndexParameters }>;
}
export const STORES_V1: readonly StoreDef[];
export const MIGRATIONS: readonly { from: number; to: number; createStores?: readonly StoreDef[] }[];
export const ID_PREFIX: Readonly<Record<string, string>>;
export const STAGES: readonly Stage[];
export function previousStage(stage: Stage): Stage | null;
export function makeId(storeName: string, cryptoImpl?: { randomUUID: () => string }): string;
export type { Store };
