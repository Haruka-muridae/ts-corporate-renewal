"use server";

import { redirect } from "next/navigation";

import { validateApplicationInput } from "@/lib/event/application-input.mjs";
import { SOLD_OUT_MESSAGE, isEventSoldOut } from "@/lib/event/capacity.mjs";
import { baseUrl, stripeSecretKey, supabaseConfig } from "@/lib/event/config.mjs";
import {
  attachCheckoutSession,
  findApplicationById,
  findEventById,
  findPaymentByApplicationId,
  insertApplication,
  insertPayment,
  updateApplicationStatus,
} from "@/lib/event/db.mjs";
import { formatEventDateLabel } from "@/lib/event/mail/confirmation.mjs";
import { calculatePrice } from "@/lib/event/pricing.mjs";
import { isEventAcceptingNow } from "@/lib/event/schedule.mjs";
import { createCheckoutSession } from "@/lib/event/stripe.mjs";

export type ApplyFormState = {
  errors: Record<string, string>;
  /* 入力し直しのために、送信された値をそのまま返す。 */
  values: Record<string, string>;
};

/* 再入力のために保持する項目。同意チェックは毎回入れ直してもらう。 */
const KEPT_FIELDS = [
  "eventId",
  "name",
  "nameKana",
  "email",
  "phone",
  "company",
  "department",
  "jobTitle",
  "industry",
  "industryOtherText",
  "occupation",
  "occupationOtherText",
  "position",
  "ageGroup",
  "isBannedDeclared",
];

function toPlainObject(formData: FormData): Record<string, string> {
  const raw: Record<string, string> = {};

  formData.forEach((value, key) => {
    if (typeof value === "string") {
      raw[key] = value;
    }
  });

  return raw;
}

/**
 * 申込フォームの送信を受ける。
 *
 * 金額はフォームから受け取らない。保存後、確認画面がDBの申込内容から
 * 計算し直して表示する（仕様書5.1、受入条件3）。
 */
export async function submitApplication(
  _state: ApplyFormState,
  formData: FormData,
): Promise<ApplyFormState> {
  const raw = toPlainObject(formData);
  const kept = Object.fromEntries(
    KEPT_FIELDS.map((field) => [field, raw[field] ?? ""]),
  );

  const result = validateApplicationInput(raw);

  if (!result.ok || result.value === null) {
    return { errors: result.errors, values: kept };
  }

  const config = supabaseConfig();

  /*
   * クライアントが選んだ eventId は信用しない（金額と同じ方針）。
   * 実在し、公開中で、受付期間内であることをここで確かめ直す。
   * 3つのどれか1つでも欠けたら、区別せず同じ文言で止める
   * （不正なIDと、選んだ後に受付終了になったケースを利用者側で分ける意味がないため）。
   */
  const event = await findEventById(config, result.value.eventId);
  const now = new Date();

  if (event === null || !isEventAcceptingNow(event, now)) {
    return {
      errors: { form: "選択された開催日は現在受け付けていません。" },
      values: kept,
    };
  }

  /*
   * 定員に達していたら、申込を保存せずここで止める。
   * 決済まで進んでから断るより早い段階で気づける。
   * 最終的な防波堤は startCheckout 側（表示や保存を経ずに送られても効く）。
   */
  if (await isEventSoldOut(config, event)) {
    return { errors: { form: SOLD_OUT_MESSAGE }, values: kept };
  }

  const application = await insertApplication(config, {
    ...result.value,
    eventId: event.id,
    /* 同意した時刻と、そのとき提示していたポリシーの版を残す（仕様書4.2）。 */
    agreedAt: now.toISOString(),
    policyVersion: event.policy_version,
  });

  if (application === null) {
    return {
      errors: {
        form: "お申し込みを保存できませんでした。時間をおいてお試しください。",
      },
      values: kept,
    };
  }

  /* 割引の内訳を申込時点のスナップショットとして保存する。 */
  await insertPayment(config, {
    applicationId: application.id,
    breakdown: calculatePrice(result.value),
  });

  redirect(`/event/apply/confirm/?id=${application.id}`);
}

/**
 * 確認画面の「決済へ進む」。
 *
 * 金額はここでもDBの申込内容から計算し直す。
 * ブラウザから届く値は申込IDだけで、金額は受け取らない（受入条件3）。
 */
export async function startCheckout(formData: FormData): Promise<void> {
  const applicationId = String(formData.get("applicationId") ?? "");

  if (applicationId === "") {
    redirect("/event/apply/");
  }

  const config = supabaseConfig();
  const application = await findApplicationById(config, applicationId);

  if (application === null) {
    redirect("/event/apply/");
  }

  const event = await findEventById(config, application.event_id);

  if (event === null) {
    redirect("/event/apply/");
  }

  /*
   * 公開状態と受付期間の最終確認。
   *
   * 確認画面のURL（?id=）は申込者の手元に残るため、受付が終わったあと・
   * カレンダー側で回が消えて非公開になったあとに開き直せる。そこから
   * 決済を始められると、受け付けていない回の支払いが発生してしまう
   * （返金は「参加者都合ではないキャンセル」として手作業になる）。
   *
   * 満席のときと同じく申込ページへ戻す。申込ページ側が
   * 「受け付けている回が無い」案内を出すため、行き止まりにならない。
   */
  if (!isEventAcceptingNow(event, new Date())) {
    redirect("/event/apply/");
  }

  /*
   * 定員の最終確認。ここが防波堤になる。
   *
   * 申込ページの表示と submitApplication でも見ているが、どちらも通り抜ける
   * 経路がある（満席になる前に開いたままのタブ、確認画面のURLを直接開く、
   * このサーバーアクションへの再送）。Session を作る直前にもう一度見て、
   * 満席なら作らずに申込ページへ戻す（申込ページが満席の案内を出す）。
   */
  if (await isEventSoldOut(config, event)) {
    redirect("/event/apply/");
  }

  /* 表示時ではなく、決済を開始する直前にもう一度計算する。 */
  const breakdown = calculatePrice({
    industry: application.industry,
    occupation: application.occupation,
    position: application.position,
    ageGroup: application.age_group,
    isBannedDeclared: application.is_banned_declared,
  });

  const payment = await findPaymentByApplicationId(config, applicationId);

  const session = await createCheckoutSession({
    secretKey: stripeSecretKey(),
    /* 開催日が複数あるため、Stripeの明細・レシートにどの回かが分かるようにする。 */
    eventName: `${event.name}（${formatEventDateLabel(event.event_date)}）`,
    amount: breakdown.finalPrice,
    email: application.email,
    applicationId: application.id,
    eventId: event.id,
    successUrl: `${baseUrl()}/apply/done/?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${baseUrl()}/apply/canceled/?id=${application.id}`,
    /*
     * 申込1件につき Session は1つ。確認画面で連打されても、
     * Stripe 側が同じ Session を返す。
     */
    idempotencyKey: `checkout-${application.id}`,
  });

  if (payment !== null) {
    await attachCheckoutSession(config, payment.id, session.id);
  }

  await updateApplicationStatus(config, application.id, "awaiting");

  redirect(session.url);
}
