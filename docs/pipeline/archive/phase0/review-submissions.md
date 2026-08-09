# 審査申請物

**対象**: コンテンツ自動展開・投稿アプリ「一想」（ISSO / `/pipeline/`）
**作成日**: 2026年8月7日
**最終更新**: 2026年8月7日（v0.5 のスコープ縮小を反映）
**根拠**: [implementation-guide.md](../implementation-guide.md) §2（データ非保持）・§4（Phase 0）・§8（拡張フェーズ）、[phase0_verification_plan_v0_1.md](../phase0_verification_plan_v0_1.md) T1-3

---

## 0. この文書の使い方

本書は**申請フォームに貼る文面そのもの**である。アカウント操作は発注者が行う
（手順は [owner-tasks.md](./owner-tasks.md)）。

`【要確定】` は発注者にしか決められない値。**推測で埋めていない。**
埋まっていない項目が1つでもあるうちは申請を送らないこと（差し戻しは再審査待ちを
丸ごともう一度発生させる）。

### 【v0.5】MVP で提出する審査は Meta App Review の1件のみ

YouTube 連携と動画化が MVP 対象外になった（guide §8）ため、**Google 側の審査2件は
凍結**した。**§3・§4 は削除せず残してある**（拡張フェーズの再開時にそのまま使うため）。

| 審査 | 何を解除するか | MVP |
| --- | --- | --- |
| **Meta App Review**（§2） | `threads_basic` / `threads_content_publish` を開発者以外にも使わせる | **対象** |
| ~~Google OAuth 検証~~（§3） | 同意画面の「テスト」→「本番」 | **凍結（§8 送り）** |
| ~~YouTube API コンプライアンス監査~~（§4） | 未監査プロジェクトからのアップロードが強制的に非公開になる制約 | **凍結（§8 送り）** |

> **凍結の影響で消えた作業**: `youtube.upload` のスコープ分類確認（旧 C-1・【停止】項目）、
> Google の Limited Use 開示（§3-3）、トークンをブラウザへ渡す設計の Google への説明（§3-5）。
> **X の PKCE 検討は残る**（guide §3-1 注記）。

---

## 1. 全審査に共通する記述（データ非保持）

審査で「取得したデータをどう扱うか」を書かされる（凍結中の §3・§4 も再開時に同じ記述を使う）。§2 の非保持方針が
**そのまま回答になる**ので、表現を揃えておく。ここがぶれると審査で追加質問が来る。

### 1-1. 日本語版（社内確認用）

> 本アプリは、利用者が入力した着想をもとに各SNS向けの文章を生成し、利用者自身の
> アカウントへ投稿することを支援します。
>
> 当社のサーバーは、利用者のコンテンツ、SNSのアクセストークン、投稿履歴を
> **一切永続化しません。**
>
> - コンテンツ・下書き・投稿履歴は、利用者のブラウザ内（IndexedDB）にのみ保存されます。
> - アクセストークンは、OAuthの認可コード交換の直後に利用者のブラウザへ返却し、
>   サーバー側では破棄します。データベースにもログにも書き出しません。
> - 投稿処理は、秘密鍵を要する中継のみサーバーを経由します。中継は無状態で、
>   本文もトークンも記録しません。サーバーのログに残るのは、利用者の識別子・媒体名・
>   結果コードだけです。
> - 当社が保持するのは、利用量のカウンタ（利用者ID・媒体・回数・月）と、
>   上限設定・許可リストのみです。
>
> 利用者が不在の時刻に当社が代理で投稿する機能はありません。予約は利用者の端末上の
> リマインダーであり、実際の投稿は利用者の操作によって行われます。

### 1-2. 英語版（申請フォーム貼り付け用）

> This application helps a user turn a single idea into posts for several
> platforms and publish them to the user's own accounts.
>
> **Our servers do not persist user content, access tokens, or publishing
> history.**
>
> - Content, drafts, and publishing history are stored only in the user's own
>   browser (IndexedDB).
> - Access tokens are returned to the user's browser immediately after the
>   OAuth code exchange and discarded server-side. They are never written to a
>   database or to logs.
> - Only calls that require a confidential client secret pass through our
>   server, as a stateless relay. The relay does not record post bodies or
>   tokens; server logs contain only an internal member identifier, the target
>   platform, and a result code.
> - The only data we retain is usage counters (member id, platform, count,
>   month) together with rate-limit settings and an access allowlist.
>
> We do not publish on a user's behalf while the user is away. Scheduling is a
> reminder on the user's own device; the publish call is initiated by the user.

