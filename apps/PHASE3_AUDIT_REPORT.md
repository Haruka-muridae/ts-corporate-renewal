# Phase 3 監査レポート（Supabase Auth 認証基盤）

## 1. 総合判定

### B：軽微な作業が残っている

コード側で見つかった問題はすべて修正し、リポジトリ内だけで
再実行できるテスト **691件が全通過** している。

**A（実接続へ進める）と断言しない理由:**

**実 Supabase とは一度も通信していない。**
検証はすべて偽の GoTrue クライアントに対するもので、
Supabase が実際に返す値との一致は確認できていない（第13節）。

残っている作業は人間の手による設定と実機確認だけで、
コード変更は不要である。手順は `SUPABASE_CONNECTION_TEST.md`。

---

## 2. 監査日時

| | |
|---|---|
| 実施 | 2026-07-27 〜 2026-07-28 |
| 対象コミット | `2aae4fc`（未コミットの作業ツリーを対象） |
| ブランチ | `feat/apps-favorites` |
| 実行環境 | Windows 11 / Node v24.15.0 / Chrome 150.0.7871.184 |

---

## 3. 対象範囲

```text
apps/shared/            認証・セッション・パス解決・共通基盤
apps/shared/auth-providers/   dummy / supabase
apps/login/             ログイン画面（TOTP段階を含む）
apps/home/              個人ホーム
apps/account/           アカウント設定（TOTP・メール・パスワード）
apps/password-reset/    パスワード再設定
apps/auth-callback/     メールリンクの受け口
apps/vendor/            同梱した認証ライブラリ
apps/tests/             テスト一式
```

既存アプリ（`/apps/`・favorites・voice-recorder・knowledge・payroll-transfer）は
**影響が無いことの確認のみ**を行い、変更していない。

---

## 4. 対象外

- 実 Supabase プロジェクトの作成・接続
- Google OAuth / Google Drive 連携（Phase 5 以降）
- プロフィール機能（Phase 6）
- AI 設定（Phase 7）
- `/apps/` への認証ガード適用（Phase 4）
- 本番デプロイ

---

## 5. 発見した問題

### 集計

| 優先度 | 件数 |
|---|---|
| Critical | 1 |
| High | 3 |
| Medium | 8 |
| Low | 1 |
| Informational | 2 |
| **セキュリティ・実装 合計** | **15** |
| 監査プロセスの不備（別枠） | 4 |
| **総計** | **19** |

---

### Critical

#### C-1: `safeNextUrl` のバックスラッシュ迂回によるオープンリダイレクト

| | |
|---|---|
| **問題** | `?next=\\evil.example.com` が検証をすり抜け、ログイン後に外部サイトへ遷移した |
| **影響** | 正規ドメインでログインさせた直後に攻撃者のサイトへ送れる。フィッシングの踏み台 |
| **再現** | `/apps/login/?next=%5C%5Cevil.example.com` を開いてログイン。`\/host` `\\\host` も同様 |
| **原因** | WHATWG URL 解析は http/https でバックスラッシュをスラッシュへ正規化する。`startsWith('//')` 等の文字列判定では原理的に防げない |
| **修正ファイル** | `apps/shared/app-paths.js`（新規）、`apps/shared/auth.js` |
| **修正内容** | 文字列判定ではなく「実際に解決してオリジンとパスを検証」する方式へ変更。バックスラッシュは含む時点で拒否 |
| **テスト** | `unit/paths.mjs`（24種 × 6配信形態）、`browser/audit.mjs` 第5節（実ブラウザ6種） |
| **残存リスク** | なし。同一オリジン内の無害な404のみ通過する |
| **実接続確認** | 不要 |

---

### High

#### H-1: 認証確認前に保護コンテンツを描画していた

| | |
|---|---|
| **影響** | localStorage を1行書き換えるだけで個人ホームとアカウント設定が表示された |
| **再現** | 未ログインで `tsam-ai-session` を偽造し `/apps/home/` を開く |
| **修正ファイル** | `apps/shared/auth.js`、`apps/home/home.js`、`apps/account/account.js` |
| **修正内容** | `guardPage()` を追加。サーバー確認が済むまで `hidden` を外さない |
| **テスト** | `unit/audit.mjs` A節、`browser/audit.mjs` 第2節 |
| **残存リスク** | ダミープロバイダには照合先が無いため写しが通る（仕様。テストで明示） |
| **実接続確認** | 必要（実セッションでの拒否） |

#### H-2: BFCache（戻るボタン）で個人情報が復元された

| | |
|---|---|
| **影響** | ログアウト後に「戻る」でスクリプト未実行のまま個人画面が復元されうる |
| **修正ファイル** | `apps/shared/auth.js`、`apps/home/home.js`、`apps/account/account.js` |
| **修正内容** | `watchAuthState()` を追加（`pageshow`/`persisted` + `storage` + プロバイダ購読） |
| **テスト** | `unit/audit.mjs` H節、`browser/audit.mjs` 第3-4節 |
| **残存リスク** | なし |
| **実接続確認** | 不要 |

