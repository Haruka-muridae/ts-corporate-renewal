import { currentAdmin } from "@/lib/event/admin-session";
import {
  APPLICATION_CSV_COLUMNS,
  toAdminRow,
} from "@/lib/event/admin-view.mjs";
import { supabaseConfig } from "@/lib/event/config.mjs";
import { buildCsv, csvFileName } from "@/lib/event/csv.mjs";
import { listApplications } from "@/lib/event/db.mjs";

/*
 * 申込者一覧のCSV（仕様書9章の①）。
 * 一覧と同じ項目を全件出す。
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  /* 未ログインには渡さない（受入条件10）。 */
  if ((await currentAdmin()) === null) {
    return new Response("unauthorized", { status: 401 });
  }

  const applications = await listApplications(supabaseConfig());
  const csv = buildCsv(APPLICATION_CSV_COLUMNS, applications.map(toAdminRow));

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        `attachment; filename="${csvFileName("applications", new Date())}"`,
      "Cache-Control": "no-store",
    },
  });
}
