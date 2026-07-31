import { currentAdmin } from "@/lib/event/admin-session";
import { redirect } from "next/navigation";

import { LoginForm } from "./LoginForm";

/* ログイン状態はCookie次第。キャッシュに載せない。 */
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  /* すでにログイン済みなら一覧へ送る。 */
  if ((await currentAdmin()) !== null) {
    redirect("/event/admin/");
  }

  return (
    <main id="main-content" className="admin-login">
      <div className="admin-login__panel">
        <h1 className="admin-login__title">交流会 管理画面</h1>
        <p className="admin-login__note">
          管理者用の画面です。登録済みのメールアドレスでログインしてください。
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
