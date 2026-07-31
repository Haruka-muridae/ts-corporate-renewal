import { NextResponse } from "next/server";

import { gmailConfig, supabaseConfig } from "@/lib/event/config.mjs";
import * as db from "@/lib/event/db.mjs";
import { sendMail } from "@/lib/event/mail/gmail.mjs";
import { handleStripeEvent } from "@/lib/event/webhook-handler.mjs";
import {
  parseStripeEvent,
  verifyStripeSignature,
} from "@/lib/event/webhook-signature.mjs";

/*
 * Stripe Webhook の受け口（実装仕様書 5.3）。
 *
 * 本文は署名の対象なので、JSONに変換する前の生の文字列を使う。
 * 整形やパースを挟むと署名が一致しなくなる。
 */

/* 署名検証のため、リクエストごとに必ず実行する。キャッシュしない。 */
export const dynamic = "force-dynamic";

/*
 * メール送信の口。資格情報が未設定なら null を返し、
 * 支払の記録だけは進める（メール未設定で決済が壊れないようにする）。
 */
function buildMailer(): { send: (message: { to: string; subject: string; text: string }) => Promise<unknown> } | null {
  let config;

  try {
    config = gmailConfig();
  } catch {
    return null;
  }

  return {
    send: ({ to, subject, text }) =>
      sendMail({
        from: config.from,
        to,
        subject,
        text,
        credentials: config.credentials,
      }),
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    /* 設定漏れは自分たちの問題。Stripeには再送させる。 */
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET が未設定です");
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  const payload = await request.text();
  const header = request.headers.get("stripe-signature") ?? "";

  let event;

  try {
    verifyStripeSignature({ payload, header, secret });
    event = parseStripeEvent(payload);
  } catch (error) {
    /*
     * 検証に失敗したものは受け付けない。
     * 400 を返すと Stripe は再送しない（こちらの設定ミスではなく、
     * 送信元が正しくないため）。本文は記録しない。
     */
    console.warn(
      `[stripe-webhook] 署名の検証に失敗: ${(error as Error).message}`,
    );
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  try {
    const outcome = await handleStripeEvent({
      event,
      config: supabaseConfig(),
      db,
      mailer: buildMailer(),
    });

    /* 何をしたかは追えるようにする。個人情報とキーは書かない。 */
    console.log(
      `[stripe-webhook] ${event.type} ${event.id}: ${outcome.result}`,
    );

    return NextResponse.json({ received: true });
  } catch (error) {
    /*
     * 処理に失敗したときは 500 を返し、Stripe の再送に任せる。
     * webhook_events に処理済みの印は付けていないため、やり直せる。
     */
    console.error(
      `[stripe-webhook] ${event.type} ${event.id} の処理に失敗: ${(error as Error).message}`,
    );
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}