### 1-3. 事実確認（申請前に必ず突き合わせる）

上の記述は**実装がそうなっている場合にのみ真**である。申請時点では Phase 1〜2 が
未実装のため、**申請の内容が実装の制約になる**。以下を満たさない実装に変えるときは、
審査のやり直しが必要になると考えること。

- [ ] サーバー側にコンテンツ用のテーブルを作っていない
- [ ] トークンを Supabase Vault・暗号化カラム・Cookie のいずれにも置いていない
- [ ] 中継APIが本文・トークンを `console.log` / エラーレポートへ出していない
- [ ] Vercel の Functions ログに本文が出ていない（例外メッセージ経由の漏れを含む）

---

## 2. Meta App Review（Threads）

**申請するもの**: `threads_basic`、`threads_content_publish`
**関連トラック**: T1-3

### 2-1. アプリ基本情報

| 項目 | 値 |
| --- | --- |
| App name | **一想（ISSO）** — 確定（v0.5）。`/portal/` の掲載名・スプレッドシート「アプリ一覧」と表記を統一する |
| App contact email | 【要確定】審査の連絡を受け取れるアドレス。個人アドレスを避け、転送先を決めてから登録する |
| Category | Productivity（または Business）— 【要確定】 |
| Privacy Policy URL | `https://tsam-ai.com/legal/privacy/` — **guide §6-8 の文言追加が済んでから申請する**（下記 2-5） |
| Terms of Service URL | `https://tsam-ai.com/legal/terms/` — 同上 |
| App domain | `tsam-ai.com` |
| Redirect URI | `https://tsam-ai.com/pipeline/api/auth/callback/threads/`（**末尾スラッシュ必須**） |
| Data Deletion | 下記 2-4 |

### 2-2. 各権限の用途説明（貼り付け用）

**`threads_basic`**

> Required to identify which Threads account the user has connected and to
> display that account's username in our UI, so the user can confirm they are
> about to publish to the intended account before they publish. We do not read
> or store the user's existing Threads posts.

**`threads_content_publish`**

> The core function of the application. The user writes an idea, our app helps
> them adapt it into a short post, the user reviews and edits the text, and
> then explicitly presses a publish button. Only at that point do we create a
> media container and publish it to the user's own Threads account. There is no
> unattended or automated publishing: every publish is initiated by the user in
> the current session.

### 2-3. スクリーンキャストの筋書き

Meta はユースケースを再現する動画を求める。**未実装の Phase 2 を待つ必要がある**ため、
申請は Phase 2 の投稿導線が動いてからになる。初週に投げ切れるのは**申請物の準備まで**で、
提出はここが揃った時点。この前後関係は発注者へ明示すること。

1. `/portal/` から本アプリを開く（利用者ログイン済み）
2. 「SNS連携」で Threads を接続 → Meta の同意画面 → 戻ってくる
3. テーマを入力し、Threads 向けの短文が生成される
4. 利用者が文面を編集する
5. 「投稿する」を押す
6. Threads 側に投稿が出ていることを実アカウントで見せる
7. **データ保存場所の説明画面**（§2-2 の必須画面）を見せ、ブラウザ保存であることを説明する
8. 連携解除の操作を見せる

> 7 と 8 は「データをどう扱うか」への回答を映像で裏づける部分。省かない。

### 2-4. データ削除（Data Deletion）

Meta は削除要求の受け口を必須にしている。**当社は削除すべきデータを持たないが、
「持っていない」ことを説明する必要がある。**

- 方式: Data Deletion Instructions URL（コールバックではなく説明ページ）を推奨。
  コールバックを実装すると「削除ジョブの状態」を返す義務が生じ、
  持っていないデータに対して状態を返す実装が不自然になる。
- 掲載先: 【要確定】`/legal/privacy/` 内の節にするか、`/pipeline/` 内の説明ページにするか
- 文面案:

> **Deleting your data**
>
> We do not store your Threads content or your Threads access token on our
> servers, so there is no server-side copy for us to delete.
>
> - To revoke this app's access to your Threads account, remove it from your
>   Meta account's Apps and Websites settings. Your access token stops working
>   immediately.
> - To delete the drafts and history this app has stored, use "Delete all local
>   data" inside the app, or clear this site's data in your browser. This data
>   never left your device.
> - The only records we hold are usage counters (how many times an account used
>   the service in a month). To have those removed, contact us at 【要確定：問い合わせ先】.

