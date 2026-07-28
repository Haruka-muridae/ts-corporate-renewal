# Supabase 認証の設定手順

TSAM AI のログイン（`apps/login/`）を、動作確認用のダミーから
**Supabase Auth による本物の認証**へ切り替える手順。

設定が済むまでは外部通信を一切行わず、ダミーのまま動く。
`apps/shared/supabase-config.js` に値を入れた瞬間から本番認証に切り替わり、
**コードの変更は不要**。

---

## 0. この認証で守れるもの・守れないもの

| | 内容 |
|---|---|
| **守れる** | Supabase 上のデータ。アクセストークンが無ければAPIは通らず、RLS（行レベルセキュリティ）で他人のデータも読めない |
| **守れない** | このサイトに置いた静的ファイル（HTML / JS / CSS）。URLを直接開けば誰でも取得できる |

`requireAuth()` は**未ログインの人を迷わせないための導線**であって、保護ではない。

**秘密にしたい情報を、HTMLやJSへ直接書かないこと。**
守るべきデータは必ず Supabase 側（RLS付きのテーブル）へ置く。

---

## 1. プロジェクトを作る

1. https://supabase.com/dashboard で新規プロジェクトを作成する。
2. リージョンは利用者に近い場所（例: Northeast Asia (Tokyo)）を選ぶ。
3. データベースのパスワードは**このリポジトリへ書かない**。パスワード管理ツールへ保存する。

---

## 2. 値を取得して設定する

**Project Settings → API** を開く。

| ダッシュボードの表示 | 貼り付け先 |
|---|---|
| Project URL | `apps/shared/supabase-config.js` の `url` |
| `anon` `public` | `apps/shared/supabase-config.js` の `anonKey` |

```js
export const SUPABASE_CONFIG = Object.freeze({
  url: 'https://xxxxxxxxxxxxxxxx.supabase.co',
  anonKey: 'eyJhbGciOi...',            // anon / public のほう
  storageKey: 'tsam-ai-supabase-auth',
});
```

### ⚠️ service_role キーを絶対に貼らないこと

`service_role` キーは**全データへの管理者権限**を持ち、RLS を無視する。
ブラウザへ配るとすべてのユーザーのデータを読み書きされる。

`anon` と `service_role` は見た目が似ている。
ダッシュボードで **anon / public** と表示されているほうを使う。

誤って貼ってしまった場合、ファイルを直すだけでは不十分。
**Supabase 側でキーを無効化（rotate）すること。**
Git の履歴と、その間にページを開いた全員のブラウザに残るため。

`supabase-config.js` には検知用の `looksLikeServiceRoleKey()` があり、
誤りを検出するとログイン画面が「準備中」表示に倒れる。
ただしこれは事故を早く見つけるためのもので、防止策ではない。

---

## 3. URL を登録する

**Authentication → URL Configuration**

| 項目 | 値 |
|---|---|
| Site URL | `https://tsam-ai.com` |
| Redirect URLs | `https://tsam-ai.com/apps/auth-callback/**` |

ローカル確認をする場合は、次も追加する。

```
http://localhost:8000/apps/auth-callback/**
```

**プロジェクトPages（`https://<user>.github.io/<repo>/apps/`）でも
確認する場合は、そのURLも追加する。**

```
https://<user>.github.io/<repo>/apps/auth-callback/**
```

戻り先URLは配信元のベースパスから自動生成される
（`apps/shared/app-paths.js`）。独自ドメインとプロジェクトPagesでは
異なるURLになるため、**使う環境の分だけ登録が必要**。

**登録が漏れると、メール内リンクが Site URL へ飛ばされて機能しない。**
`**` を付けるのは、`?flow=recovery` などのクエリが付くため。

### PKCE の制約（利用者へ案内すること）

メール内リンクは PKCE で処理している。
検証用の値（code verifier）は **リンクを要求したブラウザ** に保存される。

そのため次は失敗する。

- スマートフォンで再設定を要求し、パソコンでリンクを開く
- 通常ウィンドウで要求し、プライベートウィンドウで開く
- 要求後にブラウザのデータを消す

**「手続きを始めたのと同じブラウザでリンクを開いてください」**と案内する。

---

## 4. パスワードとメールの条件をそろえる

**Authentication → Sign In / Providers → Email**

