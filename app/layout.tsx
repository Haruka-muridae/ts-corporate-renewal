import type { Metadata } from "next";
import type { ReactNode } from "react";

/*
 * Next.js 側のルートレイアウト。
 *
 * 現在 Next が担当するのは /event/apply 以降だけで、見た目は
 * 既存の静的サイト（public/css/style.css）に合わせる。
 * そのため、ここでは app/globals.css（リニューアル版LP用の Tailwind と
 * リセット）を読み込まない。読み込むと静的サイトの体裁と衝突する。
 *
 * リニューアル版LP（lp-draft/）を Next 側で公開する判断をしたときは、
 * ルートグループ（app/(lp)/layout.tsx と app/(event)/layout.tsx）へ分け、
 * LP側のレイアウトでのみ globals.css を読み込むこと。
 */

export const metadata: Metadata = {
  title: "TSアセットマネジメント合同会社",
  description:
    "TSアセットマネジメント合同会社は、保険数理・データ分析・AIを軸に、コンサルティング、システム開発、業務自動化、教育事業を行っています。",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
