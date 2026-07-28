# コミット計画

**未コミット。この文書は実行前の計画である。**
基準 HEAD: `7c7175c feat: add knowledge setup wizard`

前回の計画（Supabase認証の3コミット）は実行済みで、
`05afe64` `ad6e53c` `bcc7a37` として履歴に入っている。
本文書はその後に積み上がった変更の計画である。

---

## 実行前に確認すること

```sh
git rev-parse --short HEAD    # 7c7175c であること
git status --short
npm test                      # 798/798 であること
```

`git add -A` と `git add .` は使わない。無関係な未追跡ファイルを巻き込む。

---

## コミット 1: Supabase の再認証対応

```text
fix(auth): support Supabase secure password reauthentication

Supabase の Secure password change を有効にすると、パスワード変更に
メールで届くワンタイムコード（nonce）が必要になる。これまでは
updateUser({password}) をそのまま送っていたため、変更が必ず失敗した。

失敗は HTTP 401 で返る。既存の写像では 401 が INVALID_CREDENTIALS へ
落ちるため、画面には「メールアドレスまたはパスワードが正しくありません」
という見当違いの文言が出ていた。reauthentication_needed と
reauthentication_not_valid を、401 の分岐より前で写像する。

アカウント設定画面は、1回目の失敗を受けて確認コードを送り、
入力欄を出してから再送信する。コードは戻り値に含めない。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

### 対象（変更 5）

```text
apps/shared/auth-providers/supabase.js
apps/shared/auth.js
apps/account/index.html
apps/account/account.js
apps/tests/unit/supabase.mjs          （回帰試験13件・偽GoTrueの nonce 対応）
```

| 項目 | 内容 |
|---|---|
| 依存 | なし |
| テスト | `npm run test:auth` |
| 備考 | Supabase は未接続のまま。この修正は偽GoTrueに対して検証している |

---

## コミット 2: テストランナーの異常終了表示

```text
fix(test): report abnormal test suite termination correctly

スイートが途中で落ちると結果行が出ないため、その件数が合計に入らない。
これまでは「合計 401/401」「不合格: 0 件」と表示され、
終了コードが 1 でも人が読むと全部通ったように見えていた。

異常終了したスイート数を明示し、合計に含まれていないことを書く。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

### 対象（変更 1）

```text
apps/tests/run.mjs
```

| 項目 | 内容 |
|---|---|
| 依存 | なし。単独で意味を持つ |
| テスト | `npm test` |

**注意**: `run.mjs` にはコミット4のスイート登録も入る。
分けるなら、この修正を先に入れてから登録行を足す。
同時に入れてよければコミット4へまとめてよい。

---

## コミット 3: Google認証の方式監査

```text
docs(auth): document Google authentication migration assessment

Googleアカウントを認証基盤にできるかを調査した記録。方式5案の比較、
費用比較（公式出典・確認日つき）、テスト影響の分類を含む。

結論として Firebase は導入せず、既存のGoogleログインを共通導線として
整える方針になった。その決定は文書冒頭に追記してある。

静的サイトではどの方式を選んでもHTMLとJSの取得は防げない、という
分析が結論の中心にある。将来サーバー側の判定が必要になったときの
判断材料として残す。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

### 対象（新規 1）

```text
apps/GOOGLE_AUTH_MIGRATION_ASSESSMENT.md
```

| 項目 | 内容 |
|---|---|
| 依存 | なし |
| テスト | 不要（文書のみ） |

---

## コミット 4: Googleログインの正式化とアカウント作成導線

```text
feat(auth): formalize Google login and account creation links

Googleアカウントを持たない利用者向けに、認証パネルへ2つの導線を足す。
通常のGoogleアカウント作成（無料）と、Google Workspace 紹介プログラム
（有料）である。

URLの正本は apps/shared/external-links.js の1か所に置く。同じ領域が
アプリ一覧とお気に入りの両方に出るため、HTMLへ書くと複製されて必ず
ずれる。表示は google-auth.js が組み立てる。

Workspace 側には有料であること、紹介リンクであること、Google LLC が
提供する外部サービスであることを表示する。「無料」と書いてよいのは
通常のGoogleアカウント側だけで、テストがこれを固定している。

紹介URLは短縮URLのまま使う。転送先を直接書けば終了済みドメイン系列
への依存を外せるが、紹介の帰属が転送前の経路に依存していないという
確証が取れていない。帰属が壊れても画面は正常に見えるため気づけない。

Googleログインは引き続き利用者識別と表示のためのもので、アクセス
制御には使わない。Drive 認可との分離も変えていない。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

### 対象（新規 3 + 変更 4）

```text
apps/shared/external-links.js          新規：URLと文言の正本
apps/tests/browser/google-links.mjs    新規：表示・属性・分離の検査（67件）
apps/GOOGLE_AUTH_OPERATIONS.md         新規：運用手引き
apps/google-auth.js                    変更：導線の組み立て
apps/style.css                         変更：.auth-signup の見た目（末尾へ追記）
apps/tests/unit/shared.mjs             変更：正本の値と検査（27件）
apps/tests/run.mjs                     変更：スイート登録1行
apps/SUPABASE_SETUP.md                 変更：保留である旨を追記
apps/SUPABASE_CONNECTION_TEST.md       変更：保留である旨を追記
apps/COMMIT_PLAN.md                    変更：この文書（旧内容は bcc7a37 に残る）
```

| 項目 | 内容 |
|---|---|
| 依存 | コミット2（`run.mjs` を分ける場合） |
| テスト | `npm test` → 798/798 |
| 外部通信 | テストは CDP で外部ホストを遮断している。紹介リンクを開かない |

### ⚠️ `apps/style.css` の扱い

このファイルには**私の変更ではない未コミット変更が同居している**
（お気に入り機能まわり、+62行）。

私が足したのは**末尾へ追記した `.auth-signup` の約50行だけ**である。
分けてコミットしたい場合は `git add -p` で末尾のブロックだけを選ぶ。

---

## コミットに含めないもの

**いずれも今回の作業とは無関係。触っていない。**

```text
apps/index.html          お気に入り機能まわり（未コミット変更）
apps/script.js           同上
apps/style.css           同上（末尾の追記だけが今回分）
apps/app-*.js  apps/apps-index.js
apps/favorites.*  apps/FAVORITES_SETUP.md
apps/assets/  apps/payroll-transfer/  gas/
.claude/                 担当者ごとの設定
```

---

## 禁止する操作

```sh
git add .          git add -A
git reset --hard   git clean -fd
git checkout .     git restore .
git rebase         git push   git push --force
```

---

## push について

**push しない。** 本番反映の判断は別途行う。
