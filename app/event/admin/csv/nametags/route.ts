import { currentAdmin } from "@/lib/event/admin-session";
import { NAMETAG_CSV_COLUMNS, nametagRows } from "@/lib/event/admin-view.mjs";
import { isUuid } from "@/lib/event/application-input.mjs";
import { supabaseConfig } from "@/lib/event/config.mjs";
import { buildCsv, csvFileName } from "@/lib/event/csv.mjs";
import { findEventById, listApplications } from "@/lib/event/db.mjs";

/*
 * 名札印刷用のCSV（仕様書9章の②）。
 *
 * 支払済みのみ、氏名・会社名・業界・職種・立場の5項目だけ。
 * 年齢は載せない（仕様書7.3。当日の名札に年齢を記載しないため）。
 * ?eventId= を指定した回だけに絞れる（無指定は従来どおり全回）。
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if ((await currentAdmin()) === null) {
    return new Response("unauthorized", { status: 401 });
  }

  const config = supabaseConfig();
  const eventId = new URL(request.url).searchParams.get("eventId");

  /* 申込者CSVと同じ。UUID以外は問い合わせに載せずここで断る（認可の後）。 */
  if (eventId !== null && !isUuid(eventId)) {
    return new Response("bad request", { status: 400 });
  }

  const applications = await listApplications(config, { eventId });
  const csv = buildCsv(NAMETAG_CSV_COLUMNS, nametagRows(applications));

  const event = eventId ? await findEventById(config, eventId) : null;
  const fileDate = event ? new Date(event.event_date) : new Date();

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        `attachment; filename="${csvFileName("nametags", fileDate)}"`,
      "Cache-Control": "no-store",
    },
  });
}
