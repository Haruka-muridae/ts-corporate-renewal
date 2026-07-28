# Google認証一本化の検討（設計監査）

**調査日: 2026-07-28** ／ 基準コミット `bcc7a37` ＋ 未コミット変更
**この文書は調査と設計だけである。コードは実装していない。**

---

## ★ その後の決定（2026-07-28 追記）

**この文書の推奨（案B Firebase Authentication）は採用されなかった。**

決定された方針は次のとおり。

| 項目 | 決定 |
|---|---|
| Firebase Authentication | **導入しない** |
| Supabase 実接続 | **停止**（一度も接続していない） |
| Supabase 関連コード | **削除しない** |
| Googleログイン | **既存実装をそのまま使い、共通導線として整理する** |
| Drive 認可 | 現在の分離構造を維持 |
| アカウント作成導線 | 通常Googleアカウント＋Workspace紹介の2つを追加 |

つまり、方式を入れ替えるのではなく
**すでに動いている表示専用のGoogleログインを、正式な導線として整えた。**

「認証の正本へ昇格する」という第0節の問いへの答えは **「昇格しない」** である。
Googleログインは引き続き利用者識別と表示のためのものであり、
セキュリティ境界ではない。第3-0節の分析（静的Pagesでは
どの方式でもファイルを守れない）が、そのまま結論になった。

実装内容と運用手順は **`apps/GOOGLE_AUTH_OPERATIONS.md`** にある。
本文書は、将来サーバー側の判定が必要になったときの
判断材料として残す（第3節の方式比較・第14節の費用比較）。

以下の本文は調査時点の記述であり、上記の決定に合わせた書き換えはしていない。

---

## 0. 最初に把握すべきこと

調査の結果、**認証系はすでに2つ並存していた。**

| | Googleログイン | Supabaseログイン |
|---|---|---|
| 場所 | `/apps/`（トップ） | `/apps/login/` |
| 実装 | `google-auth.js` `gis-loader.js` `auth-config.js` | `shared/auth.js` ほか |
| 状態 | **コミット済み・本番稼働中** | コミット済み・**未デプロイ** |
| クライアントID | 設定済み（実物） | プレースホルダー |
| 位置付け | **表示専用。セキュリティ境界ではない** | 認証の正本 |

Googleログインは既に動いている。今回の検討は「Googleログインを新設するか」ではなく、
**「既にある表示専用のGoogleログインを、認証の正本へ昇格できるか」** である。

`apps/auth-config.js` には、昇格を否定する判断が明記されている。

> 静的サイトのため、IDトークンをサーバー側で検証する仕組みは存在しない。
> したがって、このログイン機能はクライアント側のプロフィール表示に限定され、
> セキュリティ境界（アクセス制御・権限判定・本人確認）には使用しない。

`AUTH_SETUP.md` 第11節も同じ立場で、`decodeIdTokenPayload()` は
**署名検証をしない**と関数コメントに書かれている。

今回の検討は、この過去の判断を覆せるかどうかの検討にほかならない。

---

## 1. 現在の認証構成

### 1-1. 実測したファイル

**Google側（コミット済み・稼働中）**

```text
apps/auth-config.js          クライアントID・GIS配信元・設定判定
apps/gis-loader.js           GIS公式スクリプトの読み込み（二重読み込み防止）
apps/google-auth.js          ログイン・IDトークンpayload読み取り・状態描画
apps/index.html              <script type="module" src="google-auth.js">
apps/shared/drive-auth.js    Drive認可（トークンモデル・スコープ別キャッシュ）
apps/voice-recorder/drive-auth.js
apps/knowledge-src/src/auth/google-auth.js
```

クライアントIDは実物が入っている（公開情報であり秘密ではない）。

```text
603018562548-...（以降マスク）.apps.googleusercontent.com
```

**Supabase側（コミット済み・未デプロイ）**

```text
apps/shared/auth.js                  38の公開API（facade）
apps/shared/session.js               表示用の写し（v2）
apps/shared/bootstrap.js             起動時の認証状態初期化
apps/shared/app-paths.js             配信ベースパス・遷移先検証
apps/shared/supabase-config.js       未設定（プレースホルダー）
apps/shared/supabase-client.js
apps/shared/auth-providers/supabase.js   17のprovider関数
apps/shared/auth-providers/dummy.js
apps/login/ apps/home/ apps/account/ apps/password-reset/ apps/auth-callback/
apps/vendor/supabase-auth-js-2.110.8.esm.js
```

### 1-2. 認証と認可はすでに分離されている

これは重要な発見である。**利用者が求める分離は、Drive側では既に実現している。**

`shared/drive-auth.js` はGISの **トークンモデル** を使い、
ログインとは独立してアクセストークンを取る。スコープ別にキャッシュし、
必要になった時点で要求する。

実際に使われているスコープは2つだけで、いずれも最小である。

```text
https://www.googleapis.com/auth/drive.file       アプリが作った file のみ
https://www.googleapis.com/auth/drive.readonly   knowledge の読み取り
```

`drive.file` は「そのアプリが作成・オープンしたファイルだけ」に限定される。
利用者のDrive全体は見えない。**この設計は維持すべきで、変更する理由がない。**

### 1-3. provider差し替えの可否

