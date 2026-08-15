import { NextResponse } from "next/server";

import {
  buildContactMail,
  validateContactInput,
  CONTACT_TO,
} from "@/lib/contact/message.mjs";
import { gmailConfig } from "@/lib/event/config.mjs";
import { sendMail } from "@/lib/event/mail/gmail.mjs";

/*
 * セキュアAIエージェント開発環境 LP（public/secure-ai-agent/）の
 * 問い合わせフォームの受け口。
 *
 * gmailConfig / sendMail は交流会アプリのモジュールだが、どちらも
 * 交流会固有の知識を持たない汎用部品（環境変数の読み口と Gmail 送信）。
 * OAuth 送信処理を複製すると更新漏れの温床になるため、複製せず再利用する。
 * 交流会側の都合でこれらの引数仕様が変わった場合は、ここも追従が必要。
 *
 * DB には何も保存しない。問い合わせはメール1通で完結させ、
 * 個人情報の保存先を増やさない。
 */

/* フォームの入力を毎回検証して送る。キャッシュしない。 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  /*
   * honeypot（画面上は見えない website 欄）。値が入っていたらボットとみなすが、
   * エラーではなく成功を装って返す。失敗が返るとボットが手口を変えるため。
   */
  if (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { website?: unknown }).website === "string" &&
    (body as { website: string }).website !== ""
  ) {
    return NextResponse.json({ ok: true });
  }

  const result = validateContactInput(body);

  if (!result.ok) {
    /* 入力値そのものは返さない・記録しない。項目名だけで原因は分かる。 */
    return NextResponse.json(
      { error: "validation", details: result.errors },
      { status: 400 },
    );
  }

  let config;

  try {
    config = gmailConfig();
  } catch (error) {
    /* 設定漏れは自分たちの問題。利用者には汎用の失敗として返す。 */
    console.error(`[contact] メール設定が未設定: ${(error as Error).message}`);
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  const mail = buildContactMail(result.value);

  try {
    await sendMail({
      from: config.from,
      to: CONTACT_TO,
      subject: mail.subject,
      text: mail.text,
      /* 通知メールへそのまま返信すれば問い合わせ者に届くようにする。 */
      replyTo: result.value.email,
      credentials: config.credentials,
    });
  } catch (error) {
    /* 例外メッセージに資格情報は入らない（gmail.mjs 側で保証）。 */
    console.error(`[contact] 送信に失敗: ${(error as Error).message}`);
    return NextResponse.json({ error: "send failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
