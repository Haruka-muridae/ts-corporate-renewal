import type { Metadata } from "next";
import type { ReactNode } from "react";

/*
 * 管理画面の枠。
 *
 * 一般公開のルートから分離する（仕様書9章）。検索結果にも出さない。
 * 認証の判定は各ページの requireAdmin() が行う。レイアウトでは行わない
 * （レイアウトはログイン画面にも適用されるため）。
 */

export const metadata: Metadata = {
  title: "管理画面｜TSAMビジネス&フレンド交流会",
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <>
      <link rel="stylesheet" href="/css/style.css" />
      <link rel="stylesheet" href="/event/style.css" />
      <link rel="stylesheet" href="/event/apply.css" />
      <link rel="stylesheet" href="/event/admin.css" />
      {children}
    </>
  );
}
