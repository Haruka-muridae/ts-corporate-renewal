import type { Store, Project, Version, Scene, Deps } from './port.d.mts';

export const EXPORT_FORMAT: string;

export interface ExportPayload {
  format: string; exportedAt: string;
  projects: Project[]; versions: Version[]; scenes: Scene[];
  settings: Array<{ key: string; value: unknown }>;
}

export function exportAll(store: Store, deps?: Deps): Promise<ExportPayload>;
export function importAll(
  store: Store, payload: unknown, options?: { mode?: 'merge' | 'replace' },
): Promise<{ projects: number; versions: number; scenes: number; settings: number }>;
export function clearEverything(store: Store): Promise<void>;