| 項目 | 値 | 理由 |
|---|---|---|
| Enable Email provider | ON | メール＋パスワードでログインするため |
| Confirm email | **ON** | メール確認を必須にする。**この設定が実際の強制力**。画面側の「未確認」表示は案内にすぎない |
| Secure email change | **ON** | メール変更時に新旧両方の確認を求める。乗っ取り時のアドレス書き換えを防ぐ |
| Secure password change | **ON** | パスワード変更に直近の認証を要求する。**下記参照** |
| Minimum password length | **8** | 画面側（`INPUT_RULES.passwordMinLength`）と一致させる |
| Password requirements | 任意 | 上げる場合は画面のヒント文も合わせる |
| Enable email signups | **OFF** | 第4-2節 |

### Secure password change が重要な理由

この設定が **OFF** だと、有効なセッションさえあれば
現在のパスワードを知らなくても変更できてしまう。

つまり「ログインしたままの端末を数分借りた人」が、
`apps/account/` からパスワードを変更してアカウントを乗っ取れる。

画面側だけではこれを防げない（サーバーが要求しない限り、
何を入力させても意味がない）。**必ず ON にすること。**

---

## 4-2. 公開サインアップを無効にする

**正式な運用方針は「管理者がユーザーを作成または招待する」である。**
会員登録画面は用意していない。

### 手順

1. **Authentication → Sign In / Providers → Email** を開く。
2. **Enable email signups** を **OFF** にする。
   - 目的: 誰でも `signUp` APIでアカウントを作れる状態を閉じる。
   - この項目名はUIの改訂で変わることがある。
     「サインアップを許可するか」を意味する項目を探すこと。
3. **Authentication → Sign In / Providers** で、
   使用しないプロバイダ（Google / GitHub 等）がすべて無効であることを確認する。
   - 有効なプロバイダが1つでもあると、そこから新規アカウントが作れる。
4. **Authentication → Sign In / Providers → Anonymous sign-ins** が
   **OFF** であることを確認する。

### 利用者を追加する方法

| 方法 | 手順 | 使い分け |
|---|---|---|
| A. 招待 | Authentication → Users → **Invite user** | 通常はこちら。本人がパスワードを決める |
| B. 直接作成 | Authentication → Users → **Add user** | 初期パスワードを管理者が決める。**直後に本人へ変更させること** |

招待メールのリンクは `apps/auth-callback/` へ戻り、
そこからパスワード設定へ進む（第3節のURL登録が前提）。

---

## 4-3. 不正利用への備え

| 項目 | 場所 | 推奨 |
|---|---|---|
| Rate limits | Authentication → Rate Limits | 既定値のまま運用を開始し、実測してから調整する |
| CAPTCHA | Authentication → Attack Protection | **公開URLで運用するなら有効化を検討**。ログイン画面はURLを知れば誰でも開けるため、総当たりの入口になる |
| Session timebox | Authentication → Sessions | 業務利用なら有効期間の上限を設定する |
| Refresh token rotation | Authentication → Sessions | 有効にする（既定で有効） |

### CAPTCHA を有効にする場合の注意

**現在の実装は CAPTCHA トークンを送っていない。**
有効にすると、そのままではログインが失敗する。

有効化する場合は、`apps/shared/auth-providers/supabase.js` の
`signInWithPassword` に `options: { captchaToken }` を渡す改修が必要。
Phase 4 以降の作業として扱うこと。

---

## 5. 二段階認証（TOTP）を有効にする

**Authentication → Multi-Factor Authentication**

- TOTP (App Authenticator) を **Enabled** にする。
- 「Maximum enrolled factors」は既定（10）のままでよい。

利用者は `apps/account/` から自分で登録・解除できる。

解除は **AAL2（そのログインでコードを入力済み）のときだけ**許可している。
パスワードだけを知っている人に二段階認証を外させないため。

**紛失時の復旧手順は `apps/AUTH_OPERATIONS.md` を参照。**
Supabase にはバックアップコードの機能が無く、
管理者対応が必要になる。運用を決めてから利用者へ案内すること。

---

## 6. メール送信を設定する（本番運用時は必須）

Supabase の既定の送信元は**1時間あたり数通の制限**があり、
本番運用には足りない。

**Project Settings → Authentication → SMTP Settings** から
自前のSMTP（Amazon SES / SendGrid / Resend など）を設定する。

設定しないと、招待・パスワード再設定のメールが届かないことがある。

### メール文面

**Authentication → Email Templates** で日本語化できる。
リンク（`{{ .ConfirmationURL }}`）はそのまま残すこと。

---

## 7. 動作確認

ローカルで静的サーバーを起動する。

```powershell
python -m http.server 8000
```

