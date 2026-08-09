import type { Store, Scene, Deps } from './port.d.mts';

export const MIN_SCENES: number;
/** AC-09 の検証。純粋関数。 */
export function validateScenes(
  scenes: unknown,
): { ok: true } | { ok: false; reason: string };
export function replaceScenes(
  store: Store,
  versionId: string,
  scenes: Array<{ narration: string; visualPrompt: string; subtitle?: string | null }>,
  deps?: Deps,
): Promise<Scene[]>;
export function listScenes(store: Store, versionId: string): Promise<Scene[]>;