`auth.js` は `setAuthProvider(next)` を持ち、`signIn` と `signOut` の存在だけを
入口で検査する。providerは17関数のうち必要なものを実装すればよく、
`typeof provider.x === 'function'` で保護されている箇所もある。

| 問い | 答え |
|---|---|
| `supabase.js` を `google.js` へ差し替えられるか | **できる。** 差し替え点は `resolveDefaultProvider()` の1か所 |
| `auth.js` の公開APIを維持できるか | **一部できない。** 下記参照 |
| `session.js` を再利用できるか | **できる。** 保存項目は `userId / displayName / loginId / provider / aal / emailConfirmed` で、Googleでも埋まる |
| 各画面を再利用できるか | `login/` `home/` は再利用可。`password-reset/` `auth-callback/` は不要になる |

**維持できない公開API**（Googleアカウントでは概念自体が存在しない）

```text
requestPasswordReset()      Googleがパスワードを持つ
updatePassword()            同上
requestReauthentication()   同上
resendConfirmation()        Googleがメールを確認済み
markRecoveryFlow() / consumeRecoveryFlow()
startMfaEnrollment() / confirmMfaEnrollment() / disableMfa() / verifyMfaCode()
                            Googleアカウント側の2段階認証を使う
```

38の公開APIのうち **11がGoogleでは無意味になる。**
逆に言えば **27はそのまま使える。**

---

## 2. Google認証へ移行する目的

利用者から示された目的を、達成可能性で分類した。

| 目的 | 達成可能か |
|---|---|
| Googleサービス中心の構成と一致させる | **できる** |
| 利用者がパスワードを覚えなくてよい | **できる** |
| パスワード運用（再設定・強度・漏えい対応）を持たない | **できる。効果は大きい** |
| 2段階認証をGoogle側に任せる | **できる。TOTP実装を捨てられる** |
| Drive連携と同じアカウントで揃う | **できる** |
| 認証基盤の月額固定費をなくす | **できる**（後述の費用比較） |
| 不正な利用者を締め出す | **静的Pagesでは不可能**（下記） |

---

## 3. 方式比較

### 3-0. 全案に共通する前提（最重要）

**GitHub Pages上では、どの認証方式を選んでもファイルへのアクセスは防げない。**

`/apps/home/index.html` は公開された静的ファイルであり、
`curl` で誰でも取得できる。ログイン判定はすべてブラウザ内で動くため、
利用者が自分で書き換えられる。

これは провайдерの優劣ではなく **配信方式の性質** である。
Supabaseに変えてもFirebaseに変えても同じである。

では何が守られているのか。**データである。**
TSAM AIのデータは利用者自身のGoogle Driveにあり、
そこへのアクセスはGoogleのOAuthが守っている。
他人のDriveは、TSAM AIのログインを迂回しても読めない。

したがって現構成における認証の役割は、実質的に次の2つである。

```text
1. 誰であるかを表示し、画面を出し分ける（UX）
2. Drive認可を要求する相手を決める（導線）
```

**本当のアクセス制御はGoogleのOAuthが担っている。**
この事実は、方式選定を大きく単純化する。

### 3-A. Google Identity Services だけを使う

```text
Googleログイン → IDトークン取得 → ブラウザ側で確認
```

**静的Pagesだけで安全に成立するか。**

「IDトークンをブラウザで検証できるか」と
「検証したら安全になるか」は別の問題である。

*検証の技術的可否*

| 項目 | ブラウザ単独で検証できるか |
|---|---|
| 署名（RS256） | **できる。** WebCrypto と Google の JWKS（`https://www.googleapis.com/oauth2/v3/certs`）で可能 |
| `aud`（クライアントID一致） | できる |
| `iss`（`accounts.google.com`） | できる |
| `exp` / `iat`（有効期限） | できる。ただし端末時計に依存する |
| `nonce`（リプレイ防止） | できる。事前に自分で生成して突き合わせる |
| `hd`（Workspaceドメイン限定） | できる |

つまり **技術的にはすべて検証できる。** 現実装がしていないだけである。

*しかし境界にはならない*

検証コードもその判定結果も、利用者が制御するブラウザの中にある。
DevToolsで `return true` に書き換えれば通る。
**「クライアントだけで完結する検証」は、UXの正しさは保証するが、権限は保証しない。**

| 評価軸 | 結果 |
|---|---|
| 初期費用・月額 | **0円。最良** |
| 静的Pages継続 | そのまま |
| 実装量 | JWKS取得・キャッシュ・署名検証・nonce管理を自作 |
| 「セキュリティを自作しすぎない」 | **反する。** 検証を手書きすることになる |
| 将来の外部提供 | サーバーを足すとき検証コードが二重になる |
| 既存資産 | `google-auth.js` を拡張するだけ |

### 3-B. Firebase Authentication

```text
Googleログイン → Firebase Authentication → Firebase IDトークン
```

Firebaseが署名検証・トークン更新・失効を担当し、
自前のJWT（Firebase IDトークン）を発行する。

