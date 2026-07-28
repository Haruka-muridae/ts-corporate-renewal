# コミット計画（Phase 1〜3 + 監査）

**実行済み。** 以下の3コミットをローカルに作成した。**push はしていない。**

| # | ハッシュ | メッセージ | ファイル数 | 直後のテスト |
|---|---|---|---|---|
| 1 | `05afe64` | `feat(auth): add TSAM AI authentication foundation` | 33 | 691/691 |
| 2 | `ad6e53c` | `test(auth): add authentication test suite` | 18 | 691/691 |
| 3 | （このコミット） | `docs(auth): add Supabase setup, operations, and audit records` | 5 | 文書のみ |

作成前の HEAD は `22e1197`。以下は計画時の記述をそのまま残す。

---

## 前提

### 分割できない理由

Phase 1〜3 は連続して開発され、**過去Phase単位へ安全に分割できない**。

具体的には:

- `apps/shared/auth.js` は Phase 2 で作られ、Phase 3 と監査で大幅に書き換えられた。
  途中状態のファイルは存在せず、切り出すには手作業での復元が必要になる。
- `apps/shared/session.js` は Phase 3 でスキーマを v1→v2 へ上げている。
  Phase 2 時点の版でコミットしても、Phase 3 のコードとは噛み合わない。
- `apps/login/` `apps/home/` も同様に Phase 2 → 3 → 監査で連続的に変わっている。

**無理に Phase 単位へ分けると、どのコミットもテストが通らない状態になる。**
そのため指示にある代替案「認証基盤本体 / セキュリティ修正＋テスト / 文書」に
近い形で、**各コミット単位でテストが通る**構成にする。

### 実行前に必ず確認すること

```sh
git log --oneline -1        # 22e1197 であること
git status --short          # ステージ済みが 0 件であること
npm test                    # 691/691 であること
```

---

## コミット 1: 認証基盤本体