### 2-5. 申請前の前提

- [ ] `/legal/privacy/` と `/legal/terms/` に、非保持構成に対応した文言が入っている
      （guide §6-8。**条文はスプレッドシート「TSAM AI 法務文書」を直し、`publishLegalDocs()` で公開する。
      HTMLを直接編集しない**）
- [ ] Phase 2 の Threads 投稿導線が動いており、2-3 の録画ができる
- [ ] Redirect URI が末尾スラッシュ付きで登録されている

---

## 3. Google OAuth 検証（同意画面）— **凍結（拡張フェーズ送り）**

> **【v0.5】この節は提出しない。** YouTube 連携が MVP 対象外になったため
> （guide §8）、Google のスコープは1つも要求しなくなった。
> **文面は完成しているので、拡張フェーズの再開時にそのまま使う。**
> 凍結にあたり不要になった作業: スコープ分類の実機確認（旧 owner-tasks C-1）、
> Limited Use 開示（§3-3）、§3-5 の設計説明。
>
> 以下は再開用の保存。**MVP 期間中は読まなくてよい。**

**関連トラック**: T3-5（凍結）

### 3-1. 申請するスコープ

| スコープ | 用途 | 分類 |
| --- | --- | --- |
| `https://www.googleapis.com/auth/youtube.upload` | 利用者自身のチャンネルへ動画をアップロードする | **要確認**（下記） |
| `openid` / `email` / `profile` | 連携先チャンネルの所有者を画面に表示し、取り違えを防ぐ | 非センシティブ |

> **【確認事項】スコープの分類。** `youtube.upload` は Google の分類上
> 「センシティブ」に該当すると理解しているが、**制限付き（restricted）に該当すると
> 第三者によるセキュリティ評価が別途必要**になり、費用と期間が大きく変わる。
> **申請前に Google Cloud Console の OAuth 同意画面で当該スコープの表示ラベルを
> 実機確認すること**（T3-5 の最初の作業）。ここを取り違えると計画が崩れる。

### 3-2. スコープの正当化文（貼り付け用）

> Our application helps a user turn a written idea into a short video and
> publish it to **the user's own YouTube channel**. After the user reviews the
> generated video in a preview screen, they press an upload button; the app
> then uploads that video to their channel using a resumable upload.
>
> `youtube.upload` is the minimum scope for this: it permits uploading to the
> authenticated user's channel and nothing else. We do not need to read, list,
> modify, or delete the user's existing videos, and we do not request scopes
> that would allow it.
>
> The access token is held only in the user's browser for the duration of the
> session. Our servers perform the authorization-code exchange (because the
> client secret must stay confidential) and immediately return the token to the
> user's browser without storing it. Video files are not stored on our servers
> either.

### 3-3. Limited Use 開示

Google は「Limited Use requirements を満たしている」旨をプライバシーポリシー内で
明示することを求める。§6-6 の文言追加に含めること。

> This application's use and transfer of information received from Google APIs
> adheres to the Google API Services User Data Policy, including the Limited
> Use requirements.

### 3-4. 求められる準備物

- [ ] ドメイン所有権の確認（Search Console で `tsam-ai.com` を検証済みにする）
- [ ] 承認済みドメインに `tsam-ai.com` を登録
- [ ] ホームページURL: `https://tsam-ai.com/`
- [ ] プライバシーポリシーURL: `https://tsam-ai.com/legal/privacy/`（Limited Use 開示を含むこと）
- [ ] デモ動画（YouTube に限定公開でアップロード）— スコープの同意画面から
      実際の利用までを通しで映す
- [ ] アプリのロゴ 【要確定】

### 3-5. 【要判断】トークンをブラウザへ渡す設計への説明

§3-1 は「サーバーで認可コードを交換し、トークンをブラウザへ引き渡す」設計を採っている。
これは**機密クライアント（client_secret を持つ）でありながら、発行されたトークンを
ブラウザへ出す**形であり、Google が一般に案内するブラウザ向けの形（PKCE を使う
公開クライアント）とは異なる。

審査で説明を求められる可能性がある。**どちらで通すかを Phase 0 T3-1 の実機検証で
確定させる**こと。

| 案 | 内容 | 影響 |
| --- | --- | --- |
| A（現行 §3-1） | 機密クライアントでサーバー交換 → ブラウザへ引き渡し | 非保持は守れる。審査で説明が要る |
| B | 公開クライアント + PKCE でブラウザが直接交換 | client_secret 不要。Google の想定に沿う。`GOOGLE_CLIENT_SECRET` が不要になり §5 の環境変数が減る |