| 評価軸 | 結果 |
|---|---|
| 無料枠 | **50,000 MAUまで無料**（Spark/Blaze共通） |
| 月額固定費 | **0円** |
| 休止 | **なし**（Supabase Freeとの決定的な差） |
| Google環境との親和性 | **最良。** 既存のOAuthクライアントIDと同じGoogle Cloudプロジェクトに置ける |
| 管理負荷 | Firebaseコンソール1つ増える |
| 追加サービス | Authenticationだけ使えばよい。Firestore等は不要 |
| 自作範囲 | **検証を自作しない** |
| 将来の外部提供 | Firebase IDトークンはCloud Run / Apps Script 側で **公式ライブラリで検証できる**。移行時に無駄がない |
| 依存 | SDKが1つ増える。Supabase同様に自己ホスト可能 |

### 3-C. Google Apps Script をバックエンドにする

```text
Googleログイン → Apps Script Web App → セッション
```

| 観点 | 評価 |
|---|---|
| セキュリティ | Web Appを「全員」公開にすると誰でも叩ける。「Googleアカウント必須」にすると `Session.getActiveUser()` が使えるが、外部ドメインからの `fetch` では認証Cookieが渡らない |
| CORS | Apps Script は任意の `Access-Control-Allow-Origin` を返しにくい。`/exec` はリダイレクトを挟むため CORS プリフライトと相性が悪い |
| Cookie | `SameSite` とサードパーティCookie規制により、`tsam-ai.com` から `script.google.com` のCookieは当てにできない |
| 実行制限 | 1日あたりの実行時間上限、同時実行数の制限がある |
| 保守性 | Gitで管理しづらく、`clasp` を挟む必要がある |
| 結論 | **認証バックエンドには向かない。** 既存の `gas/` のようなデータ処理用途に留めるべき |

### 3-D. Supabaseを残し、GoogleをOAuth providerとして使う

```text
Googleログイン → Supabase Auth（Google provider）→ Supabaseセッション
```

Supabaseがサーバー側でGoogleのトークンを検証し、自前のJWTを発行する。
**メール／パスワード機能は使わず、Googleログインだけに限定する。**

| 評価軸 | 結果 |
|---|---|
| 既存実装の活用 | **最大。** `auth.js` `session.js` `login/` `home/` `bootstrap.js` がほぼそのまま |
| provider実装 | `signInWithOAuth({ provider: 'google' })` へ差し替え。既存の `supabase.js` を大幅に縮小 |
| 無料枠 | 50,000 MAU |
| 休止 | **Free は1週間の無活動で休止。** 社内利用の低頻度アプリでは現実的な問題 |
| 回避 | Pro $25/月 |
| Google親和性 | 中。Googleの外にもう1つ基盤を持つ |
| リダイレクトURI | `<project>.supabase.co/auth/v1/callback` がGoogle側の許可URIになる |
| MFA | Supabase TOTPは**不要**（Googleの2段階認証と二重になる） |

### 3-E. Google Cloud にバックエンドを構築（Cloud Run / Identity Platform）

Identity Platform は Firebase Authentication の上位版で、実体は同じ基盤である。
Cloud Run を足せば、IDトークンをサーバーで検証し、**本当のアクセス制御**ができる。

| 評価軸 | 結果 |
|---|---|
| 唯一「不正な利用者を締め出せる」案 | **そのとおり** |
| 静的Pages継続 | 画面は継続可。データAPIだけCloud Runへ |
| 費用 | 無料枠内で収まる見込みだが、**公式ページから数値を取得できず未確認**（第14節） |
| 実装量 | **最大。** 現時点では過剰 |
| 判断 | **今は不要。** ただしFirebaseを選べば、この案へ後から進める |

---

## 4. 推奨構成

### 推奨：案B（Firebase Authentication）＋ 既存のDrive認可を維持

```text
[認証] Googleログイン → Firebase Authentication → Firebase IDトークン
                                ↓
                        shared/session.js（表示用の写し）
                                ↓
[認可] アプリを開いたときだけ shared/drive-auth.js が drive.file を要求
```

**選定理由**

1. **月額固定費が0円で、休止がない。** Supabase Freeの1週間休止は、
   低頻度の社内アプリにとって現実的な障害になる。
2. **検証を自作しない。** 案Aは署名検証・JWKS・nonceを手書きすることになり、
   利用者の条件「セキュリティを自作しすぎない」に反する。
3. **既存のGoogle Cloudプロジェクトに同居できる。** OAuthクライアントIDが既にある。
4. **将来サーバーを足すとき無駄がない。** Firebase IDトークンは
   Cloud Run / Apps Script 側で公式ライブラリで検証できる。案Aだと作り直しになる。
5. **Google OAuth審査の負荷が増えない。** スコープは `drive.file` `drive.readonly` のままで、
   ログインは `openid email profile` の基本スコープのみ。機密スコープを増やさない。
6. **既存Supabase実装の大半が再利用できる。** provider差し替えで済む（第5節）。

### 代替：案D（Supabase＋Google provider）

既存実装の再利用が最大になる。**Supabase Pro（$25/月）を払う前提なら十分に良い。**
Freeのままだと休止問題が残るため、無料で運用したいなら案Bが勝る。

### 採用しない案

- **案A**：費用は最良だが、検証の自作と将来の作り直しが避けられない
- **案C**：CORS・Cookie・実行制限から、認証バックエンドには不適
- **案E**：現時点では過剰。案Bから後で到達できる

---

## 5. Supabaseを残すか外すか

### 比較

