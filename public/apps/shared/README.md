# apps/shared — 全アプリ共通基盤

`/apps/` 配下のすべてのアプリが共有するモジュールを置く。
このディレクトリは **Phase 1（基盤のみ）** の成果物であり、
既存アプリからはまだ読み込まれていない。

---

## 1. このディレクトリの位置付け

| 置いてよいもの | 置いてはいけないもの |
|---|---|
| Google認可（アクセストークン取得） | DOM操作・画面文言・CSS |
| Drive APIの汎用操作 | 特定アプリだけが使う処理 |
| プロフィール／AI設定の保存層 | 秘密情報（client secret / APIキーの実値） |
| 純関数（検証・正規化・組み立て） | 外部ライブラリへの依存 |

UI は各アプリ側（`apps/mypage.js` など）に置く。
`shared/` のモジュールは **`document` が無くても import できる**こと。

---

## 2. ファイル一覧

| ファイル | 状態 | 役割 |
|---|---|---|
| `bootstrap.js` | 実装済 | 全アプリの単一入口。ここだけを読み込めば共通機能が使える |
| `auth.js` | 実装済 | **TSAM AI へのログイン**。プロバイダ差し替え式（Googleとは無関係） |
| `session.js` | 実装済 | ログインセッションの保存層。期限付き |
| `auth-providers/dummy.js` | **仮実装** | 動作確認用。**パスワードを検証しない** |
| `drive-auth.js` | 実装済 | OAuth 2.0 Token Model。アクセストークンの取得・キャッシュ・再認可 |
| `drive-files.js` | 実装済 | Drive API v3 の汎用操作。フォルダ解決 / JSON の作成・読込・更新 |
| `profile-store.js` | **雛形** | マイページ情報の検証・キャッシュ・Drive同期。**項目定義は暫定** |
| `ai-config.js` | **雛形** | AI利用モードとAPIキーの保存層。UIは持たない |
| `ai-client.js` | **雛形** | AI呼び出しの共通入口。プロバイダを選ぶだけ |
| `providers/local.js` | **雛形** | 無料モード（ブラウザ内処理）。未実装 |
| `providers/gemini.js` | **雛形** | マイAPIキーモード（Gemini）。未実装 |

「雛形」は、**インターフェースと保存層は確定しているが、実処理が未実装**という意味。
呼ぶと `NOT_IMPLEMENTED` を投げる関数には、その旨をコメントで明記してある。

---

## 3. import パスの規約

**サイト内絶対パス（`/apps/shared/...`）は使わない。**
独自ドメイン（`https://tsam-ai.com/apps/`）でもプロジェクトPages
（`https://<user>.github.io/<repo>/apps/`）でも同じ成果物が動くようにするため。

| 呼び出し元 | パス |
|---|---|
| `apps/index.html` の module | `./shared/bootstrap.js` |
| `apps/<アプリ名>/*.js` | `../shared/bootstrap.js` |
| `apps/knowledge-src/src/**` | `../../../shared/bootstrap.js`（Viteがビルド時にバンドルする） |

knowledge だけは Vite でバンドルされるため、実行時ではなく **ビルド時**に取り込まれる。
ソースは1つのまま、成果物が2形態になる
（`knowledge-src/scripts/generate-auth-config.mjs` と同じ考え方）。
状態（localStorage / sessionStorage）は同一オリジンなので実行時に完全に共有される。

### 新しいアプリの追加手順

```html
<script type="module" src="../shared/bootstrap.js"></script>
```

この1行でプロフィールとAI設定が使える。個別ファイルを直接 import しないこと
（内部構成を変えたときに全アプリを直す羽目になる）。

---

## 4. 設定値の正本

| 値 | 正本 |
|---|---|
| OAuthクライアントID | `apps/auth-config.js` の `GOOGLE_AUTH_CONFIG.clientId` |
| GISスクリプトURL・タイムアウト | `apps/auth-config.js` |
| GISの読み込み | `apps/gis-loader.js`（**単一ローダー**。二重読み込みを防ぐ） |
| Driveのフォルダ名 | `shared/drive-files.js` の `DRIVE_PATHS` |
| ストレージキー | 各モジュールの `STORAGE_KEYS`（第6節に一覧） |

`shared/` は `apps/auth-config.js` と `apps/gis-loader.js` を **import して再利用する**。
コピーしない。GISローダーのシングルトンを共有しないと、
公式スクリプトが二重に読み込まれる。

---

## 5. セキュリティ方針

