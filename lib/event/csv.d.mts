/*
 * lib/event/csv.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

export declare const BOM: string;

export declare function escapeCsvValue(value: unknown): string;

export declare function buildCsv(
  columns: { header: string; key: string }[],
  rows: Record<string, unknown>[],
): string;

export declare function csvFileName(prefix: string, date: Date): string;
