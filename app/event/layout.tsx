import type { Metadata } from "next";
import type { ReactNode } from "react";

/*
 * 交流会アプリ（/event/apply 以降）の共通枠。
 *
 * 見た目は既存の静的サイトに合わせる。public/css/style.css と
 * public/event/style.css をそのまま読み込むことで、
 * 静的の詳細ページ（/event/）と同じ体裁になる。
 * app/globals.css（リニューアル版LP用）はここでは読み込まない。
 */

export const metadata: Metadata = {
  title: "お申し込み｜TSAMビジネス&フレンド交流会",
  description:
    "TSAMビジネス&フレンド交流会のお申し込みフォームです。ご入力いただいた属性に応じて参加費を計算し、確認画面でご確認いただいてから決済へお進みいただきます。",
  /* 申込フォームは検索結果に出す必要がない。入口は /event/ に集約する。 */
  robots: { index: false, follow: true },
};

export default function EventLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <>
      <link
        rel="preconnect"
        href="https://fonts.googleapis.com"
      />
      <link
        rel="preconnect"
        href="https://fonts.gstatic.com"
        crossOrigin=""
      />
      <link
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Noto+Sans+JP:wght@400;500;700&display=swap"
        rel="stylesheet"
      />
      <link rel="stylesheet" href="/css/style.css" />
      <link rel="stylesheet" href="/event/style.css" />
      <link rel="stylesheet" href="/event/apply.css" />

      <a className="skip-link" href="#main-content">
        本文へスキップ
      </a>

      <header id="header" className="site-header">
        <div className="container site-header__inner">
          <a
            className="site-logo"
            href="/"
            aria-label="TSアセットマネジメント合同会社 トップページ"
          >
            <span className="site-logo__mark" aria-hidden="true">
              TS
            </span>
            <span className="site-logo__text">
              <span className="site-logo__name">
                TSアセットマネジメント合同会社
              </span>
              <span className="site-logo__name-en" lang="en">
                TS ASSET MANAGEMENT LLC
              </span>
            </span>
          </a>
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>
        {children}
      </main>

      <footer id="footer" className="site-footer">
        <div className="container">
          <div className="site-footer__main">
            <div className="site-footer__info">
              <p className="site-footer__name">TSアセットマネジメント合同会社</p>
              <address className="site-footer__address">
                <p>〒249-0002 神奈川県逗子市久木8-8-26</p>
                <p>
                  <a href="mailto:architect@potenitas.com">
                    architect@potenitas.com
                  </a>
                </p>
              </address>
            </div>

            <nav className="footer-nav" aria-label="フッターナビ">
              <ul className="footer-nav__list">
                <li>
                  <a href="/event/">交流会のご案内</a>
                </li>
                <li>
                  <a href="/event/legal.html">特定商取引法に基づく表記</a>
                </li>
                <li>
                  <a href="/">コーポレートサイト</a>
                </li>
              </ul>
            </nav>
          </div>

          <div className="site-footer__bottom">
            <small>
              Copyright &copy; TS Asset Management LLC. All Rights Reserved.
            </small>
          </div>
        </div>
      </footer>
    </>
  );
}
