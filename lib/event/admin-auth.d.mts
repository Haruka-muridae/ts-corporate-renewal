/*
 * lib/event/admin-auth.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

import type { SupabaseAuthConfig } from "./config.mjs";

export type AdminSession = {
  accessToken: string;
  refreshToken: string;
  /** 秒。エポックからの通算。 */
  expiresAt: number;
  email: string;
};

export declare const REFRESH_MARGIN_SECONDS: number;

export declare function signInWithPassword(
  config: SupabaseAuthConfig,
  credentials: { email: string; password: string },
): Promise<AdminSession>;

export declare function refreshSession(
  config: SupabaseAuthConfig,
  refreshToken: string,
): Promise<AdminSession>;

export declare function getUser(
  config: SupabaseAuthConfig,
  accessToken: string,
): Promise<{ id: string; email: string } | null>;

export declare function signOut(
  config: SupabaseAuthConfig,
  accessToken: string,
): Promise<void>;

export declare function needsRefresh(
  session: { expiresAt?: number } | null,
  now?: number,
): boolean;
