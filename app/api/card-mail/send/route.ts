import { NextResponse } from "next/server";

import { apiToken, gmailConfig } from "@/lib/card-mail/config.mjs";
import {
  extractBearerToken,
  parseSendRequest,
  chunkRecipients,
  sendBulkMail,
  tokenEquals,
} from "@/lib/card-mail/bulk.mjs";

/*
 * 名刺メール配信API（docs/specs/card-mail-api-v1.md）。
 *
 * POST /api/card-mail/send/ … 宛先一覧をBCCで一斉送信する。
 * trailingSlash: true のため、**末尾スラッシュ付きのURLへPOSTすること**。
 * スラッシュなしは308になり、多くのHTTPクライアントはPOSTのリダイレクトで
 * 本文を落とす（Stripe Webhook と同じ罠）。
 *
 * 検証や送信計画の組み立ては lib/card-mail/bulk.mjs にあり、
 * ここではHTTPとの境界（認証・パース・状態コード）だけを扱う。
 */

/* 認証と送信を伴うため、リクエストごとに必ず実行する。キャッシュしない。 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let expectedToken: string;

  try {
    expectedToken = apiToken();
  } catch {
    /* トークン未設定＝全拒否。設定漏れは自分たちの問題なので500。 */
    console.error("[card-mail] CARD_MAIL_API_TOKEN が未設定です");
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  const token = extractBearerToken(request.headers.get("authorization"));

  if (!tokenEquals(token ?? "", expectedToken)) {
    /* 「形式が違う」と「値が違う」を区別しない。探る手掛かりにしない。 */
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "リクエスト本文がJSONではありません" },
      { status: 400 },
    );
  }

  let parsed;

  try {
    parsed = parseSendRequest(body);
  } catch (error) {
    const invalid = (error as { invalidRecipients?: string[] }).invalidRecipients;

    return NextResponse.json(
      {
        error: (error as Error).message,
        ...(invalid ? { invalidRecipients: invalid } : {}),
      },
      { status: 400 },
    );
  }

  if (parsed.dryRun) {
    /* 1通も送らずに、何がどう送られるかだけを返す。 */
    return NextResponse.json({
      dryRun: true,
      recipientCount: parsed.recipients.length,
      duplicateCount: parsed.duplicateCount,
      batchCount: chunkRecipients(parsed.recipients).length,
    });
  }

  let config;

  try {
    config = gmailConfig();
  } catch (error) {
    /* どの環境変数が無いかはメッセージに載る（値は載らない）。 */
    console.error(`[card-mail] 送信設定の不備: ${(error as Error).message}`);
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  try {
    const result = await sendBulkMail({
      subject: parsed.subject,
      text: parsed.text,
      recipients: parsed.recipients,
      replyTo: parsed.replyTo,
      from: config.from,
      credentials: config.credentials,
    });

    /* 何をしたかは追えるようにする。宛先アドレスはログに書かない。 */
    console.log(
      `[card-mail] 一斉送信: ${result.sentCount} 件 / ${result.batches.length} 通`,
    );

    return NextResponse.json({
      sentCount: result.sentCount,
      duplicateCount: parsed.duplicateCount,
      batches: result.batches,
    });
  } catch (error) {
    /*
     * 送ってしまった分は取り消せない。どこまで送れたかを必ず返し、
     * 呼び出し側が「残りだけ送り直す」を判断できるようにする。
     */
    const sentCount = (error as { sentCount?: number }).sentCount ?? 0;

    console.error(
      `[card-mail] 一斉送信に失敗（送信済み ${sentCount} 件）: ${(error as Error).message}`,
    );

    return NextResponse.json(
      { error: "送信が途中で失敗しました", sentCount },
      { status: 502 },
    );
  }
}
