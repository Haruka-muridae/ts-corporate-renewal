import type { Store } from './port.d.mts';
/** ブラウザ専用。サーバーコンポーネントから import しないこと。 */
export function openDatabase(options?: { factory?: IDBFactory }): Promise<IDBDatabase>;
export function createIndexedDbStore(db: IDBDatabase): Store;
