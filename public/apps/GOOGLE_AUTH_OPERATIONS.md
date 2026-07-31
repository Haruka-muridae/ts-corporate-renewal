# Googleログイン 運用手引き

**対象**: `/apps/` 配下の共通ログイン導線
**最終更新**: 2026-07-28

---

## 1. Googleログインの目的

TSAM AI のGoogleログインは、次の4つのためにある。

```text
利用者の識別
名前・メールアドレス・プロフィール画像の表示
画面状態の統一（どのアプリでも同じ表示）
Google Drive 認可の対象アカウントの確認
```

**それ以外の目的には使わない。**

---

## 2. 静的サイト上の限界（必ず読むこと）

TSAM AI は GitHub Pages 上の静的サイトである。
`/apps/home/index.html` のようなファイルは公開されており、
**ログインしていなくても取得できる。**

判定はすべてブラウザの中で動くため、利用者が自分で書き換えられる。

したがって次のように表現してはならない。

| 誤 | 正 |
|---|---|
| Googleログインでアプリを保護している | Googleログインは利用者を識別している |
| ログインしないと使えない | ログインしなくても利用できる |
| 認証によりアクセスを制御している | アクセス制御は行っていない |

### では何が守られているのか

**データである。**

TSAM AI のデータは利用者自身の Google Drive にあり、
そこへのアクセスは Google の OAuth が守っている。
他人の Drive は、TSAM AI のログインを迂回しても読めない。

**本当のアクセス制御は Google が担っている。**
TSAM AI 側のログインは、その入口を整えているにすぎない。

---

## 3. IDトークンは表示用途だけに使う

`apps/google-auth.js` の `decodeIdTokenPayload()` は、
JWT の payload を読むだけで **署名検証を行わない。**

```text
ブラウザで取得したGoogleプロフィール情報は、
表示および利用者体験のために使用する。

静的サイトへのアクセス制御や、
サーバー側権限判定の根拠には使用しない。
```

**IDトークンをセキュリティ境界として使用しない。**
`apps/auth-config.js` の冒頭にも同じ位置付けが書かれている。
どちらかを直すときは、両方を揃えること。

### 署名検証をブラウザへ自作実装しないこと

技術的には WebCrypto と Google の JWKS で検証できる。
**しかし実装してはならない。**

検証コードもその判定結果も、利用者が制御するブラウザの中にある。
`return true` に書き換えれば通るため、**手間だけ増えて安全にならない。**

「検証したから安全」という誤解を生むぶん、むしろ危険である。

サーバー側の判定が必要になったら、第7節の条件に従ってバックエンドを用意する。

### 保存されるもの

`apps/auth-session.js` が `sessionStorage` にだけ保存する。

| 保存する | 保存しない |
|---|---|
| `sub` `name` `email` `picture` `emailVerified` `expiresAt` | IDトークン本体 / アクセストークン / refresh token / 上記以外のclaim |

タブを閉じると消える。`localStorage` は使わない。

---

## 4. Drive認可との分離

**この分離を壊さないこと。**

```text
Googleログイン        openid / email / profile 相当のみ
                      → 利用者の識別

Drive認可             drive.file（アプリが作ったファイルのみ）
                      drive.readonly（knowledge の読み取り）
                      → Driveを使う機能を開いたときだけ追加で要求
```

| モジュール | 役割 |
|---|---|
| `apps/google-auth.js` | ログイン。**IDトークン**を扱う |
| `apps/shared/drive-auth.js` | Drive認可。**アクセストークン**を扱う（`initTokenClient`） |

### 守るべき規則

1. **ログイン時にDriveスコープを要求しない。**
   初回の同意画面に「Googleドライブのファイルの表示・管理」が出ると、
   利用者は身構える。ログインしたいだけの人に、Driveの許可を求めない。
2. **アプリを開いた時点で、そのアプリに必要な最小スコープだけを要求する。**
3. **`drive`（全体）へ広げない。**
   `drive.file` は制限スコープではないため、Googleの審査を避けられる。
   `drive.readonly` は制限スコープであり、審査対象になる。

この規則は `apps/tests/browser/google-links.mjs` の第6・7節で機械的に検査している。
ログイン経路のファイルに `auth/drive` の文字列が現れると失敗する。

---

## 4-2. ログイン後に `/apps/home/` へ遷移させない理由

