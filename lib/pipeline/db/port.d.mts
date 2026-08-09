/*
 * ストアポートの型。
 *
 * memory.mjs（テスト用）と indexeddb.mjs（ブラウザ用）が
 * この形を返す。projects.mjs 以下はこの型に対して書く。
 */

export type StoreName = 'projects' | 'versions' | 'scenes' | 'settings' | 'meta';

/** 索引の値。複合索引には配列を渡す。 */
export type IndexValue = string | number | Array<string | number>;

export interface Store {
  get(store: StoreName, key: string): Promise<Record<string, unknown> | null>;
  getAll(store: StoreName): Promise<Array<Record<string, unknown>>>;
  getAllBy(
    store: StoreName,
    index: string,
    value: IndexValue,
  ): Promise<Array<Record<string, unknown>>>;
  put<T extends Record<string, unknown>>(store: StoreName, record: T): Promise<T>;
  putAll<T extends Record<string, unknown>>(store: StoreName, records: T[]): Promise<T[]>;
  remove(store: StoreName, key: string): Promise<void>;
  removeAll(store: StoreName, keys: string[]): Promise<void>;
  clearAll(): Promise<void>;
  close(): void;
}

export type Stage = 'threads' | 'x' | 'note' | 'script' | 'metadata';

export interface Project {
  id: string;
  sourceText: string;
  title: string;
  audience: string;
  note: string;
  status: 'draft' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface Version {
  id: string;
  projectId: string;
  stage: Stage;
  body: string;
  versionNo: number;
  parentVersionId: string | null;
  adopted: boolean;
  editedByUser: boolean;
  createdAt: string;
}

export interface Scene {
  id: string;
  versionId: string;
  order: number;
  narration: string;
  visualPrompt: string;
  subtitle: string | null;
}

/** テストで日時とIDを固定するための注入口。 */
export interface Deps {
  now?: () => string;
  cryptoImpl?: { randomUUID: () => string };
}