| | 移行案1（完全削除） | 移行案2（feature flag） | 移行案3（ブローカーとして残す） |
|---|---|---|---|
| 削除対象 | `supabase-*.js` `vendor/` `password-reset/` `auth-callback/` MFA関連 | なし | なし |
| 再利用 | `auth.js`（縮小）`session.js` `app-paths.js` `login/` `home/` | 全部 | 全部 |
| 変更対象 | `auth.js` から11 API削除、画面3つ削除 | `resolveDefaultProvider()` に分岐追加 | `supabase.js` をOAuth専用に縮小 |
| テスト影響 | 約340件が削除・書き換え | 既存は全部残る＋新規追加 | 約200件が書き換え |
| セキュリティ | 攻撃面が減る（パスワード・メール経路が消える） | **両系統を保守する負担。設定ミスの危険** | 中 |
| 拡張性 | Google専業 | 高 | 高 |
| ロールバック | `git revert` のみ。作業量大 | **フラグを戻すだけ** | 中 |
| 工数 | 大 | **小** | 中 |
| 運用コスト | 0円 | 0円（Supabase未接続なら） | Pro $25/月 |

### 推奨：**移行案2 → 安定後に移行案1**

理由は、`setAuthProvider()` という差し替え点が既にあるため、
**案2の実装コストがほぼゼロ**だからである。

```js
/* resolveDefaultProvider() の分岐（設計案・未実装） */
function resolveDefaultProvider() {
  if (AUTH_CONFIG.provider === 'google' && isGoogleConfigured()) return googleProvider;
  if (isSupabaseConfigured()) return supabaseProvider;
  return dummyProvider;
}
```

Googleが安定稼働したら、案1でSupabaseを撤去する。
**その判断まではファイルを消さない。** 消して困ったときの復元は、
未接続のまま消すより明らかに高くつく。

---

## 6. GoogleログインとDrive認可の分離

**この分離は既に実現しており、壊してはならない。**

```text
ログイン時に要求するスコープ    openid email profile   （基本情報のみ）
Driveアプリを開いたとき        drive.file             （追加要求）
knowledge が読むとき           drive.readonly         （追加要求）
```

### 守るべき原則

1. **ログインでDriveスコープを要求しない。** 初回ログインの同意画面に
   「Googleドライブのファイルの表示・管理」が出ると、離脱要因になる。
2. **アプリを開いた時点で、そのアプリに必要な最小スコープだけを要求する。**
   `shared/drive-auth.js` は既にスコープ別にトークンをキャッシュしており、
   この動作を実装済みである。
3. **`drive` や `drive.readonly` へ安易に広げない。**
   `drive.file` は制限スコープではないため、**Google の審査（CASA等）を回避できる。**
   `drive.readonly` は制限スコープであり、審査対象になる。
   knowledge が既に使っているため、審査状況を別途確認すること。

### 実装上の注意

Firebase Auth の `GoogleAuthProvider` に `addScope()` でDriveスコープを足すと、
**ログイン時にDriveの同意も同時に要求されてしまう。**
これは分離を壊すため行わない。Drive認可は今までどおり
`shared/drive-auth.js`（GISトークンモデル）で別途行う。

---

## 7. Google Workspace紹介導線

### 7-1. 紹介URLの実測結果

指定されたURLを実際に開いて確認した（2026-07-28）。

```text
https://referworkspace.app.goo.gl/2KTq
  ↓ 302 Found
https://workspace.google.com/pricing?utm_source=sign-up
  &utm_medium=affiliatereferral&utm_campaign=apps-referral-program
  &uj=ref.promo~save10&uj=ref.referrer~<紹介者ID>
```

判明した事実。

| 項目 | 内容 |
|---|---|
| 最終遷移先 | `workspace.google.com` の **料金ページ** |
| 種別 | `utm_medium=affiliatereferral` — **アフィリエイト紹介リンク** |
| 特典 | `ref.promo~save10` — 10%割引 |
| 紹介者ID | `ref.referrer~<7文字の識別子>` がURLに含まれる |

**遷移先が料金ページである以上、「無料でアカウントを作れる」と読める表示は事実に反する。**
費用が発生し得ることの明記は、配慮ではなく **正確性の要件** である。

### 7-2. 短縮URLのリスク（記録）

`app.goo.gl` は **Firebase Dynamic Links のドメイン**である。
Firebase Dynamic Links は **2025年8月25日に終了**した。

現時点（2026-07-28）でこのリンクは動作している。
Workspace紹介プログラムがGoogle自身の運用として別扱いで維持していると見られる。
しかし**終了済みドメイン系列に依存している状態**であり、
予告なく停止する可能性を否定できない。

| リスク | 内容 |
|---|---|
| 停止 | 短縮URLが死ぬと、ログイン画面のボタンが無効なリンクになる |
| 遷移先変更 | 短縮URLの向き先はTSAM AI側から制御できない |
| 追跡 | 短縮URL経由で第三者に遷移が記録され得る |

**緩和策（推奨）**

短縮URLではなく、**実測した最終URLを直接記載する。**

- `workspace.google.com` はGoogleの安定ドメインである
- `ref.referrer` がクエリに含まれるため **紹介の帰属は維持される**
- 遷移先がリンクを見るだけで分かる（利用者にとっても安全）