このリポジトリへ絶対に入れてはならないもの:
client secret / APIキーの実値 / refresh token / アクセストークン /
サービスアカウント秘密鍵 / 個人の認証情報。

| 情報 | 保存先 | 理由 |
|---|---|---|
| アクセストークン | **メモリのみ** | Storage・cookie・URL・ログのいずれにも書かない |
| IDトークン（credential） | **保存しない** | 表示に必要な項目だけを取り出して破棄する |
| Gemini APIキー | sessionStorage（既定） | 利用者が明示した場合のみ localStorage |
| プロフィール | 正本は利用者自身のGoogle Drive | ブラウザ側はキャッシュのみ |

**Gemini APIキーは Google Drive へ保存しない。**
`profile-store.js` の `PROFILE_FIELDS` にキーの類を追加しないこと。

ログへ出してよいのは「有無」「件数」「エラー種別名」だけ。
トークン本体・APIキー・メールアドレス・OAuthレスポンス全体は出さない。

---

## 6. ストレージキー一覧

| キー | 種別 | 定義場所 | 内容 |
|---|---|---|---|
| `tsam-ai-session` | localStorage | `shared/session.js` | TSAM AI のログインセッション（12時間） |
| `tsam-ai-google-profile` | sessionStorage | `apps/auth-config.js` | 既存。Googleアカウント表示用（`shared/` は読むだけ） |
| `tsam-ai-profile-cache` | localStorage | `shared/profile-store.js` | Drive の profile.json のキャッシュ |
| `tsam-ai-mode` | localStorage | `shared/ai-config.js` | `'free'` / `'my-key'` |
| `tsam-ai-key-persist` | localStorage | `shared/ai-config.js` | APIキーの保存先の記録 |
| `tsam-ai-gemini-key` | session / local | `shared/ai-config.js` | Gemini APIキー |

---

## 7. カスタムイベント

`document` に対して発行する。既存の `tsam-auth-change`（`apps/google-auth.js`）と同じ方式。

| イベント名 | detail | 発行元 |
|---|---|---|
| `tsam-session-change` | `{ authenticated, session }` | `shared/session.js`（TSAM AI のログイン） |
| `tsam-auth-change` | `{ status, profile }` | 既存 `apps/google-auth.js`（**Googleアカウント表示。別物**） |
| `tsam-shared-ready` | `{ auth, profile, ai, signedIn }` | `shared/bootstrap.js` |
| `tsam-profile-change` | `{ source, profile }` | `shared/profile-store.js` |
| `tsam-ai-config-change` | `{ mode, hasApiKey, persist }` | `shared/ai-config.js` |

---

## 8. ポップアップに関する制約（重要）

`google.accounts.oauth2` の `requestAccessToken()` は **ポップアップを開く**。
そのため **利用者の操作（クリック）から直接呼ぶ必要がある**。

したがって次は実装できない。

- ページ読み込み時に自動で Drive を読む
- ログイン完了イベントを受けて自動で Drive にアクセスする

Drive にアクセスする処理は **すべてボタン押下起点**にすること。
`drive-auth.js` の `withAccessToken()` が行う401後の再取得も、
利用者操作から離れるとブロックされうる。呼び出し側は失敗時に
「再接続」ボタンを提示する設計にする（`voice-recorder/drive-save.js` が実例）。

---

## 9. Phase の進め方

正式な画面遷移は次のとおり。

```
TSAM AI ログイン → 個人ホーム → Google Drive連携 → プロフィール同期 → AI設定 → 各アプリ
```

Googleアカウントはログインには使わない。
ログイン後の個人ホームから「Drive連携」として任意で行う。

| Phase | 内容 | 状態 |
|---|---|---|
| 1 | `apps/shared/` 新設。既存アプリは無変更 | **完了** |
| 2 | TSAM AI の認証基盤（ログイン画面・個人ホーム・セッション） | **完了** |
| 3 | 実認証プロバイダの導入（Firebase / Supabase / 自前API） | 未着手 |
| 4 | 個人ホームからの Google Drive 連携 | 未着手 |
| 5 | プロフィール画面（`profile-store.js` を使う） | 未着手 |
| 6 | AI設定画面、`providers/` の実装 | 未着手 |
| 7 | voice-recorder / knowledge を `shared/` へ移行 | 未着手 |

各アプリの移行はまだ行っていない。
`voice-recorder/drive-auth.js` と `shared/drive-auth.js` は独立して動いており、
トークンキャッシュも別に持つ（誰も `shared/drive-auth.js` を使っていないため衝突しない）。