**B が成立するなら B のほうが説明が容易で、非保持の主張も強くなる**（トークンがサーバーを
一度も通らない）。ただし Threads / X 側は公開クライアントを許さない可能性があるため、
**媒体ごとに別方式になることを許容する設計にしておく**（Platform Adapter の責務）。

---

## 4. YouTube API コンプライアンス監査 — **凍結（拡張フェーズ送り）**

> **【v0.5】この節は提出しない。** アップロード連携が MVP 対象外になったため
> （guide §8）。**文面は完成しているので、拡張フェーズの再開時にそのまま使う。**
>
> 以下は再開用の保存。**MVP 期間中は読まなくてよい。**

**関連トラック**: T3-4（凍結）
**解除するもの**: 未監査プロジェクトからのアップロードが強制的に `private` になる制約

### 4-1. 申請物

| 項目 | 内容 |
| --- | --- |
| API Client の説明 | 下記 4-2 |
| クォータ見込み | T3-3 の実測値を入れる。**実測前に申請しない**（推測値を書くと後で食い違う） |
| スクリーンショット | 動画プレビュー画面、アップロード確認画面、アップロード後の状態表示 |
| 利用規約・プライバシーポリシー | `https://tsam-ai.com/legal/` 配下 |

### 4-2. API Client の説明（貼り付け用）

> The application generates a short video from text the user has written and
> reviewed, and uploads it to the user's own YouTube channel via
> `videos.insert` (resumable upload).
>
> The user is always in the loop: they write the source idea, review the
> generated script scene by scene, preview the rendered video, and then
> explicitly choose to upload. The application does not scrape, download, or
> re-upload content from YouTube or any third party, and it does not access any
> channel other than the authenticated user's own.
>
> Videos are generated from the user's own text; no third-party video content
> is used. Background music and imagery, if any, are drawn from a set whose
> licence terms permit this use, and the licence information is recorded
> alongside each asset.
>
> Rendered files are held only for the duration of the render job and are
> deleted as soon as the finished video has been delivered to the user or
> uploaded to their channel.

### 4-3. 監査が通らない／長引く場合の運用

検証計画 §5 のとおり、**非公開アップロード＋利用者による手動公開**を正式フローとして
出荷してよい（AC-07 の暫定充足）。この場合、アプリ内に次の案内を出す。

> アップロードは完了しましたが、YouTube 側の設定により非公開の状態です。
> YouTube Studio から公開に切り替えてください。

**この暫定フローは §2 の非保持方針と衝突しない**（保持するものが増えない）ため、
監査結果を待たずに Phase 3 を進められる。

---

## 5. X（BYOキー方式）

**発注者名義の審査申請は発生しない。** BYOキー方式では利用者自身が X Developer 登録を
行うため（これが BYOキーの利点のひとつ）。

v0.5 で BYOキー継続が承認され、**認証は公開クライアント + PKCE を第一候補として検証する**
（guide §2-3 / T2-2）。PKCE が成立すれば `client_secret` をサーバーに置かずに済み、
**非保持の主張がさらに強くなる**（トークンがサーバーを一度も通らない）。

運営キー共有方式へ切り替わった場合にのみ、発注者名義のプロジェクト作成・
支出上限設定・（必要なら）アクセスレベル申請が発生する。切替は
[platform-adapter-and-llm-client.md](../platform-adapter-and-llm-client.md) §3 の
`resolveXCredential()` 1関数で吸収する（v0.5 承認済み）。

---

## 6. 申請の順序と依存（v0.5）

```
MVP    └─ Meta App Review   ← 法務文言の公開 ＋ Phase 2 の投稿導線と録画が前提

拡張   ├─ YouTube 監査       ← 凍結。再開時に T3-3（クォータ実測）から
       └─ Google OAuth 検証  ← 凍結。再開時にスコープ分類の確認から
```

**残る審査が1件になったため、「審査系を初週に投げ切る」（検証計画 §4）の前提は
崩れている。** Meta は録画が要るので初週に提出できず、他に初週へ倒せる審査が無い。
**Phase 0 の期間はクリティカルパスから外れ、Phase 1 の着手を待たせるものが無くなった。**

法務文言（guide §6-8）は Meta App Review の前提。**発注者にて作成中。**
Google の Limited Use 開示は不要になったため、Meta 向けの非保持方針と
ブラウザ保存の免責が中心になる。
