# X 投稿アプリ（x-post）組み込みガイド

このアプリを別のプロダクト・別のリポジトリへ移植することを想定した文書。実装の正は [docs/specs/x-post-requirements-v1.md](../../specs/x-post-requirements-v1.md)（差分仕様）と [docs/specs/threads-mvp-requirements-v1.md](../../specs/threads-mvp-requirements-v1.md)（基底仕様）。

## 1. 移植の前提条件

- **TSAM AI固有のログイン基盤（`public/auth/`）に依存している。** `guardPage()` によるセッション確認、`KeyStore` によるGemini APIキー管理を前提に画面を描画しており、移植先に同等の認証基盤・キー管理が無い場合はこの部分を丸ごと差し替える必要がある（§3）。
- **本アプリはサーバーコードを持たない。** 移植先も静的ホスティング（またはそれに相当する配信）を前提にできる場合に最も労力が少ない。
- **X 側の intent リンク仕様に依存している。** `https://x.com/intent/post?text=…` は X 公式の仕組みだが、この文書化された保証（未ログイン時の `redirect_after_login` によるログイン後の本文保持）は実機確認（2026-08-12）によるものであり、X 側の仕様変更で挙動が変わりうる。
- **Gemini 生成を使う場合のみ**、移植先で利用者自身が Gemini APIキーを用意できる導線（本アプリはキー入力欄を持たない）が必要。生成機能自体は無くても他の機能（書く・貼る・投稿・下書き・履歴）は成立する。

## 2. 依存関係マップ

```mermaid
flowchart LR
    subgraph XPost["x-post（移植対象）"]
        direction TB
        AppJs["app.js"]
        Config["config.js"]
        Post["post.js"]
        Gemini["gemini.js"]
    end

    subgraph TsamAiOnly["TSAM AI 本体への依存（移植先に無ければ差し替え必須）"]
        AuthSession["public/auth/session.js（guardPage）"]
        AuthConfig["public/auth/config.js（setScreenDepth）"]
        AuthKeyStore["public/auth/keystore.js（KeyStore・PROVIDERS）"]
        AuthCss["public/auth/auth.css・css/style.css"]
    end

    subgraph SiblingCoupling["姉妹アプリとの結合（緩い・参照のみ）"]
        ThreadsPost["threads-post（post.js の複製元）"]
        ShortScript["short-script（gemini.js の方針の複製元）"]
    end

    AppJs --> AuthSession
    AppJs --> AuthConfig
    AppJs --> AuthKeyStore
    AppJs -.見た目のみ.-> AuthCss
    Post -.実装方針を複製.-> ThreadsPost
    Gemini -.エラー分類・呼び出し方針を複製.-> ShortScript

    XPost --> GeminiApi["Gemini API"]
    XPost -.window.open のみ・fetch なし.-> XSite["X（x.com）"]
```

| 依存先 | 種別 | 移植時の扱い |
| --- | --- | --- |
| `public/auth/session.js`（`guardPage`）、`public/auth/config.js`（`setScreenDepth`） | TSAM AI本体の共通JS | 移植先の認証基盤に合わせて差し替える（§3） |
| `public/auth/keystore.js`（`KeyStore` / `PROVIDERS` / `isKeyStoreAvailable`） | TSAM AI本体のAPIキー管理 | 移植先に同等のキー管理が無ければ、キー入力・保管の仕組みを新設するか、`apiKey` を直接渡す形へ `generatePost()` の呼び出し側を書き換える（`gemini.js` 自体はキーを引数で受け取るだけで実装非依存） |
| `public/auth/auth.css`、`../../css/style.css` | 見た目の共通CSS | 必須ではない。移植先の見た目に合わせて自前のCSSに置き換え可能 |
| `threads-post`（同一リポジトリの姉妹アプリ） | 実装方針の複製元 | 移植先には存在しないコードなので気にしなくてよいが、`post.js` の関数構成・命名はこの複製元と揃っている。将来の保守で本家（`threads-post`）の修正を追随させるかどうかは移植先の運用判断 |
| `short-script`（同一リポジトリの別アプリ） | `gemini.js` のエラー分類・呼び出し方針の複製元 | 同上。Gemini呼び出しの実装自体は自己完結しており、移植先で `short-script` を用意する必要はない |
| Portal（`public/portal/app-registry.js`） | 起動元 | 移植先のアプリ起動導線（メニュー等）に合わせて差し替える。本アプリ自体はPortalへの依存を持たない（URLを直接開けば動く） |

## 3. 切り離しポイント

| 箇所 | 現状の実装 | 切り離し方 |
| --- | --- | --- |
| 画面ガード（ログイン確認） | `app.js` が `guardPage()`（TSAM AI認証系）を呼ぶ | 移植先の認証チェック関数に差し替える。戻り値として「利用者情報オブジェクト or null」を返す契約を保てば、`app.js` の呼び出し側コードはほぼそのまま使える |
| Gemini APIキーの取得 | `app.js` が `KeyStore.get(PROVIDERS.gemini)` を都度呼ぶ | 移植先のキー管理（環境変数・自前ストレージ等）に合わせて、`generatePost({ apiKey, ... })` へ渡すキーの取得元だけを差し替える。`gemini.js` 自体の変更は不要 |
| X intent のベースURL | `config.js` の `X_INTENT_BASE`（`https://x.com/intent/post`） | X 側の仕様が変わらない限りそのまま使える。他の投稿先（Threads・note等）へ展開する場合は `threads-post`／`note-post` を参照し、それぞれの投稿先の受け口（intent の有無）に応じて `post.js` の `buildIntentUrl` 相当を書き換える |
| 280ウェイトの計数ルール | `post.js` の `weightOf()`（4つのコードポイント範囲） | X 固有のルールであり他の投稿先には適用しない。文字数上限の考え方が違う投稿先へ移植する場合は、この関数ごと差し替える（`note-post` はコードポイント基準、`threads-post` は500字の単純カウント） |
| CSP | `index.html` の `<meta http-equiv="Content-Security-Policy">` | 移植先の配信基盤のCSPに合わせて再設定する。`connect-src` には Gemini API のホストと、必要なら認証系のホストを含める。`x.com` は fetch しないため含めない |
| 見た目（CSS） | `public/auth/auth.css` と `css/style.css` を前提にした差分CSS | 移植先のデザインシステムに合わせて `style.css` を書き直す。`index.html` の外部CSS参照を外し、必要なスタイルを移す |
| Portalからの起動 | Portal（`app-registry.js`）経由の起動のみで、アプリ内にPortalへの明示リンクは無い | 移植先の遷移導線（メニュー・ヘッダー等）に合わせて必要なリンクを追加する |

