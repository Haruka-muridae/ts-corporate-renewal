import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { supabaseAuthConfig } from "@/lib/event/config.mjs";
import {
  getUser,
  needsRefresh,
  refreshSession,
} from "@/lib/event/admin-auth.mjs";

/*
 * 管理画面のセッションをCookieで持ち回る（受入条件10）。
 *
 * アクセストークンはブラウザのJavaScriptから読めない httpOnly Cookie に置く。
 * 画面を開くたびに Supabase へ問い合わせて有効性を確かめる。
 * 期限だけを見て通すと、管理者を削除した直後も入れてしまうため。
 */

const COOKIE_NAME = "tsam-event-admin";

/* 管理画面の外へCookieを送らない。 */
const COOKIE_PATH = "/event/admin";

type StoredSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string;
};

export type AdminUser = {
  id: string;
  email: string;
};

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: COOKIE_PATH,
    /* 本番はHTTPSのみ。ローカルのhttpでも動くよう開発時だけ外す。 */
    secure: process.env.NODE_ENV === "production",
    /* Cookie自体の寿命はリフレッシュトークンに合わせて長めに取る。 */
    maxAge: 60 * 60 * 24 * 14,
  };
}

export async function saveSession(session: StoredSession): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, JSON.stringify(session), cookieOptions());
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, "", { ...cookieOptions(), maxAge: 0 });
}

export async function readSession(): Promise<StoredSession | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as StoredSession;

    if (!parsed?.accessToken || !parsed?.refreshToken) {
      return null;
    }

    return parsed;
  } catch {
    /* 壊れたCookieは無いものとして扱う。 */
    return null;
  }
}

/**
 * ログイン済みの管理者を返す。ログインしていなければログイン画面へ送る。
 *
 * 管理画面の各ページと操作の先頭で必ず呼ぶこと。
 */
export async function requireAdmin(): Promise<AdminUser> {
  const user = await currentAdmin();

  if (user === null) {
    redirect("/event/admin/login/");
  }

  return user;
}

/** ログイン済みなら管理者を返す。していなければ null。 */
export async function currentAdmin(): Promise<AdminUser | null> {
  const stored = await readSession();

  if (stored === null) {
    return null;
  }

  const config = supabaseAuthConfig();
  let session = stored;

  /* 期限が近ければ先に取り直す。 */
  if (needsRefresh(session)) {
    try {
      session = await refreshSession(config, session.refreshToken);
      await saveSession(session);
    } catch {
      await clearSession();
      return null;
    }
  }

  const user = await getUser(config, session.accessToken);

  if (user === null) {
    await clearSession();
    return null;
  }

  return user;
}
