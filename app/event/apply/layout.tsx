import type { ReactNode } from "react";

/*
 * 申込フロー（/event/apply/ 以降）だけにテーマCSSを当てる枠。
 *
 * app/event/layout.tsx に追加すると、入れ子の関係で /event/admin/ 配下にも
 * 波及する（管理画面は業務ツールのため対象外）。ここに置くことで
 * 適用範囲を /event/apply/, /confirm/, /done/, /canceled/ に限定する。
 *
 * 既存CSS（/css/style.css → /event/style.css → /event/apply.css）は
 * app/event/layout.tsx が読み込む。theme.css はそれより後に来る必要があるため、
 * 子である このレイアウトで読み込む。
 *
 * マークアップは children をそのまま返すだけで、DOM構造は変えない。
 */

export default function ApplyThemeLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <>
      {/* 見出し用の明朝と、英字ラベル用の Cormorant Garamond。静的ページと同じ family 指定。 */}
      <link
        href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Noto+Serif+JP:wght@500;600;700&display=swap"
        rel="stylesheet"
      />
      <link rel="stylesheet" href="/event/theme.css" />
      {children}
    </>
  );
}