短縮URLを使い続ける場合は、**定期的な死活確認をテストに含める**こと
（ただしネットワークに依存するテストは既定の `npm test` から外す）。

### 7-3. 設定値の一元管理（設計案・未実装）

```js
/* apps/shared/external-links.js（新規・設計案） */

/*
 * 外部サイトへのリンク。
 * URLを書き換える場所はこのファイルの1か所だけにする。
 * HTMLへ直接URLを書かないこと（変更漏れが起きる）。
 */
export const GOOGLE_WORKSPACE_REFERRAL = Object.freeze({
  /*
   * Google Workspace の紹介プログラム。
   * 短縮URL（referworkspace.app.goo.gl）は Firebase Dynamic Links の
   * ドメインで、同サービスは2025年8月に終了している。
   * 実測した最終遷移先を直接指定し、依存を避ける。
   * ref.referrer が紹介の帰属を保つ。
   */
  url: 'https://workspace.google.com/pricing?utm_source=sign-up'
     + '&utm_medium=affiliatereferral&utm_campaign=apps-referral-program'
     + '&uj=ref.promo~save10&uj=ref.referrer~<紹介者ID>',

  /* 遷移先として許可するホスト。テストで固定する。 */
  expectedHost: 'workspace.google.com',

  /* これは紹介リンクであり、遷移先は有料プランの料金ページである。 */
  isAffiliate: true,
  mayIncurCost: true,
});
```

### 7-4. 表示設計（設計案・未実装）

```html
<!-- ログイン画面。Googleログインボタンの下に置く -->
<section class="login-alt" aria-labelledby="no-google-account">
  <h2 class="login-alt__title" id="no-google-account">
    Googleアカウントをお持ちでない方
  </h2>

  <p class="login-alt__body">
    TSAM AIのご利用にはGoogleアカウントが必要です。
    業務でご利用の場合は、Google Workspace を紹介特典付きで開始できます。
  </p>

  <a class="login-alt__link"
     href="..." target="_blank" rel="noopener noreferrer">
    Google Workspaceを始める（外部サイト・新しいタブで開きます）
  </a>

  <p class="login-alt__note">
    Google Workspace 紹介プログラムのリンクです。
    Google Workspace の利用には料金が発生する場合があります。
    Google Workspace は Google LLC が提供するサービスで、TSAM AI とは別のサービスです。
  </p>
</section>
```

**要件の充足**

| 要件 | 充足方法 |
|---|---|
| 新しいタブで開く | `target="_blank"` |
| `rel="noopener noreferrer"` | 記載。`noopener` は遷移先からの `window.opener` 操作を防ぐ |
| 外部サイトと分かる | リンク文言に明記。`aria` に頼らず**目に見える文字**で書く |
| 有料になり得る明記 | 注記に明記 |
| 紹介リンクの表示 | 「紹介プログラムのリンクです」と明記 |
| 公式との混同防止 | 「Google LLC が提供」「TSAM AI とは別のサービス」 |
| 無料作成と誤認させない | 「無料」「アカウント作成」の語を**使わない**。遷移先は料金ページである |
| 設定値の一元管理 | `shared/external-links.js` |
| テストで固定 | 第12節 |

---

## 8. 通常のGoogleアカウント作成導線の要否

### 推奨：**B（両方を表示する）**

ただし **並列ではなく、主従を付ける。**

| 選択肢 | 評価 |
|---|---|
| A（紹介のみ） | **不採用。** 個人利用者を実質的に締め出す。Googleアカウントは無料で作れるのに、有料の料金ページしか示さないのは、利用者にとって不利益な情報提示になる |
| B（両方） | **推奨。** ただし文言設計を誤ると混乱する |
| C（目的を選ばせて分岐） | **不採用。** ログイン前に「業務ですか個人ですか」と問うのは摩擦が大きく、離脱を招く。得られる精度に見合わない |

### 表示順（設計）

```text
[Googleでログイン]                    ← 主動線

Googleアカウントをお持ちでない方
  無料のGoogleアカウントを作成する      ← 個人向け（accounts.google.com）
  Google Workspaceを始める（紹介・有料） ← 業務向け
```

**「無料」の語は通常アカウント側にだけ使う。** 紹介側には使わない。
この配置なら、費用誤認は起こりにくい。

紹介成果だけを見れば A が有利に見えるが、
**費用が発生する選択肢しか示されないと、利用者は不信を持つ。**
無料の選択肢を併記したうえで業務向けを勧めるほうが、結果的に信頼を損なわない。

---

## 9. 変更予定ファイル

**いずれも未実装。実装は別途承認を得ること。**

| ファイル | 変更内容 |
|---|---|
| `apps/shared/auth-providers/google.js` | **新規。** Firebase Auth を包むprovider（17関数のうち必要な6〜8） |
| `apps/shared/auth-config.js` または既存 `apps/auth-config.js` | Firebase設定（apiKey・authDomain）を追加 |
| `apps/shared/auth.js` | `resolveDefaultProvider()` に分岐。11 APIをcapability判定で無効化 |
| `apps/shared/external-links.js` | **新規。** 紹介URLの一元管理 |
| `apps/login/index.html` | Googleログインボタン、紹介導線、通常アカウント導線 |
| `apps/login/login.js` | パスワード入力欄の撤去、Googleログイン処理 |
| `apps/home/home.js` | メニューからパスワード変更・MFAを外す |
| `apps/account/index.html` `account.js` | パスワード・MFA節を撤去（Google側へ誘導） |
| `apps/vendor/firebase-auth-*.esm.js` | **新規。** SDK自己ホスト（Supabaseと同じ方針） |
| `apps/tests/unit/google.mjs` | **新規。** provider試験 |
| `apps/tests/browser/google-login.mjs` | **新規。** 実ブラウザ試験 |

