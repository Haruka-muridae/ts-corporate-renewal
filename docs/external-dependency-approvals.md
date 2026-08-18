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
| Google Identity Services（GIS） | `https://accounts.google.com/gsi/client`（Google本体） | `public/production-app/` の Google 連携アプリ 6 本（card-ocr / card-mail / receipt-ocr / voice-recorder / audio-transcriber / meeting-minutes）。初回承認は card-ocr（2026-08-03）で、以降のアプリは同じ方式（トークンモデル・複製実装）を踏襲 | Drive / Sheets / Gmail API を呼ぶための OAuth トークン取得（トークンモデル） | 2026-08-03（meeting-minutes への適用は 2026-08-18） |
| `@playwright/test` | npm（devDependency） | `tests/e2e/` のみ | ブラウザ録音アプリの E2E（実マイク入力・OPFS・メモリ計測） | 2026-08-06 |
| `@opennextjs/cloudflare` / `wrangler` | npm（devDependency） | ビルドとデプロイのみ | 本番配信（Cloudflare Workers）に必要。**既に本番で使われている構成を、設定ごとリポジトリへ入れたもの** | 2026-08-06 |
| `@anthropic-ai/claude-code` | npm（グローバル開発ツール。リポジトリ依存には追加しない） | Codexからの非対話Worker実行のみ | ユーザー指定のCodex / Claude Code分業環境を構築する | 2026-08-09 |
| ~~jsrsasign~~ | ~~公式配布の `jsrsasign-all-min.js`（MIT）~~ | **廃止（2026-08-10）** | 使用をやめた。§1-4 | 2026-08-09 承認 / 2026-08-10 廃止 |

### 1-4. jsrsasign（録音アプリのカレンダー通知）— **2026-08-10 に廃止**

> **この依存は使用をやめた（2026-08-10）。**
>
> カレンダー通知 V2 で、VAPID の ES256 署名を運営の Cloudflare Workers
> （[workers/notifier-gate/](../workers/notifier-gate/)）へ移した。Workers には
> WebCrypto があり、`crypto.subtle.sign` の ECDSA / P-256 は JWS がそのまま
> 要求する `r||s` の64バイトを返す。**外部ライブラリを1つも足さずに済む。**
>
> - `gas-notifier/lib_jsrsasign.gs` は**削除した**（コミット `2680160`）
> - 配布テンプレートに同梱する外部ライブラリは**無くなった**
> - `package.json` の dependencies は変わらず `next` / `react` / `react-dom` のみ
>
> **副次的な効果**: 利用者に約500KB を手で貼らせる工程が消えた。
> 貼り忘れ・順序違い・途中で切れた、のいずれも「通知が届かない」という
> 同じ症状になり、原因が見えない工程だった。
>
> 経緯は [notifier-design-notes.md](./notifier-design-notes.md) §6-3。
>
> **以下は廃止前の承認記録である。** 消さずに残すのは、同じ判断を繰り返すときに
> 「なぜ一度は必要だと判断したのか」を辿れるようにするため。

**承認の範囲**: 録音アプリのカレンダー通知が使う GAS（[gas-notifier/](../gas-notifier/)）に限る。
**`package.json` の dependencies には足さない。** 配信物（`public/`）にも入らない。
貼り付け先は利用者自身の Apps Script プロジェクトであり、運営のサーバーには置かない。

**なぜ必要か**: Web Push は VAPID の JWT を **ES256（ECDSA P-256）で署名**する必要がある。
Apps Script の `Utilities` が持つのは HMAC-SHA256 と各種ダイジェストだけで、**ECDSA 署名が無い**。

**なぜ自前で書かないか**: 楕円曲線の署名は、nonce の質・DER/JOSE のエンコード・
定数時間性のいずれを外しても秘密鍵が漏れうる。ここは自作しない領域である。

**なぜ依存が1つで済むか**: 本文つき Push にすると、これとは別に AES128GCM の
ペイロード暗号化（ECDH + HKDF）が要る。**本文なし Push（tickle）**にしたため、
GAS 側に要るのは VAPID 署名だけで、通知の中身は Service Worker が GAS へ取りに行く。

**制約**:

- `lib_jsrsasign.gs` の**先頭に GAS 用スタブを置き、その下に本体を貼る**。
  順序を入れ替えると `navigator is not defined` で失敗する。
  スタブの `window.crypto.getRandomValues` は `Utilities.getUuid()` 由来にしてある。
  jsrsasign は `window.crypto` が無いと `Math.random()` へ落ちるため、
  そのままでは ECDSA の nonce が弱い乱数になる。
