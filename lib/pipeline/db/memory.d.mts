import type { Store } from './port.d.mts';
/** テスト用のメモリ実装。IndexedDB と同じポートを返す。 */
export function createMemoryStore(): Store;