---

## 10. 削除候補ファイル

**移行案2の段階では削除しない。案1へ進む判断が出てからとする。**

| ファイル | 条件 |
|---|---|
| `apps/password-reset/` | Googleがパスワードを持つため不要 |
| `apps/auth-callback/` | メールリンクの受け口が不要 |
| `apps/shared/supabase-config.js` `supabase-client.js` | Supabase撤去時 |
| `apps/shared/auth-providers/supabase.js` | 同上 |
| `apps/vendor/supabase-auth-js-*.esm.js` ほか3点 | 同上 |
| `apps/SUPABASE_SETUP.md` `SUPABASE_CONNECTION_TEST.md` | 同上（監査記録として残す判断もある） |
| `apps/tests/unit/supabase.mjs` | 同上 |
| `.gitattributes` のvendor行 | 同上 |

---

## 11. 再利用可能ファイル

**Google認証でもそのまま活きる資産。**

| ファイル | 理由 |
|---|---|
| `apps/shared/app-paths.js` | 配信ベースパスと遷移先検証。provider非依存。**監査で直したCriticalもここ** |
| `apps/shared/session.js` | 表示用の写し。Googleの `sub` `name` `email` で埋まる |
| `apps/shared/bootstrap.js` | 起動時の初期化 |
| `apps/shared/drive-auth.js` `drive-files.js` | **変更不要。** 認可はGISのまま |
| `apps/shared/ai-*.js` `providers/*.js` `profile-store.js` | Phase 6/7の雛形。認証と無関係 |
| `apps/shared/auth.js` | 27/38のAPIが有効 |
| `apps/shared/auth-providers/dummy.js` | 未設定時の挙動 |
| `apps/login/` `apps/home/` | 画面骨格・CSS・アクセシビリティ対応 |
| `apps/account.css` | そのまま |
| `apps/gis-loader.js` `apps/google-auth.js` | **既存のGoogle実装。土台になる** |

---

## 12. テスト移行計画

### 12-0. 前提の訂正

**現在のテスト件数は 691 件ではなく 704 件である。**
実接続試験で追加した再認証の回帰試験13件が加わっている（第13節）。

### 12-1. 分類

| 分類 | スイート | 件数 | 根拠 |
|---|---|---|---|
| **そのまま使える** | `paths` 119 / `shared-dom` 36 / `shared` 82 | **237** | provider非依存。パス解決・ストレージ・Phase1基盤 |
| **provider差し替えで使える** | `auth` の約47 / `browser:login-flow` の約34 / `browser:audit` の約25 | **約106** | ログイン・ログアウト・セッション・オープンリダイレクト・サブパス・隔離 |
| **Supabase専用** | `supabase` 100 / `auth` の約25 / `unit:audit` の約23 / `browser:login-flow` の約25 / `phase3-screens` の約15 / `browser:audit` の約12 | **約200** | パスワード・MFA・メール確認・再認証・nonce |
| **削除候補** | 上記のうちパスワード再設定・メール確認・TOTP | 約160 | Googleでは機能自体が存在しない |
| **新規追加が必要** | — | 約60〜80 | 下記 |

件数は `パスワード|MFA|確認メール|再設定|nonce|再認証` の出現で機械的に測った概算である。
**スイート内の個別判定は移行実施時に1件ずつ行うこと。**

### 12-2. 新規に必要なテスト

利用者から指定された項目を、実現方法とともに示す。

| 項目 | 実現方法 |
|---|---|
| ログイン成功 | 偽のFirebase Authクライアント（`fake-firebase.mjs`）を注入 |
| ログイン失敗 | 同上。`auth/invalid-credential` 等を返す |
| **Google認証キャンセル** | `auth/popup-closed-by-user` を返す。**日本語文言へ写像されること** |
| **ポップアップブロック** | `auth/popup-blocked` を返す。**リダイレクト方式への案内が出ること** |
| ID token期限切れ | `exp` を過去にした偽トークン |
| **audience不一致** | `aud` を別のクライアントIDにする |
| **issuer不一致** | `iss` を `evil.example` にする |
| **nonce不一致** | 送出したnonceと異なる値を返す |
| ログアウト | 既存の `logout()` 試験を流用 |
| セッション復元 | 既存の `restoreSession()` 試験を流用 |
| 別タブログアウト | 既存の `storage` イベント試験を流用 |
| **Drive追加認可** | `drive-auth.js` にトークンクライアントの偽物を注入 |
| **Drive認可拒否** | `SCOPE_NOT_GRANTED` を返す。**ログインは維持されること** |
| 紹介リンクのURL | `external-links.js` の値を固定 |
| 外部リンク属性 | `target="_blank"` と `rel` に `noopener` `noreferrer` の両方 |
| Workspace有料表示 | 「料金が発生する場合があります」がDOMに存在する |
| 紹介リンク表記 | 「紹介プログラム」がDOMに存在する |
| **（追加提案）誤認防止** | 紹介リンク周辺に「無料」の語が**無い**こと |