#### H-3: 中断した MFA で AAL1 セッションが残留

| | |
|---|---|
| **影響** | コード入力中に再読み込みすると入力待ち情報が消え、認証基盤側に AAL1 セッションが残ったまま利用者はパスワードからやり直しになる |
| **修正ファイル** | `apps/shared/auth.js`、`apps/login/login.js` |
| **修正内容** | `resumePendingMfa()` を追加。要素が読めない場合はセッションを破棄 |
| **テスト** | `unit/audit.mjs` E節 |
| **残存リスク** | なし |
| **実接続確認** | 必要（E-4） |

---

### Medium

| ID | 問題 | 修正ファイル | テスト |
|---|---|---|---|
| M-1 | `watchProviderSession` がどこからも呼ばれずタブ間同期が無効 | `auth.js` `home.js` `account.js` | `unit/audit.mjs` H節 |
| M-2 | 末尾スラッシュ無しURLで `../home/` が一段ずれる（検証と遷移で基準が違う） | `app-paths.js` `auth.js` `login.js` | `unit/paths.mjs` 第5節 |
| M-3 | TOTP の QR・secret を無検証で DOM へ渡していた | `auth-providers/supabase.js` | `unit/audit.mjs` D節 |
| M-4 | `auth-callback` がコードをURLに持つ状態で外部フォントを読み込んでいた | `auth-callback/index.html` | `browser/audit.mjs` 第8節 |
| M-5 | 設定値の空白・引用符が未除去（原因不明の401を招く） | `supabase-client.js` | `unit/audit.mjs` J節 |
| M-6 | `?stage=set` に通常ログイン中でも入れた | `auth.js` `reset.js` `callback.js` | `browser/phase3-screens.mjs` 第7節 |
| M-7 | パスワード変更後も他端末のセッションが生存 | `auth.js` `supabase.js` `account.js` `reset.js` | `unit/audit.mjs` F節 |
| M-8 | 確認メール再送に連打防止が無い | `account/account.js` | 手動確認 |

M-6 の本当の制御は Supabase 側の **Secure password change** 設定である
（画面側の目印は導線の整理にすぎない）。`SUPABASE_SETUP.md` 第A-3補足に記載。

---

### Low

#### L-1: `getProviderStatus()` の `configured` が誤る

明示的にダミーへ差し替えた場合、設定ファイルが埋まっていると
`configured: true` を返していた。`auth.js` で修正。

---

### Informational

#### I-1: 自己ホストSDKは自動追跡できない

`@supabase/auth-js` は `package.json` に載らないため
Dependabot 等が更新を検知できない。

`apps/vendor/check-updates.mjs` を追加し、`npm run check:vendor` で
手動確認できるようにした。

**2026-07-28 時点で 2.110.9 が公開されている**（同梱は 2.110.8）。
挙動が変わる可能性があるため自動更新はしていない。更新は人の判断で行う。

#### I-2: PKCE は同じブラウザでリンクを開く必要がある

検証用の値がリンクを要求したブラウザに保存されるため、
別端末・別ブラウザ・プライベートウィンドウでリンクを開くと失敗する。
`SUPABASE_SETUP.md` 第3節と `AUTH_OPERATIONS.md` に記載。

---

### 監査プロセスの不備（別枠・セキュリティ問題ではない）

| ID | 問題 | 対応 |
|---|---|---|
| P-1 | テスト9本が一時ディレクトリにしか存在せず、第三者が再現できなかった | `apps/tests/` へ移設。`npm test` で実行可能に |
| P-2 | 前回の Git 状態報告が `git status --porcelain \| grep "^ M"` のみを見ており、**ステージ済み251件を見落としていた** | 本レポート第16節で全状態を報告 |
| P-3 | 問題件数の合計と内訳が一致していなかった（「8件」と書きながら15件を列挙） | 第5節で再集計 |
| P-4 | ブラウザテストが外部で起動したサーバー・Chrome に依存し、後片付けもされていなかった | `apps/tests/helpers/` で起動と後片付けを自動化 |

---

## 6. 修正内容（ファイル別）