Googleログインが成功しても、**画面遷移は起こさない。**
同じ画面の中で表示が切り替わるだけである。

`/apps/home/` は Supabase 認証のホーム画面で、
`guardPage()` が `shared/auth.js` のセッションを要求する。

Googleログイン（`apps/google-auth.js`）は
`shared/auth.js` のセッションを作らない。
両者は別系統であり、`sessionStorage` のキーも違う。

```text
Googleログイン    tsam-ai-google-profile   （sessionStorage）
Supabase認証      tsam-ai-session          （localStorage）
```

したがって、Googleログイン後に `/apps/home/` へ送ると
**guardPage() が弾いて `/apps/login/` へ戻し、堂々巡りになる。**

遷移させたい場合は、`shared/auth.js` の provider として
Google を実装する必要がある。それは別の作業であり、
現時点では行っていない（`GOOGLE_AUTH_MIGRATION_ASSESSMENT.md` 第5節）。

---

## 5. アカウントをお持ちでない方への導線

ログイン領域には、Googleアカウントを持たない利用者向けに2つのリンクを出す。

| 対象 | リンク先 | 費用 |
|---|---|---|
| 個人 | `https://accounts.google.com/signup` | **無料** |
| 法人・チーム | Google Workspace 紹介プログラム | **有料** |

### 表示の規則

- **「無料」と書いてよいのは通常のGoogleアカウント側だけ。**
  Workspace 側は有料であり、紹介リンクの転送先は料金ページである。
- Workspace 側には必ず次を表示する。
  - Google Workspace 紹介プログラムのリンクであること
  - Google Workspace は有料サービスであること
  - Google LLC が提供する外部サービスへ移動すること
- 両方とも `target="_blank"` と `rel="noopener noreferrer"` を付ける。
  `noopener` だけでは Referer が漏れるため、`noreferrer` も要る。
- 外部へ出ることを、**目に見える文字**で書く（`aria` 任せにしない）。
- Workspace のリンクを Google公式ボタンに似せない。
  紹介リンクを公式の導線と見間違えさせないため、意図的に文字リンクにしている。

### URLの正本

**URLを書いてよいのは `apps/shared/external-links.js` だけ。**

HTMLへ直接書かない。画面は `apps/google-auth.js` が組み立てる。
同じ領域が `/apps/`（アプリ一覧）と `/apps/favorites.html` の
両方に出るため、HTMLへ書くと2か所へ複製されて必ずずれる。

変更するときはこのファイルだけを直す。テストが値を固定している。

### 紹介URLの状態（2026-07-28 確認）

```text
https://referworkspace.app.goo.gl/2KTq
  ↓ 302 Found
https://workspace.google.com/pricing?utm_source=sign-up
  &utm_medium=affiliatereferral&utm_campaign=apps-referral-program
  &uj=ref.promo~save10&uj=ref.referrer~<紹介者ID>
```

- 転送先は Google 公式ドメイン（`workspace.google.com`）である
- `utm_medium=affiliatereferral` — アフィリエイト紹介リンクである
- `ref.promo~save10` — 10%割引が付く
- `ref.referrer~...` — 紹介者の識別子が含まれる

**短縮URLのまま使っている。** 転送先を直接書けば
終了済みドメイン系列への依存を外せるが、
**紹介の帰属が転送前の経路にも依存していないという確証が無い。**
帰属が壊れても画面は正常に見えるため、間違いに気づけない。

置き換えるのは、紹介プログラム側の資料で
「直リンクでも帰属する」と確認できてからにすること。

### 短縮URLのリスク

`app.goo.gl` は Firebase Dynamic Links のドメインで、
同サービスは **2025年8月25日に終了**している。

- 出典: https://firebase.google.com/support/dynamic-links-faq （確認日 2026-07-28）

2026-07-28 時点でこのリンクは動作しており、
Workspace 紹介プログラムが Google 自身の運用として
別扱いで維持しているものと見られる。

**ただし予告なく停止する可能性を否定できない。**
停止すると、ボタンが行き先の無いリンクになる。

#### 定期確認の手順（人が行う）

```text
1. ブラウザで https://referworkspace.app.goo.gl/2KTq を開く
2. workspace.google.com の料金ページへ着地することを確認する
3. URLに uj=ref.referrer~ が残っていることを確認する
4. 着地しない場合は apps/shared/external-links.js を見直す
```

**自動テストからは開かない。**
紹介プログラム側へ、テストのたびに通信を発生させないため。