**audience / issuer / nonce の試験は、案Bでも書く価値がある。**
Firebaseが検証するとしても、providerが検証結果をどう扱うかは自前のコードだからである。

---

## 13. 未コミット変更の扱い

### 13-1. 実測

`git status` の結果、未コミット変更は**認証関連とknowledge関連が混在**している。

**認証関連（今回の実接続試験で追加。すべて私の変更）**

| ファイル | 内容 |
|---|---|
| `apps/shared/auth-providers/supabase.js` | `reauthentication_needed` → `REAUTH_REQUIRED`、`reauthentication_not_valid` → `REAUTH_INVALID` の写像。`updatePassword` の nonce 対応。`requestReauthentication()` 追加 |
| `apps/shared/auth.js` | エラーコード2種・日本語文言・`requestReauthentication()` |
| `apps/account/index.html` | 確認コード入力欄 |
| `apps/account/account.js` | `REAUTH_REQUIRED` 受信時の再送信フロー |
| `apps/tests/unit/supabase.mjs` | 回帰試験13件・偽GoTrueの nonce 対応 |
| `apps/tests/run.mjs` | 異常終了時の集計表示の修正 |

**knowledge関連（私の変更ではない。触っていない）**

`apps/KNOWLEDGE_SETUP.md` `apps/knowledge-src/**` `apps/knowledge/**` の
21ファイル変更・4削除・11新規。

### 13-2. 提案：**別ブランチへ退避せず、現ブランチでコミットする**

| 選択肢 | 評価 |
|---|---|
| **コミットする** | **推奨。** 下記理由 |
| 破棄する | **不可。** 実接続試験でしか分からない知見であり、再取得には実Supabase接続が要る |
| 別ブランチへ退避 | 不要。現ブランチはまだpushしておらず、退避の利点がない |

**コミットを推奨する理由**

1. `reauthentication_needed` が **HTTP 401 で返るため、`status === 401 → INVALID_CREDENTIALS`
   より前に置く必要がある**という知見は、実サービスの挙動を調べないと得られない。
   Google認証へ移っても、この「エラー写像の順序」という設計上の教訓は残る。
2. `run.mjs` の集計表示修正と `fake-gotrue.mjs` 未使用問題の記録は、
   **provider に依存しないテスト基盤の改善**であり、Google移行後も有効である。
3. 移行案2ではSupabase providerを残すため、この修正はそのまま使われる。
4. 未コミットのまま放置すると、Google実装の差分と混ざって出所が分からなくなる。

**ただし Google 移行が確定した場合**、`apps/account/` のパスワード節ごと
撤去される可能性がある。それでも**履歴に残す価値がある**（なぜその実装をしたかが追える）。

### 13-3. `fake-gotrue.mjs` 未使用問題

`apps/tests/helpers/fake-gotrue.mjs` は **どのスイートからも参照されていない**。
`unit/supabase.mjs` と `unit/audit.mjs` がそれぞれ独自の偽GoTrueを内包している。
README には使われている前提で書かれている。

| 対応案 | 評価 |
|---|---|
| 削除する | 単純。ただしGoogle移行時に偽Firebaseを作るなら共通化の器は要る |
| 2スイートを共通化する | 正しいが、Supabase撤去の可能性がある今は投資しづらい |
| **READMEを直し、現状を明記する** | **推奨。** Google移行時に `fake-firebase.mjs` を作る際、同じ轍を踏まないよう記録する |

---

## 14. 費用比較

**公式ページのみを出典とした。確認日 2026-07-28。**

### 認証基盤

| サービス | 無料枠 | 月額固定 | 超過 | 休止 |
|---|---|---|---|---|
| **Firebase Authentication** | **50,000 MAU** | **0円** | Google Cloud 料金へ | **なし** |
| Supabase Free | 50,000 MAU | 0円 | 記載なし | **1週間の無活動で休止。アクティブ2プロジェクトまで** |
| Supabase Pro | 100,000 MAU | **$25/月** | $0.00325/MAU | なし |
| Google Identity Platform | Firebaseと同基盤 | 0円 | **未確認**（下記） | なし |
| Google Apps Script | 実行時間の割当 | 0円 | — | — |
| Cloud Run | **未確認**（下記） | 0円 | — | — |

**MFA費用**：Supabase の電話MFAは Pro で $75/月（初回プロジェクト）。
**TSAM AIには不要。** TOTPは両プランに含まれ、Googleアカウントなら標準機能である。

**SAML/OIDC**：Firebase は 50 MAU まで無料。TSAM AIの規模では影響しない。

### Google Workspace（紹介先で発生し得る費用・日本）

| プラン | 通常 | 新規50%割引（3か月） |
|---|---|---|
| Business Starter | **¥800**/ユーザー/月 | ¥400 |
| Business Standard | **¥1,600**/ユーザー/月 | ¥800 |
| Business Plus | **¥2,500**/ユーザー/月 | ¥1,250 |
| Enterprise | 要問い合わせ | — |

