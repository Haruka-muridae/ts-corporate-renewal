import { currentAdmin } from "@/lib/event/admin-session";
import { NAMETAG_CSV_COLUMNS, nametagRows } from "@/lib/event/admin-view.mjs";
import { supabaseConfig } from "@/lib/event/config.mjs";
import { buildCsv, csvFileName } from "@/lib/event/csv.mjs";
import { listApplications } from "@/lib/event/db.mjs";

/*
 * 名札印刷用のCSV（仕様書9章の②）。
 *
 * 支払済みのみ、氏名・会社名・業界・職種・立場の5項目だけ。
 * 年齢は載せない（仕様書7.3。当日の名札に年齢を記載しないため）。
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if ((await currentAdmin()) === null) {
    return new Response("unauthorized", { status: 401 });
  }

  const applications = await listApplications(supabaseConfig());
  const csv = buildCsv(NAMETAG_CSV_COLUMNS, nametagRows(applications));

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        `attachment; filename="${csvFileName("nametags", new Date())}"`,
      "Cache-Control": "no-store",
    },
  });
}