- MIT ライセンス表記を [gas-notifier/README.md](../gas-notifier/README.md) と
  `lib_jsrsasign.gs` の冒頭に残す。
- **自動テストは本体を読み込まない。** `tests/helpers/gas-notifier-harness.mjs` が
  `KEYUTIL` / `KJUR` の偽物を差し込む（実物は数百KBのミニファイ済みJSで、
  Node 上で読ませても検証できることが増えない）。実物で署名が通ることは、
  利用者の環境で `verifyJsrsasign()` を1回実行して確かめる。

**廃止時に消したもの**（上の制約は、いずれも不要になった）:

| 消したもの | 代わり |
| --- | --- |
| `gas-notifier/lib_jsrsasign.gs` | 無し（署名は Workers が行う） |
| `verifyJsrsasign()` と「jsrsasign を検証」メニュー | 無し（貼り付け工程が無いため、検証する対象が無い） |
| ハーネスの `KEYUTIL` / `KJUR` の偽物 | 無し。署名は `tests/unit/notifier-gate.mjs` が
**実際の WebCrypto で署名し、公開鍵で検証して**確かめている |

### 1-3. OpenNext（Cloudflare）と wrangler

**承認の範囲**: ビルドとデプロイに限る。**devDependency であり、配信物には入らない。**

**なぜ必要か**: これは新しい依存の追加ではなく、**既成事実の追認**である。
2026-08-06 に Vercel から Cloudflare へ移行した際、デプロイは別マシンから wrangler で
手動実行された（Cloudflare の Versions に `Manually deployed / Wrangler by architect`）。
そのときの設定はリポジトリに入っておらず、**このリポジトリだけでは本番を再現できない
状態になっていた。** 別のマシンや別の担当者がデプロイできず、切り戻しもできない。

| 追加したもの | 版 | 役割 |
| --- | --- | --- |
| `@opennextjs/cloudflare` | 1.20.2 | `next build` の出力を Workers 用へ変換する |
| `wrangler` | 4.119.0 | Cloudflare へのデプロイ・ロールバック・状態確認 |
| `wrangler.jsonc` | — | Worker 名・アカウント・ルート・互換性フラグ |
| `open-next.config.ts` | — | 変換の設定 |

**版の選定**: `@opennextjs/cloudflare@1.20.2` の peer は `next: ">=15.5.21 <16 || >=16.2.11"` で、
このリポジトリの `next@16.2.11` とちょうど一致する。`wrangler` は同 peer の `^4.86.0` を満たす。

**制約**:

- **配信物には入らない。** `.open-next/` はビルド成果物で、`.gitignore` で除外している。
- `wrangler.jsonc` に**トークンを書かない。** 認証は `wrangler login` が別途持つ。
  アカウントIDは秘密ではない（公開しても操作はできない）。
- **この設定が稼働中の Worker と一致している保証はない。** 移行時の設定が不明なため、
  最初のデプロイ前にダッシュボードとの突き合わせが要る
  （[deployment-cloudflare.md](./deployment-cloudflare.md) の「デプロイ前チェック」）。

### 1-2. Playwright（ブラウザ録音アプリの E2E）

**承認の範囲**: `tests/e2e/` の自動テストに限る。**devDependency であり、配信物には入らない。**

**なぜ必要か**: 録音アプリの中核（マイク入力 → AudioWorklet → Worker で逐次MP3化 → OPFS）は、
実ブラウザでしか動かない。既存の2つのランナー（[tests/run.mjs](../tests/run.mjs) /
[public/apps/tests/run.mjs](../public/apps/tests/run.mjs)）は Node 上でスイートを実行する方式で、
Chrome を起動する browser スイートも DOM の確認までしかできない。
「30分録音してメモリが増えないこと」（要件書 §8.2）は実測でしか示せない。

**既存のランナーは変更していない。** `npm test` の内容も従来どおりで、
E2E は `npm run test:e2e`、30分ソークは `npm run test:e2e:soak` で明示的に実行する。

**制約**:

- `channel: 'chromium'` を使う。Playwright 既定の headless shell にはメディアデバイスが無く、
  偽デバイスのフラグを渡しても `getUserMedia` が `NotSupportedError` になる。
- テストは本物の Apps Script を叩かない。認証系の応答は `page.route` で差し替える
  （叩けば本番のセッション表に行が増え、ネットワークの都合で落ちるようになる）。
- 実行成果物（`tests/e2e/.report/` `tests/e2e/.artifacts/`）は追跡しない。

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
