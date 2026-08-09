export interface GeneratedFile { readonly path: string; readonly content: string }
export function outputs(): GeneratedFile[];
/** 差分のあるファイル。空なら最新。 */
export function diff(): GeneratedFile[];
