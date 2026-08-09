/** Flow へ貼るテキスト。**差し込み口を残したまま**返す。 */
export function buildFlowText(stageId: string): string;
export function buildAllFlowTexts(): Array<{ fileName: string; content: string }>;
