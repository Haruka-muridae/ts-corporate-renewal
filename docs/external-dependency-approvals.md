# 外部依存の承認記録

制定: 2026年8月3日

[AGENTS.md](../AGENTS.md) は「外部ライブラリを追加する前に、必ずユーザーへ確認する」
と定めている。**確認の記録は残す義務まではないが、残さないと次の作業者が
「これは承認済みなのか」を判断できない。** この文書はその記録である。

外部ライブラリを追加するときは、確認を取ったうえで下の表へ1行足す。
承認が取れていないものを先に実装しない。

---

## 1. 承認済みの外部依存

| 依存 | 配信元 | 対象範囲 | 用途 | 承認日 |
| --- | --- | --- | --- | --- |
| Google Identity Services（GIS） | `https://accounts.google.com/gsi/client`（Google本体） | `public/production-app/card-ocr/`（名刺OCRアプリ） | Drive / Sheets API を呼ぶための OAuth トークン取得（トークンモデル） | 2026-08-03 |

### 1-1. Google Identity Services（名刺OCRアプリ）

**承認の範囲**: 名刺OCRアプリ（`card-ocr`）が Google の OAuth トークンを取得する目的に限る。
他のアプリや他の用途へ広げるときは、あらためて確認を取る。

**根拠**: [specs/meishi-ocr-requirements-v3.md](./specs/meishi-ocr-requirements-v3.md)
§4.3（使用サービス）、§6 前提条件3〜4、FR-24（Google OAuth連携）、§14.3（入力値の取扱い）。

**なぜ自前で書かないか**: OAuth のトークン取得フローは Google 側の仕様に追従する必要があり、
公式クライアントを使うのが最も安全で、仕様変更にも追従できる。
自前実装すると、Google 側の変更のたびに認可が壊れる。

**同梱（vendor）しない**: このスクリプトは Google が更新する前提で配信されている。
`public/apps/vendor/` の lamejs や supabase-auth-js のようにファイルを固定すると、
Google 側の変更に追従できず、かえって壊れる。
したがって **SRI（integrity 属性）も付けられない**。この点は承認のうえで受け入れる。

**制約**:

- 読み込み先は `https://accounts.google.com/gsi/client` のみ。第三者CDNは使わない
  （要件定義書 §14.3）。
- 読み込むのは、クライアントIDが設定済みで、かつ実際に連携が必要になった時点だけとする。
  画面を開いただけで無条件に外部通信を発生させない。
- テスト環境の実装（`public/apps/gis-loader.js`、`public/apps/auth-config.js`）を
  **import しない。** 流用する場合は本番側へ複製する
  （[repository-structure.md](./repository-structure.md) §2-1 と同じ理由）。
- テストでは実際に GIS を読み込まない。`fetch` / スクリプト読み込みをスタブする
  （[specs/keystore-spec-v1.md](./specs/keystore-spec-v1.md) §7 の方針）。

**残っている検討事項**: CSP を適用する場合、このスクリプトの読み込みを許可する必要がある。
要件定義書 §14.3 のとおり、適用可否はフェーズ0で検証する。

---

## 2. 既に同梱している第三者ライブラリ（テスト環境）

`public/apps/`（テスト環境）には、この記録の制定より前から同梱しているものがある。
内容と SHA-256 は各 NOTICE と [.gitattributes](../.gitattributes) で保護している。

| 依存 | 場所 | NOTICE |
| --- | --- | --- |
| lamejs | `public/apps/voice-recorder/vendor/lamejs.iife.js` | [NOTICE-lamejs.txt](../public/apps/voice-recorder/vendor/NOTICE-lamejs.txt) |
| Supabase Auth JS | `public/apps/vendor/supabase-auth-js-2.110.8.esm.js` | [NOTICE-supabase-auth-js.md](../public/apps/vendor/NOTICE-supabase-auth-js.md) |

これらは**同梱物**であり、承認の経緯はこの文書の制定前にあたるため記録がない。
更新するときは `npm run check:vendor` で SHA-256 と NOTICE の突き合わせを行う。

---

## 3. 本体（Next.js / 交流会申込アプリ）の方針

`package.json` の dependencies は `next` / `react` / `react-dom` のみとし、
Stripe・Supabase・Gmail はいずれも `fetch` で REST を直接叩いている。
**この方針は維持する。** SDK を足したくなった場合も、まず確認を取る。
