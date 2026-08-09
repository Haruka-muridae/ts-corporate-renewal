/** 段階ID。並び順に意味がある（前段→次段）。 */
export type StageId = 'threads' | 'x' | 'note' | 'script' | 'metadata';

export interface StageDefinition {
  readonly id: StageId;
  readonly label: string;
  /** この段階の生成に渡す前段。要件15章。 */
  readonly upstreamStages: readonly StageId[];
  /** 生成する案の数（FR-013）。1 なら単一出力。 */
  readonly candidates: number;
  readonly settingKey: string;
  readonly defaultLength: string;
  readonly role: string;
  readonly instructions: readonly string[];
  readonly outputSpec: readonly string[];
}

export const COMMON_RULES: string;

/** 出力の区切り記号。**プロンプトと解析側が同じ定義を見る。** */
export const DELIMITER: Readonly<{
  CANDIDATE: string; SCENE: string; NARRATION: string;
  VISUAL: string; TITLES: string; BODY: string;
}>;

/** 差し込み口。flow-text ではこの文字列がそのまま残る。 */
export const PLACEHOLDER: Readonly<{
  SOURCE: string; UPSTREAM: string; LENGTH: string; TONE: string;
}>;

export const STAGES: readonly StageDefinition[];
export const STAGE_IDS: readonly StageId[];
export function findStage(stageId: string): StageDefinition | null;