```text
feat(auth): add TSAM AI authentication foundation

Add a shared foundation under apps/shared/ and the account screens that
use it: email/password login backed by Supabase Auth, TOTP two-factor
authentication, password reset, and email confirmation.

The authentication provider is swappable. When apps/shared/supabase-config.js
is left at its placeholder values, the app falls back to a dummy provider
and performs no external requests, so the screens can be reviewed before a
Supabase project exists.

The Supabase Auth SDK is self-hosted under apps/vendor/ rather than loaded
from a CDN, because a compromised CDN serving the login page could capture
passwords. ES module imports cannot carry an integrity attribute.

Existing apps under /apps/ are untouched and no authentication guard is
applied to them yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

### 対象ファイル（新規 33）

```text
apps/shared/README.md
apps/shared/app-paths.js
apps/shared/auth.js
apps/shared/session.js
apps/shared/bootstrap.js
apps/shared/supabase-config.js
apps/shared/supabase-client.js
apps/shared/auth-providers/dummy.js
apps/shared/auth-providers/supabase.js
apps/shared/ai-types.js
apps/shared/ai-client.js
apps/shared/ai-config.js
apps/shared/drive-auth.js
apps/shared/drive-files.js
apps/shared/profile-store.js
apps/shared/providers/local.js
apps/shared/providers/gemini.js
apps/login/index.html
apps/login/login.js
apps/home/index.html
apps/home/home.js
apps/account/index.html
apps/account/account.js
apps/password-reset/index.html
apps/password-reset/reset.js
apps/auth-callback/index.html
apps/auth-callback/callback.js
apps/account.css
apps/vendor/supabase-auth-js-2.110.8.esm.js
apps/vendor/LICENSE-supabase-auth-js.txt
apps/vendor/NOTICE-supabase-auth-js.md
apps/vendor/check-updates.mjs
.gitattributes                       （変更：vendor の改行変換除外）
```

| 項目 | 内容 |
|---|---|
| 依存 | なし（`22e1197` の直後） |
| 単独でテスト可能か | **不可**。テストがコミット2にあるため |
| 実行するテスト | コミット2と合わせて `npm test` |
| ロールバック | `git revert` で安全。既存アプリは参照していないため、戻しても他が壊れない |
| 無関係な変更 | 含まない。`.gitattributes` の追加行は vendor 用のみ |

**注意**: `apps/shared/` には Phase 6/7 用の雛形
（`profile-store.js` `ai-*.js` `providers/*.js`）が含まれる。
これらは**まだどの画面からも使われていない**。
「認証基盤」という表題と厳密には一致しないが、
Phase 1 から一体として作られており分離の利点が無いため同梱する。

---

## コミット 2: テスト

```text
test(auth): add authentication test suite

Add 691 checks covering the authentication foundation: session handling,
two-factor authentication, password reset, redirect validation, and
GitHub Pages sub-path deployment.

Browser tests drive headless Chrome through the DevTools Protocol and
start their own static server, so no external setup is required. They
add no npm dependencies.

All Supabase interactions are exercised against a fake GoTrue client.
Nothing here has been verified against a real Supabase project; the
checklist for that is in apps/SUPABASE_CONNECTION_TEST.md.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

### 対象ファイル（新規 11 + 変更 1）

```text
apps/tests/README.md
apps/tests/run.mjs
apps/tests/helpers/assert.mjs
apps/tests/helpers/env.mjs
apps/tests/helpers/fake-gotrue.mjs
apps/tests/helpers/static-server.mjs
apps/tests/helpers/chrome.mjs
apps/tests/helpers/browser-harness.mjs
apps/tests/unit/shared.mjs
apps/tests/unit/shared-dom.mjs
apps/tests/unit/auth.mjs
apps/tests/unit/supabase.mjs
apps/tests/unit/paths.mjs
apps/tests/unit/audit.mjs
apps/tests/browser/login-flow.mjs
apps/tests/browser/phase3-screens.mjs
apps/tests/browser/audit.mjs
package.json                         （変更：test スクリプト追加）
```

| 項目 | 内容 |
|---|---|
| 依存 | **コミット1が必須**（テスト対象が存在しないと動かない） |
| 単独でテスト可能か | 可（コミット1の後なら `npm test` が通る） |
| 実行するテスト | `npm test` → 691/691 |
| ロールバック | 安全。テストのみのため製品コードに影響しない |
| 無関係な変更 | `package.json` に `test` 系スクリプトを追加。既存の `dev`/`build`/`lint`/`typecheck` は未変更 |

---

## コミット 3: 文書

```text
docs(auth): add Supabase setup, operations, and audit records

Add the setup procedure for a Supabase project, the operational runbook
for account recovery (including what to do when a TOTP device is lost),
a connection-test checklist to run once a project exists, and the audit
report for the authentication foundation.

The audit found and fixed one critical open redirect and three high
severity session issues. Details are in apps/PHASE3_AUDIT_REPORT.md.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

### 対象ファイル（新規 5）

```text
apps/SUPABASE_SETUP.md
apps/AUTH_OPERATIONS.md
apps/SUPABASE_CONNECTION_TEST.md
apps/PHASE3_AUDIT_REPORT.md
apps/COMMIT_PLAN.md               （このファイル。不要なら除外してよい）
```

| 項目 | 依存 |
|---|---|
| 依存 | なし（単独でコミット可能） |
| 単独でテスト可能か | 該当なし（文書のみ） |
| 実行するテスト | 不要 |
| ロールバック | 安全 |
| 無関係な変更 | 含まない |

---

## コミットに含めないもの

| ファイル | 理由 |
|---|---|
| `apps/index.html` | **Phase 1 以前から存在する未コミット変更**。今回の作業では未編集。出所を確認してから別コミットにすること |
| `apps/script.js` | 同上 |
| `apps/style.css` | 同上 |
| `apps/app-api.js` `apps/app-card.js` `apps/app-config.js` `apps/app-store.js` `apps/apps-index.js` | 同上（お気に入り機能。Phase 1 以前から未追跡） |
| `apps/favorites.html` `apps/favorites.css` `apps/favorites.js` `apps/FAVORITES_SETUP.md` | 同上 |
| `apps/assets/` | 同上（アプリのアイコン） |
| `apps/payroll-transfer/` | 同上（給与振込支援アプリ） |
| `gas/` | 同上（Apps Script） |
| `.claude/` | 担当者ごとの設定。共有しない |

**これらは今回の作業とは無関係である。**
まとめてコミットすると、後から「認証基盤の変更」を追えなくなる。
出所を確認したうえで、別途コミットするかどうかを判断すること。

---

## 実行手順（承認後）

```sh
# 1. 現状確認
git log --oneline -1
git status --short
npm test

# 2. コミット1
git add apps/shared apps/login apps/home apps/account apps/password-reset \
        apps/auth-callback apps/vendor apps/account.css .gitattributes
git status --short          # 意図したものだけか確認
git commit                  # メッセージは上記

# 3. コミット2
git add apps/tests package.json
git status --short
git commit

# 4. コミット3
git add apps/SUPABASE_SETUP.md apps/AUTH_OPERATIONS.md \
        apps/SUPABASE_CONNECTION_TEST.md apps/PHASE3_AUDIT_REPORT.md \
        apps/COMMIT_PLAN.md
git commit

# 5. 確認
git log --oneline -4
npm test
```

`git add -A` や `git add .` は使わないこと。
無関係な未追跡ファイルを巻き込む。

### 禁止する操作

```sh
git reset --hard    # 未コミットの作業が消える
git clean -fd       # 未追跡ファイルが消える
git checkout .      # 同上
git restore .       # 同上
git rebase          # 履歴の書き換え
git push --force
```

---

## push について

**push しない。**
実 Supabase 接続試験（`SUPABASE_CONNECTION_TEST.md`）が終わり、
Phase 4 へ進む条件を満たしてから判断する。
