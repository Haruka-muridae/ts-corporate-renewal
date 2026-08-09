import type { StageId } from './definitions.d.mts';

/** 前段の採用文。editedByUser は要件15章の「ユーザー編集を優先」に効く。 */
export interface UpstreamItem {
  readonly stage: StageId | string;
  readonly label?: string;
  readonly body: string;
  readonly editedByUser?: boolean;
}

export interface PromptInput {
  readonly source: string;
  readonly upstream?: readonly UpstreamItem[];
  /** settings の値。空なら段階の既定値へ戻る。 */
  readonly length?: string;
  readonly tone?: string;
}

/** 段階の固定部分。差し込み口（{{…}}）は残る。 */
export function buildTemplate(stageId: string): string;

/** 差し込み口を埋める。空の値はその行ごと落とし、直前の見出しも落とす。 */
export function render(template: string, values: Record<string, string>): string;

export function formatUpstream(upstream: readonly UpstreamItem[] | null | undefined): string;

/** 最後まで組み立てる。第2段の LlmClient はこれを呼ぶ。 */
export function buildPrompt(stageId: string, input: PromptInput): string;
