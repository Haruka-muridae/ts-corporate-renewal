import type { Store, Project, Deps } from './port.d.mts';

export function createProject(
  store: Store,
  input: { sourceText: string; title?: string; audience?: string; note?: string },
  deps?: Deps,
): Promise<Project>;
export function getProject(store: Store, id: string): Promise<Project | null>;
export function updateProject(
  store: Store, id: string, patch: Partial<Project>, deps?: Deps,
): Promise<Project>;
export function listProjects(
  store: Store, options?: { includeArchived?: boolean },
): Promise<Project[]>;
export function deleteProject(store: Store, id: string): Promise<void>;