14日間の無料試用あり。上位3プランは**最大300ユーザー**。
割引は新規顧客限定・最初の20ユーザー・12か月。年間契約で16%節約。

**紹介URL経由で登録した利用者には、この費用が発生し得る。**
紹介リンクには10%割引（`ref.promo~save10`）が付く。

### 未確認の項目

| 項目 | 理由 |
|---|---|
| Identity Platform の 50,000 MAU 超過後の単価 | 公式ページの取得内容が途中で切れ、数値を確認できなかった |
| Cloud Run の無料枠の正確な数値 | 同上 |

**いずれもTSAM AIの想定規模（〜300ユーザー）では 50,000 MAU に遠く及ばず、
判断に影響しない。** 必要になった時点で公式ページを直接確認すること。

推測値を書かなかったのは、**費用の推測は実害に直結する**ためである。

### 出典

| 出典 | URL | 確認日 |
|---|---|---|
| Firebase 料金 | https://firebase.google.com/pricing | 2026-07-28 |
| Supabase 料金 | https://supabase.com/pricing | 2026-07-28 |
| Google Workspace 料金（日本） | https://workspace.google.com/pricing | 2026-07-28 |
| Identity Platform 料金 | https://cloud.google.com/identity-platform/pricing | 2026-07-28（取得不完全） |
| Cloud Run 料金 | https://cloud.google.com/run/pricing | 2026-07-28（取得不完全） |
| Firebase Dynamic Links 廃止 | https://firebase.google.com/support/dynamic-links-faq | 2026-07-28 |

---

## 15. 段階的移行手順

**各段階でテストが通ることを条件とする。承認なしに次へ進まない。**

| 段階 | 内容 | 完了条件 |
|---|---|---|
| **0** | 未コミット変更の整理（第13節） | 704/704 |
| **1** | Firebaseプロジェクト作成・Google providerを有効化・SDK自己ホスト | `check:vendor` 相当の完全性確認 |
| **2** | `auth-providers/google.js` 実装（ダミー動作まで） | 新規unit試験が通る |
| **3** | `resolveDefaultProvider()` にフラグ追加（移行案2） | **既存704件が通ったまま** |
| **4** | `login/` にGoogleボタン・紹介導線・通常アカウント導線 | 新規browser試験が通る |
| **5** | `home/` `account/` からパスワード・MFA節を撤去 | 影響範囲の試験 |
| **6** | 実Googleアカウントで接続試験 | 別途チェックリストを作る |
| **7** | 既定providerをGoogleへ切替 | 本番相当で確認 |
| **8** | 安定後、移行案1でSupabase撤去 | **別判断** |

段階3で既存704件が通ることを条件にしているのは、
**フラグ追加が既存挙動を壊していないことの証明**になるからである。

---

## 16. ロールバック手順

| 段階 | 戻し方 |
|---|---|
| 1〜2 | 新規ファイルのため、providerを差し替えなければ影響なし |
| 3 | **フラグを既定値へ戻すだけ**（コード変更不要） |
| 4〜5 | `git revert` で画面を戻す。providerは残る |
| 7 | フラグを戻す。**Supabaseを消していないため即座に戻せる** |
| 8 | `git revert`。ただしこの段階以降は戻しにくいため、7で十分な期間の稼働を確認してから行う |

**移行案2を選ぶ最大の利点はここにある。** 段階7までは設定値1つで戻せる。

---

## 17. 実装前の確認事項

**利用者に判断・確認していただく必要がある項目。**

| # | 確認事項 | なぜ必要か |
|---|---|---|
| 1 | **推奨（案B Firebase）で進めてよいか** | 代替の案D（Supabase＋Google）とは工数と費用構造が異なる |
| 2 | **利用者はGoogle Workspaceドメインに限定されるか** | 限定するなら `hd` クレーム検証、または Firebase の許可ドメイン設定を使う。不特定のGmailを許すかで設計が変わる |
| 3 | **「不正な利用者を締め出す」ことが要件に含まれるか** | 含まれるなら静的Pagesでは不可能で、案E（Cloud Run）が必要になる |
| 4 | 既存の `apps/index.html` のGoogleログインを、新ログイン画面へ統合するか | 現在トップとログイン画面で二重になる |
| 5 | `drive.readonly`（knowledge）のGoogle審査状況 | 制限スコープのため、外部提供時に審査が要る |
| 6 | 紹介リンクを短縮URLのまま使うか、実測した直リンクにするか | 第7-2節のリスク |
| 7 | 通常のGoogleアカウント作成導線を併設してよいか | 第8節の推奨はB |
| 8 | 未コミット変更をコミットしてよいか | 第13節の推奨はコミット |
| 9 | Supabaseの扱い（案2で進めてよいか） | 削除の可否 |
| 10 | 紹介者IDをリポジトリへ含めてよいか | 秘密ではないが個人に紐づく識別子である |

---

## 付録：この監査で確認できていないこと

- 実Firebaseプロジェクトでの動作（**未作成**）
- 実Googleアカウントでのログイン（**未実施**）
- Firebase Auth SDK の自己ホスト可否（Supabaseと同様にesbuildで束ねられる見込みだが未検証）
- `drive.readonly` のGoogle審査状況
- Identity Platform / Cloud Run の正確な超過料金

**この文書は設計判断のための材料であり、動作の保証ではない。**