## 4. 必要な外部サービスと設定作業の概要

1. **Gemini API（AI生成機能を使う場合のみ）**
   - Google AI Studio 等で発行した APIキーを、利用者自身が用意する（当社・移植先が代理で保有・課金しない設計を維持する場合）。
   - 有効化するAPIは Generative Language API（`generativelanguage.googleapis.com`）。
   - クライアント側でキーを扱うため、キーの露出範囲（ブラウザの開発者ツール等から見える）を利用者に周知する運用が必要（KeyStoreのコメントに準じた説明）。
2. **X（旧 Twitter）側の設定は不要。** intent リンクは公開のWeb機能であり、APIキー・アプリ登録・OAuthのいずれも要らない。
3. **Google Cloud側の設定は不要。** OAuth（GIS）を使わないため、クライアントID発行等の作業は無い。

## 5. 複製時の注意

[docs/repository-structure.md](../../repository-structure.md) §4 の方針（本番アプリ間で共通層を作らず複製する）に従う。

- **複製元パスと複製日をファイル冒頭コメントに書く。** `x-post` の `gemini.js` が「方針（台本メーカー `../short-script/gemini.js` と同じ）」と明記しているように、複製元と方針の一致点をコメントで残す。
- **複製元の欠陥をそのまま持ち込まない。** 本書執筆時点で `threads-post`／`short-script` に起因する既知の不具合は見当たらない（`tests/unit/x-post.mjs` が通過する前提。検証状況は [01_requirements.md](./01_requirements.md) §9「未確定事項」を参照）。移植時に複製元へ修正が入っていないか確認したうえで複製する。
- **純粋関数でも「複製してよい」と即断しない。** `countWeight()` のようなコードポイント判定関数も、X固有の重み範囲（`U+0000–U+10FF` 等）という方針が乗っている。他の投稿先へ展開する場合は、その投稿先の文字数ルールを個別に確認してから実装する（`note-post` はコードポイント基準の単純カウント、`threads-post` は500字上限という別ルール）。
- **X 側の実機確認事項を引き継ぐ。** 未ログイン時に `redirect_after_login=<intent URL>` でログイン後に本文が保持されることは実機確認済み（2026-08-12）だが、X 側の仕様変更で崩れうる前提であることをコメントに残し、移植先でも定期的な実機確認を検討する。

## 6. 最小組み込み手順

1. `public/production-app/x-post/` 配下の全ファイル（`index.html` / `config.js` / `post.js` / `gemini.js` / `app.js` / `style.css`）を移植先へコピーする（`import` で参照せず、ファイルごと複製する）。
2. `config.js` を移植先の値に書き換える。
   - `DEFAULT_MODEL` / `FALLBACK_MODEL`（使用するGeminiモデル。移行時点で存在するモデル名か要確認）
   - `X_INTENT_BASE`（X側の仕様変更が無ければそのまま）
   - `WEIGHT_LIMIT` / `THEME_MAX_LENGTH` / `STORAGE_KEY` / `HISTORY_LIMIT`（移植先の運用に合わせて調整可能）
3. `app.js` のTSAM AI依存部分（`guardPage` / `setScreenDepth` / `KeyStore` 関連の import）を、移植先の認証チェック・レイアウト機構・APIキー管理に差し替える。契約（「利用者情報 or null を返す非同期関数」「APIキー文字列を返す関数」）を保てば、以降のロジック（`post.js` / `gemini.js`）はそのまま使える。
4. `index.html` のCSPを移植先の配信基盤に合わせて設定し（`connect-src` に Gemini API のホストを含める）、見た目（CSS参照）を移植先のデザインに合わせる。
5. Gemini 生成機能を使う場合、利用者自身がAPIキーを用意・入力できる導線を用意する（本アプリはキー入力欄を持たないため、移植先の方針に応じて追加するか、KeyStore相当の仕組みを移植する）。
6. `tests/unit/x-post.mjs` 相当のテスト（`countWeight` / `validatePostText` / `buildIntentUrl` / 保存関数 / `generatePost` の純粋ロジック検証）を移植先のテスト基盤に合わせて用意し、実行する。通信はスタブ（`fetchImpl` の差し替え）で行い、本物のGemini APIを叩かない。
7. 実ブラウザでの結線確認スイートを用意する場合は、`card-mail` の `tests/browser/card-mail.mjs` を参考にする（`x-post` 自体には本書執筆時点で同等のスイートが無い。§5「複製時の注意」および 01_requirements.md §9 参照）。
8. 起動導線（Portal相当のメニュー）へ追加する。