| # | 操作 | 期待する結果 |
|---|---|---|
| 1 | `/apps/login/` を開く | 「動作確認用」の注意書きが**消えている**（消えていなければ設定が読めていない） |
| 2 | 「パスワードを忘れた方」 | リンクになっている（ダミーのときはテキスト） |
| 3 | 招待したアカウントでログイン | `/apps/home/` へ遷移し、表示名が出る |
| 4 | 誤ったパスワード | 「メールアドレスまたはパスワードが正しくありません。」（どちらが違うかは出さない） |
| 5 | `/apps/account/` | メール確認状態と二段階認証の状態が出る |
| 6 | 二段階認証を設定 | QRを読み取り、6桁を入力して「設定済み」になる |
| 7 | ログアウト → 再ログイン | パスワードのあとに二段階認証の画面が出る |
| 8 | 二段階認証の解除 | AAL2 のときだけボタンが押せる |
| 9 | パスワード再設定 | メールが届き、リンクから新しいパスワードを設定できる |
| 10 | 開発者ツール | `localStorage` にパスワードが**入っていない**こと |

### 確認しておきたい失敗系

- 期限切れのリンクを開く → 「期限切れか、すでに使用済みです」と出て、ログイン画面へ戻れる
- 通信を切ってログイン → 「通信に失敗しました」と出る（ログイン状態が壊れない）
- プライベートモード → 「ログイン状態を保持できません」と先に案内が出る

---

## 8. 設定値の正本

| 値 | 場所 | 秘密か |
|---|---|---|
| Project URL | `apps/shared/supabase-config.js` | 公開情報 |
| anon key | `apps/shared/supabase-config.js` | **後述** |
| service_role key | **どこにも置かない** | **秘密** |
| DBパスワード | **どこにも置かない** | **秘密** |
| SMTP資格情報 | Supabaseダッシュボードのみ | **秘密** |

Google OAuth のクライアントID（`apps/auth-config.js`）とは別物。
あちらは Drive 連携用で、TSAM AI のログインには使わない。

### anon key を「安全」と言い切らないこと

anon key はブラウザへ配る前提で作られており、**秘密鍵ではない**。
リポジトリへコミットしてよい。

ただし「秘密ではない」ことと「無害」は違う。
anon key を持つ人は、そのプロジェクトの公開API入口へ到達できる。
守っているのは鍵の秘匿ではなく、次の3つである。

1. **RLS（行レベルセキュリティ）** — テーブルを追加したら必ず有効化する
2. **認証** — トークンが無ければ利用者のデータへ届かない
3. **Rate limit / CAPTCHA** — 総当たりの抑制

**テーブルを1つでも追加したら、RLSを有効にすること。**
RLSを切ったテーブルは、anon key だけで誰でも読める。

### 設定ファイルの運用

`apps/shared/supabase-config.js` は**コミットする**。
プレースホルダーのままコミットされている状態が初期値で、
実値を入れたらそれもコミットしてよい（公開情報のため）。

`.gitignore` へ入れないこと。入れると、GitHub Pages で配信される
ファイルがローカルにしか存在しない状態になり、本番で「準備中」表示になる。

---

## 9. 同梱している認証ライブラリ

`apps/vendor/supabase-auth-js-2.110.8.esm.js`

第三者CDNからは読み込まない。ログイン画面のスクリプトをCDNに置くと、
そのCDNが改ざんされたときにパスワードを盗まれうるため。

版の更新・再生成の手順は `apps/vendor/NOTICE-supabase-auth-js.md` を参照。

---

## 10. うまくいかないとき

| 症状 | 原因 |
|---|---|
| 「動作確認用」の注意書きが消えない | `supabase-config.js` が未設定、または service_role キーを貼っている。注意書きの括弧内に理由が出る |
| メール内リンクを開くと Site URL へ飛ぶ | Redirect URLs の登録漏れ（第3節） |
| 「このリンクは期限切れか、すでに使用済みです」 | リンクは1回しか使えない。メールクライアントのプレビュー機能が先に開いてしまう場合もある |
| メールが届かない | 既定の送信制限。SMTP を設定する（第6節） |
| ログインできるが二段階認証の画面が出ない | ダッシュボードで TOTP が無効、または要素が未登録 |
| 二段階認証を解除できない | AAL2 が必要。ログアウトしてコード入力を経てから操作する |
| `Multiple GoTrueClient instances` の警告 | `shared/supabase-client.js` 以外でクライアントを生成している |