| ファイル | 区分 | 内容 |
|---|---|---|
| `apps/shared/app-paths.js` | 新規 | 配信ベースパスの解決、遷移先の検証（C-1 M-2） |
| `apps/shared/auth.js` | 変更 | `guardPage` `watchAuthState` `resumePendingMfa` `markRecoveryFlow` `consumeRecoveryFlow`、`updatePassword` の他端末失効、`getProviderStatus` 修正 |
| `apps/shared/supabase-client.js` | 変更 | 設定値の正規化（M-5） |
| `apps/shared/auth-providers/supabase.js` | 変更 | QR/secret 検証、`revokeOtherSessions`、コールバックURL生成の共通化 |
| `apps/shared/session.js` | 変更 | `aal` / `emailConfirmed` を追加（v1→v2） |
| `apps/shared/bootstrap.js` | 変更 | 新APIの再エクスポート |
| `apps/home/home.js` | 変更 | `guardPage` で描画を待つ、`watchAuthState` |
| `apps/account/account.js` | 変更 | 同上、再送クールダウン、他端末失効の表示 |
| `apps/login/login.js` | 変更 | MFA 復帰、遷移先の解決を統一 |
| `apps/password-reset/reset.js` | 変更 | 目印の消費、他端末失効 |
| `apps/auth-callback/index.html` | 変更 | 外部フォントの読み込みを廃止 |
| `apps/auth-callback/callback.js` | 変更 | 目印の設定 |
| `apps/vendor/check-updates.mjs` | 新規 | SDK 更新の確認 |

---

## 7. テスト一覧

| スイート | ファイル | 内容 |
|---|---|---|
| shared | `apps/tests/unit/shared.mjs` | Phase 1 共通基盤・循環import・Drive操作 |
| shared-dom | `apps/tests/unit/shared-dom.mjs` | ストレージ・カスタムイベント |
| auth | `apps/tests/unit/auth.mjs` | ログイン・セッション・遷移判定・プロバイダ差し替え |
| supabase | `apps/tests/unit/supabase.mjs` | Supabase プロバイダの全経路 |
| paths | `apps/tests/unit/paths.mjs` | ベースパス解決・オープンリダイレクト |
| audit | `apps/tests/unit/audit.mjs` | 監査で追加した状態遷移 |
| browser:login-flow | `apps/tests/browser/login-flow.mjs` | ログイン〜ログアウトの一周 |
| browser:phase3-screens | `apps/tests/browser/phase3-screens.mjs` | Phase 3 の画面・SDK非読込 |
| browser:audit | `apps/tests/browser/audit.mjs` | 偽装・bfcache・サブパス・既存アプリ隔離 |

---

## 8. テスト実行コマンド

```sh
npm test              # 全部（691件）
npm run test:unit     # Node のみ（488件・Chrome 不要）
npm run test:browser  # 実ブラウザのみ（203件）
npm run test:auth     # 認証まわり
npm run test:audit    # 監査で追加した分
npm run check:vendor  # 同梱SDKの更新確認
```

追加のnpmパッケージは不要。Node 標準機能と Chrome だけで動く。

---

## 9. テスト結果

```text
shared                       82/82
shared-dom                   36/36
auth                         89/89
supabase                     87/87
paths                      119/119
audit                        75/75
browser:login-flow           67/67
browser:phase3-screens       69/69
browser:audit                67/67
----------------------------------
合計                       691/691
```

ブラウザテストの対象:
`/apps/login/` `/apps/home/` `/apps/account/` `/apps/password-reset/`
`/apps/auth-callback/` と既存5ページ。
解像度 320・375・768・1024・1440px。

実行後の残留: Chrome プロセス 0 / LISTENING ポート 0 / 一時プロファイル 0。

---

## 10. GitHub Pages パス検証

| 形態 | 検証 |
|---|---|
| 独自ドメイン相当 | ok |
| プロジェクトPages（`/repo/apps/`） | ok |
| リポジトリ名が "apps" | ok |
| localhost | ok |
| 末尾スラッシュ無し | ok |
| `index.html` 明示 | ok |
| クエリ付き | ok |
| ハッシュ付き | ok |

実ブラウザでも `/ts-corporate-renewal/apps/` を配信し、
ログイン→home 遷移・`next` 生成・オープンリダイレクト防御を確認した。

---

## 11. SDK 監査

| 項目 | 結果 |
|---|---|
| パッケージ | `@supabase/auth-js` 2.110.8（認証専用。フルSDKではない） |
| ライセンス | MIT（全文同梱） |
| SHA-256 | `2b14251341a0d7be226ae24b740eb5f6d0ebe048743b187882812474263f90db` |
| サイズ | 97,956 バイト |
| ファイル名・NOTICE・埋込値 | 一致 |
| `eval` / `new Function` | 0件 |
| `sourceMappingURL` | 0件 |
| Node固有API | 0件 |
| ハードコード外部ホスト | 0件（`http://localhost:9999` は GoTrue の既定値定数。常に `url` を渡すため未使用） |
| tslib | ヘルパー0件（es2022 で不要） |
| 更新確認 | `npm run check:vendor` |

**2.110.9 が公開済み。** 更新は行っていない（挙動変更の可能性があるため）。

---

## 12. 既存アプリへの影響