---

## 6. Supabase を当面保持する理由

`apps/shared/auth-providers/supabase.js` ほか、
Supabase 認証の実装は**削除していない。**

| 理由 | 内容 |
|---|---|
| 実接続が未完了 | 接続試験は途中で停止した。**実Supabaseとは一度も通信していない** |
| 判断材料が残る | 監査で見つけた15件の修正が入っており、履歴として意味がある |
| 戻せるようにしておく | サーバー側の利用資格判定が必要になったとき、選択肢として残る |
| 消す理由が無い | どの画面からも参照されておらず、置いておく害が小さい |

**削除は、Google導線の安定稼働を確認したあとの別作業とする。**

### Supabase 文書の現状

| 文書 | 状態 |
|---|---|
| `SUPABASE_SETUP.md` | 手順として有効。**未実施** |
| `SUPABASE_CONNECTION_TEST.md` | チェックリスト。**未実施** |
| `PHASE3_AUDIT_REPORT.md` | 監査記録。有効 |

いずれも「実接続済み」とは書いていない。書かないこと。

---

## 7. Firebase を現時点で導入しない理由

| 理由 | 内容 |
|---|---|
| 現在の目的に不要 | 利用者識別と表示だけなら、既存のGISで足りている |
| 静的サイトの限界は変わらない | Firebase を入れても、HTMLとJSの取得は防げない |
| 依存が増える | SDK・プロジェクト・コンソールが増え、保守対象が広がる |
| 判断を先送りできる | 必要になってから入れても、作り直しにならない |

**Firebase Auth 単体では、静的HTMLやJavaScriptの取得を防げない。**
これを防げるのはサーバー側の判定だけである（第7節）。

---

## 8. 将来サーバー側の判定が必要になる条件

要件が次のいずれかへ変わったら、バックエンドが要る。

```text
許可された利用者だけがAPI処理を実行できる
有料契約者だけがAI機能を使える
社員だけが特定アプリを使える
利用量や料金をサーバー側で管理する
```

### そのとき実装が必要になるもの

Cloud Run 等のバックエンドで、次を**サーバー側で**行う。

```text
Google IDトークンの署名検証
audience（クライアントID）の検証
issuer（accounts.google.com）の検証
有効期限の検証
許可ユーザーまたは契約状態の確認
APIキーのサーバー側保持（ブラウザへ配らない）
利用量制限
監査ログ
```

### 拡張点

| 現在 | 追加するとき |
|---|---|
| `google-auth.js` がIDトークンを表示用に読む | IDトークンをバックエンドへ送り、検証結果を受け取る |
| Gemini APIキーを利用者のブラウザが持つ | バックエンドが持ち、ブラウザへ配らない |
| Drive認可がブラウザ完結 | 変更不要（利用者自身のDriveのため） |

**この段階でも、静的HTMLの取得は防げない。**
防げるのは「APIが処理を実行するかどうか」だけである。
画面を隠すことと、処理を拒むことは別物である。

---

## 9. よくある問題

| 症状 | 原因 |
|---|---|
| 「Googleログインは現在準備中です」 | `apps/auth-config.js` の `clientId` が未設定 |
| 「Googleログインを読み込めませんでした」 | GIS を取得できていない（ネットワーク遮断・拡張機能） |
| ボタンが出ない | 承認済みJavaScript生成元に現在のオリジンが無い |
| ログインしても表示が消える | `sessionStorage` を使うため、タブを閉じると消える（仕様） |
| 紹介リンクが開かない | 短縮URLが停止した可能性（第5節の定期確認） |

---

## 10. 関連ファイル

```text
apps/auth-config.js                 クライアントID・GIS配信元
apps/gis-loader.js                  GIS公式スクリプトの読み込み
apps/google-auth.js                 ログイン・表示・アカウント作成導線の組み立て
apps/auth-session.js                表示用プロフィールの保存（sessionStorage）
apps/shared/external-links.js       外部リンクの正本
apps/shared/drive-auth.js           Drive認可（ログインとは別）
apps/AUTH_SETUP.md                  Google Cloud 側の設定手順
apps/GOOGLE_AUTH_MIGRATION_ASSESSMENT.md  方式比較と将来の選択肢
apps/tests/unit/shared.mjs          外部リンクの値と検査
apps/tests/browser/google-links.mjs 画面表示・属性・分離の検査
```
