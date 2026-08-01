# 仕様書ディレクトリ

このディレクトリの仕様書は、**実装の正**です。

コードと仕様書が食い違っている場合、コードのほうが間違っているとみなすのが既定の解釈です。
実装を進める際は、まず該当する仕様書を読んでください。

---

## 現在の有効な仕様書

| 仕様書 | 対象範囲 | 版 |
| --- | --- | --- |
| [login-page-detailed-spec-v3.md](./login-page-detailed-spec-v3.md) | `/login/index.html` ＋ `public/auth/` 共通層 ＋ `gas-auth/`（ログイン関連部分） | v3.2 |
| [pricing-consent-spec-v1.md](./pricing-consent-spec-v1.md) | `/pricing/` の同意フロー ＋ `gas-auth/Consent.gs` ＋ `/legal/` 3ページ | v1 |
| [legal-cms-spec-v1.md](./legal-cms-spec-v1.md) | 法務文書のスプレッドシート管理 ＋ `gas-auth/Legal.gs` ＋ `/legal/` の生成と公開 | v1 |
| [portal-spec-v1.md](./portal-spec-v1.md) | `/portal/` のレイアウトと表示条件 | v1.4 |
| [keystore-spec-v1.md](./keystore-spec-v1.md) | 外部AIサービスのAPIキーの保管（`public/auth/keystore.js`）。端末内のみ・サーバーへ送らない | v1 |
| [apps-grid-spec-v1.md](./apps-grid-spec-v1.md) | `/portal/` のアプリグリッド（ページ式）と配置データ ＋ `public/portal/app-registry.js` | v1 |

参照するときは、セクション番号（§n）で指し示してください。
行番号は変わるため使いません。

これらの仕様書が対象とするのは **TSAM AI 本体** です。
同居する別プロジェクト（`labs/`）はスコープ外とします
（[../repository-structure.md](../repository-structure.md)）。

---

## `legal/*/index.html` は生成物です

`legal/terms/index.html` `legal/privacy/index.html` `legal/tokusho/index.html` を
**手で編集しないでください。** スプレッドシート「TSAM AI 法務文書」から生成され、
次の公開操作で上書きされます。

これらのファイルへの手編集を含む変更は、取り込まずに差し戻してください。
条文の修正はスプレッドシート側で行い、`publishLegalDocs()` で公開します。
詳細は [legal-cms-spec-v1.md](./legal-cms-spec-v1.md) §1-1 を参照してください。

関連する作業指示書は [../instructions/](../instructions/) にあります。

---

## 仕様書と実装が食い違ったときのルール

**黙って乖離させないこと。** 食い違いを見つけたら、次のいずれかを選び、
**仕様書と実装の両方が揃った状態**にしてから作業を終えます。

| 判断 | 行うこと |
| --- | --- |
| 仕様書が正しい | 実装を仕様書に合わせる |
| 実装が正しい | 仕様書を実装に合わせて更新する（理由を本文へ残す） |
| どちらとも決められない | 実装せずに、判断が必要な点として報告する |

「実装がこうなっているから」という理由だけで仕様書を書き換えないでください。
逆に、「仕様書にこう書いてあるから」という理由だけで、
安全性に関わる実装を変えないでください。

各仕様書には設計判断の記録（採用しなかった提案とその理由）を含む節があります。
仕様を変えようとする前に、その節を読んでください。
一度検討して却下された案を、理由を知らずに再提案することを避けるためです。

---

## このディレクトリの内容は公開されます

GitHub Pages がリポジトリのルートを配信しているため、
`docs/` 配下もそのまま公開されます。

**秘密情報（鍵・トークン・スプレッドシートID・内部URL・実在するメールアドレス）を
仕様書へ書かないでください。** 追加・更新の際は、配置前に確認してください。