`/apps/`・`/apps/favorites.html`・`/apps/voice-recorder/`・
`/apps/payroll-transfer/`・`/apps/knowledge/` の5ページで確認。

- リダイレクトされない
- Supabase SDK を読み込まない
- 認証モジュールを読み込まない
- Supabase へ通信しない
- 認証用 localStorage キーを作らない
- コンソールエラーなし

CDP の Network イベントで実測（`browser/audit.mjs` 第7節）。
**これらのファイルは Phase 1〜3 を通して一度も変更していない。**

---

## 13. 実 Supabase でしか確認できない事項

**すべてのテストは偽の GoTrue クライアントに対するものである。**
実サービスとの通信は一度も行っていない。

1. Supabase が返す実際のエラーコードと写像表の一致
2. TOTP の QR が `data:image/svg+xml` であること
3. 共有鍵が Base32（A-Z 2-7）であること
4. メールの到達とリンクのリダイレクト
5. PKCE の code verifier の実挙動
6. `signOut({scope:'others'})` が実際に他端末を切ること
7. レート制限の実挙動
8. Confirm email / Secure password change の強制力

2 と 3 は実装側で検証を入れているため、**想定と違えば
QRが表示されない・共有鍵が空になる**という形で現れる。

---

## 14. 次に人間が行う操作

`apps/SUPABASE_CONNECTION_TEST.md` を上から順に実行する（設定30分＋試験60分）。

1. Supabase プロジェクト作成
2. **公開サインアップを無効化**（最優先）
3. **Secure password change を ON**
4. Confirm email / Secure email change / パスワード8文字
5. TOTP 有効化
6. Site URL / Redirect URLs 登録
7. SMTP 設定
8. `apps/shared/supabase-config.js` へ Project URL と anon key
9. 自分を招待して A〜K を実施

---

## 15. Phase 4 へ進む条件

`SUPABASE_CONNECTION_TEST.md` の **特に重要な6項目**が全通過すること。

- D-2 誤パスワードで登録の有無が漏れない
- D-3 未確認メールでログインできない
- E-2 二段階認証を通らずに home へ入れない
- E-6 AAL1 で account へ入れない
- F 未登録アドレスでも同じ文言
- J Network に第三者への通信が無い

これらが落ちた状態でガードを適用すると、
守れていないのに守れているつもりになる。

---

## 16. Git 状態（2026-07-28 監査終了時点）

```text
ステージ済み（A ）     0 件
未ステージ変更（ M）    5 件
未追跡（??）           26 エントリ / 82 ファイル
HEAD                   22e1197
```

### 監査中に発生した変化（記録）

監査の途中まで、**ステージ済み 251 件**（`apps/knowledge/` 197 +
`apps/knowledge-src/` 53 + `apps/KNOWLEDGE_SETUP.md` 1）が index に存在した。

これは監査作業とは無関係の既存 knowledge アプリで、
監査中（2026-07-28 08:41）に利用者自身の手で
`22e1197 feat: publish browser knowledge base` としてコミットされた。

そのコミットに **Phase 1〜3 および監査の成果物は含まれていない**
（確認済み）。監査側から `git add` / `git commit` は一度も実行していない。

### 未ステージ変更 5 件

| ファイル | 出所 |
|---|---|
| `.gitattributes` | 監査（vendor の改行変換除外を追加） |
| `package.json` | 監査（テストスクリプトを追加） |
| `apps/index.html` | **Phase 1 以前から存在した変更**（Phase 1〜3 では未編集） |
| `apps/script.js` | 同上 |
| `apps/style.css` | 同上 |

### 未追跡 26 エントリの分類

| 分類 | エントリ |
|---|---|
| Phase 1（共通基盤） | `apps/shared/` の一部 |
| Phase 2（ログイン・セッション） | `apps/login/` `apps/home/` `apps/account.css` |
| Phase 3（Supabase・MFA） | `apps/account/` `apps/password-reset/` `apps/auth-callback/` `apps/vendor/` |
| 監査修正 | `apps/shared/app-paths.js` |
| 監査テスト | `apps/tests/` |
| 文書 | `SUPABASE_SETUP.md` `AUTH_OPERATIONS.md` `SUPABASE_CONNECTION_TEST.md` `PHASE3_AUDIT_REPORT.md` |
| **無関係（Phase 1 以前から未追跡）** | `apps/app-*.js` `apps/apps-index.js` `apps/favorites.*` `apps/assets/` `apps/payroll-transfer/` `apps/FAVORITES_SETUP.md` `gas/` |
| **コミット対象外** | `.claude/`（担当者ごとの設定） |

---

## 17. コミット状況

```text
コミットしていない
push していない
本番デプロイしていない
実 Supabase へ接続していない
```

コミット計画は本レポートとは別に提示している。
`/apps/` への認証ガードも適用していない（Phase 4 の作業）。
