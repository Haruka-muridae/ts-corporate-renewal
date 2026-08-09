import type { Store, Version, Stage, Deps } from './port.d.mts';

export function createVersion(
  store: Store,
  input: {
    projectId: string; stage: Stage; body?: string;
    parentVersionId?: string | null; editedByUser?: boolean;
  },
  deps?: Deps,
): Promise<Version>;
export function listVersions(store: Store, projectId: string, stage: Stage): Promise<Version[]>;
export function getAdopted(store: Store, projectId: string, stage: Stage): Promise<Version | null>;
export function adoptVersion(store: Store, versionId: string): Promise<Version>;
export function editVersionBody(store: Store, versionId: string, body: string): Promise<Version>;
export function collectUpstream(
  store: Store, projectId: string, stage: Stage,
): Promise<Array<{ stage: Stage; body: string; editedByUser: boolean }>>;
export function canGenerate(store: Store, projectId: string, stage: Stage): Promise<boolean>;
