"use server";

import { redirect } from "next/navigation";

import { signInWithPassword, signOut } from "@/lib/event/admin-auth.mjs";
import {
  clearSession,
  readSession,
  requireAdmin,
  saveSession,
} from "@/lib/event/admin-session";
import {
  createAttendeeNoteWriter,
  updateAttendeeNote,
} from "@/lib/event/calendar-note.mjs";
import {
  calendarWriteConfigOrNull,
  gmailConfig,
  supabaseAuthConfig,
  supabaseConfig,
} from "@/lib/event/config.mjs";
import {
  countPaidApplications,
  findApplicationById,
  findEventById,
  insertEmailLog,
  listPaidAttendees,
  updateApplicationFields,
} from "@/lib/event/db.mjs";
import { buildConfirmationMail } from "@/lib/event/mail/confirmation.mjs";
import { sendMail } from "@/lib/event/mail/gmail.mjs";
import { calculatePrice } from "@/lib/event/pricing.mjs";

export type LoginState = { error: string };

export async function login(
  _state: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  try {
    const session = await signInWithPassword(supabaseAuthConfig(), {
      email,
      password,
    });

    await saveSession(session);
  } catch (error) {
    /*
     * 画面に出すのは、利用者が対処できる文言だけにする。
     * 設定の不備や通信の失敗は、そのまま出しても利用者には直せず、
     * 内部の事情（英語の例外文やライブラリの都合）が漏れる。
     * 詳細はサーバーのログにだけ残す。
     */
    const failure = error as Error & { isConfigurationError?: boolean };
    const isCredentialError =
      failure.message === "メールアドレスまたはパスワードが正しくありません" ||
      failure.message === "メールアドレスとパスワードを入力してください";

    if (!isCredentialError) {
      console.error(`[admin-login] ログイン処理に失敗: ${failure.message}`, failure.cause ?? "");

      return {
        error:
          "ログインできませんでした。設定に問題がある可能性があります。管理者へご連絡ください。",
      };
    }

    return { error: failure.message };
  }

  redirect("/event/admin/");
}

export async function logout(): Promise<void> {
  const session = await readSession();

  if (session !== null) {
    /* Supabase 側のセッションも失効させる。失敗してもCookieは消す。 */
    await signOut(supabaseAuthConfig(), session.accessToken);
  }

  await clearSession();
  redirect("/event/admin/login/");
}

export type EditState = { error: string; message: string };

/**
 * 申込者情報を書き換える（譲渡対応、仕様書7.2）。
 *
 * 受付番号と支払額は変えない。譲渡先の属性が違っても差額の徴収・返金はしない。
 * 譲渡として書き換えた場合は、譲渡元の氏名とメールを履歴として残す。
 */
export async function updateApplication(
  _state: EditState,
  formData: FormData,
): Promise<EditState> {
  await requireAdmin();

  const applicationId = String(formData.get("applicationId") ?? "");
  const isTransfer = formData.get("isTransfer") === "on";

  if (applicationId === "") {
    return { error: "申込を特定できませんでした。", message: "" };
  }

  const config = supabaseConfig();
  const application = await findApplicationById(config, applicationId);

  if (application === null) {
    return { error: "申込が見つかりません。", message: "" };
  }

  const name = String(formData.get("name") ?? "").trim();
  const nameKana = String(formData.get("nameKana") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const company = String(formData.get("company") ?? "").trim();

  if (name === "" || nameKana === "" || email === "" || phone === "" || company === "") {
    return { error: "氏名・フリガナ・メール・電話・会社名は必須です。", message: "" };
  }

  const patch: Record<string, unknown> = {
    name,
    name_kana: nameKana,
    email,
    phone,
    company,
    department: String(formData.get("department") ?? "").trim() || null,
    job_title: String(formData.get("jobTitle") ?? "").trim() || null,
    admin_memo: String(formData.get("adminMemo") ?? "").trim() || null,
  };

  if (isTransfer) {
    /*
     * 譲渡元の情報は、最初の譲渡のときだけ記録する。
     * 2回目以降の書き換えで上書きすると、元の申込者が分からなくなる。
     */
    patch.is_transferred = true;
    patch.transferred_at = new Date().toISOString();

    if (!application.is_transferred) {
      patch.original_name = application.name;
      patch.original_email = application.email;
    }
  }

  await updateApplicationFields(config, applicationId, patch);

  /*
   * 氏名が変わると、カレンダーの説明欄に書いてある名簿も古くなる
   * （譲渡は「当日その人が来る」ことを意味するので、名簿の氏名が実態と
   * 食い違うと受付で照合できない）。編集の直後に書き戻しておく。
   *
   * 書き戻しは補助的な処理なので、失敗しても編集自体は成功として返す。
   * updateAttendeeNote は例外を投げず、何が起きたかを文字列で返す
   * （トークン未設定・カレンダー連動ではない回も同じ扱い）。理由は
   * サーバーのログにだけ残す。画面に出すと、編集できたのに失敗したように読める。
   */
  const noteResult = await updateAttendeeNote({
    config,
    db: { countPaidApplications, findApplicationById, findEventById, listPaidAttendees },
    writer: createAttendeeNoteWriter(calendarWriteConfigOrNull()),
    applicationId,
  });

  console.log(`[admin-update] ${applicationId}: ${noteResult}`);

  return {
    error: "",
    message: isTransfer
      ? "申込者情報を書き換え、譲渡として記録しました。"
      : "申込者情報を更新しました。",
  };
}

/**
 * 参加確定メールを送り直す（受入条件11）。
 *
 * 譲渡で宛先が変わったあとに、譲渡先へ送るために使う。
 */
export async function resendConfirmationMail(
  _state: EditState,
  formData: FormData,
): Promise<EditState> {
  await requireAdmin();

  const applicationId = String(formData.get("applicationId") ?? "");
  const config = supabaseConfig();
  const application = await findApplicationById(config, applicationId);

  if (application === null) {
    return { error: "申込が見つかりません。", message: "" };
  }

  if (application.receipt_number === null) {
    /* 受付番号は支払済みで発行される。未発行の段階では送らない。 */
    return {
      error: "受付番号が未発行のため送信できません（支払済みになると発行されます）。",
      message: "",
    };
  }

  const event = await findEventById(config, application.event_id);

  if (event === null) {
    return { error: "イベントが見つかりません。", message: "" };
  }

  try {
    const mail = buildConfirmationMail({
      event: {
        name: event.name,
        startAt: event.event_date,
        endAt: event.event_end_at ?? null,
        venue: event.venue,
      },
      application: {
        name: application.name,
        receiptNumber: application.receipt_number,
        industry: application.industry,
        occupation: application.occupation,
        position: application.position,
        ageGroup: application.age_group,
      },
      payment: calculatePrice({
        industry: application.industry,
        occupation: application.occupation,
        position: application.position,
        ageGroup: application.age_group,
        isBannedDeclared: application.is_banned_declared,
      }),
    });

    const gmail = gmailConfig();

    await sendMail({
      from: gmail.from,
      to: application.email,
      subject: mail.subject,
      text: mail.text,
      credentials: gmail.credentials,
    });

    await insertEmailLog(config, {
      applicationId,
      mailType: "confirmation_resend",
      status: "sent",
    });

    return { error: "", message: `${application.email} へ送信しました。`, };
  } catch (error) {
    await insertEmailLog(config, {
      applicationId,
      mailType: "confirmation_resend",
      status: `failed:${String((error as Error).message).slice(0, 200)}`,
    });

    return { error: `送信に失敗しました（${(error as Error).message}）`, message: "" };
  }
}
