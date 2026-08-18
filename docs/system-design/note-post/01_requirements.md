# note 下書きアプリ（note-post）要件定義書

作成: 2026年8月18日

> 本書は `docs/system-design/_authoring-guide.md` の規約に従う。実装と
> [docs/specs/note-post-requirements-v1.md](../../specs/note-post-requirements-v1.md)（以下「差分仕様書」）
> および差分仕様書が基底とする
> [docs/specs/threads-mvp-requirements-v1.md](../../specs/threads-mvp-requirements-v1.md)（以下「基底仕様書」）が正であり、
> 本書は移植を検討する読者向けに要点を整理したものである。詳細は各仕様書の該当 §番号を参照する。

## 1. 目的・背景

TSAM AI の利用者が、note への記事を「書く／貼る／AIで作る」→ 下書きとして端末内に残す →
note の作成画面を開いて仕上げる、を1画面で行えるようにする（差分仕様書 §0、基底仕様書 §2）。

- Threads 投稿アプリ（`threads-post`）を土台に、note 固有の制約へ合わせた**差分実装**である
  （差分仕様書冒頭）。認証・端末内保存の骨格・Gemini 呼び出し方式・セキュリティ方針は
  Threads 版と同一であり、note 版が独自に定義するのは「タイトルと本文が別枠であること」
  「本文プリフィルの URL が存在しないこと」への対応と、記事向けの生成内容である
  （差分仕様書 §2）。
- 記事生成のプロンプト方針（見出し付き・目安 1500〜2000字・創作の禁止）は、既存の
  note 記事生成ツール「note-auto-fill-gas」の方針を引き継ぐ（差分仕様書 §2.3）。ただし
  note-auto-fill-gas 自体のコードを import・複製してはいない。**note-post とは別系統の
  独立したツールである点は §2 を参照。**
- 最後に note へ「投稿する」操作は必ず利用者本人が note の画面上で行う（intent リンクや
  note API を使わない）。当社サーバー・当社が管理する外部APIキーは本文・下書き・履歴を
  一切受け取らない（基底仕様書 §2 の重点1・2を note 版にも適用）。

## 2. 用語定義

| 用語 | 意味 |
| --- | --- |
| note | 個人・法人が記事を書いて配信できる外部のコンテンツプラットフォーム（note.com）。本アプリの投稿先。 |
| 作成画面 | note の新規記事作成エディタ（`https://note.com/notes/new`）。本文プリフィルの URL は存在しないため、コピー＆貼り付けで内容を渡す（差分仕様書 §2.2）。 |
| 2段階コピー方式 | クリップボードが一度に1件しか持てないことに対応した流し込み手順。1回目にタイトル（空なら本文）をコピーして作成画面を開き、2回目に「本文をコピー」でこのタブへ戻って本文を渡す（差分仕様書 §2.2）。 |
| BYOK | Bring Your Own Key。Gemini APIキーは利用者本人が発行し、利用者自身が使う。当社は預からない（基底仕様書 §2、KeyStore の設計原則）。 |
| KeyStore | `public/auth/keystore.js`。Gemini APIキーをブラウザの localStorage（キー名 `tsam-api-keys`）へ保存する共通モジュール。 |
| guardPage | `public/auth/session.js` が提供する、保護対象ページの入口関数。サーバー検証が済むまで画面内容を描画させない。 |
| 下書き | 端末内（localStorage）に保存する、タイトル＋本文の組。note へ送信されるものではない（差分仕様書 §2.1、post.js）。 |
| 履歴 | 「作成画面を開いた」という、こちら側で観測できた事実だけを記録した一覧。note 側で実際に公開されたかは観測できない（基底仕様書 §3.5、差分仕様書 §2.2）。 |
| note-helper | `public/apps/note-helper/`。本アプリとは**無関係の別系統**のツール。Chrome拡張を移植したもので、公開GASの記事キューから記事を取得して note へ貼り付ける用途。§3.3 を参照。 |

## 3. スコープ

### 3.1 含む

- Portal 掲載の本番アプリとして、ログイン済み利用者向けに提供する（FR-01）。
- 記事（タイトル＋本文）の入力・文字数検証（FR-02）。
- テーマ・指示からの Gemini による記事生成（タイトル・本文を別々に、JSON 形式で受け取る。FR-07）。
- 生成内容の調整用「書き方の調整」プロンプトの端末内保存（FR-08）。
- 「note で書く」による2段階コピー＆作成画面オープン（FR-03、FR-04）。
- 下書きの保存・呼び出し・削除、履歴の記録・表示（いずれも端末内のみ。FR-05、FR-06）。
- 保存領域が使えない環境でも、書く・生成する・作成画面を開く操作自体は継続できること（FR-10）。

### 3.2 含まない（対象外）

- note 公式APIによる下書き作成・投稿（note は投稿作成のAPIを公開していないため。差分仕様書 §3）。
- 本文の URL パラメータによるプリフィル（note にその受け口が存在しない。実機確認済み。差分仕様書 §3）。
- Threads/X 版との共有モジュール化（本番アプリ間で共通層を作らない方針。差分仕様書 §3、
  [repository-structure.md](../../repository-structure.md) §4-1）。
- note への実際の「公開」操作の自動化・観測（最後の投稿は必ず利用者が note の画面で行う。
  本アプリはそれを観測できない。基底仕様書 §3.5）。
- 予約投稿・複数プラットフォーム同時投稿・画像投稿・分析機能（基底仕様書 §2 の対象外方針を踏襲）。

### 3.3 note-helper（`public/apps/note-helper/`）との関係整理

同じ「note」を扱うが、**設計思想も認証方式も投稿元データも異なる別系統のツール**である。

| 観点 | note-post（本書の対象） | note-helper（参考・対象外） |
| --- | --- | --- |
| 配置 | `public/production-app/note-post/`（本番アプリ） | `public/apps/note-helper/`（テスト環境。Portal 未掲載） |
| 認証 | `guardPage()` によるログイン必須 | なし（誰でも画面を開ける） |
| 記事の由来 | 利用者がその場で書く／AIで生成する | 外部の GAS Web アプリ（noteArticleApi.js）が管理するスプレッドシートのキューから1件ずつ取得する |
| 外部通信 | Gemini API・当社認証APIのみ。当社サーバーへ本文を送らない | 利用者が入力した任意の GAS Web アプリ URL へ直接 fetch（**GAS 側の公開設定次第で誰でも操作できる**旨が script.js 冒頭コメントに明記） |
| note への遷移先 | `https://note.com/notes/new` | `https://editor.note.com/new`（別URL） |
| タイトル・本文 | 別枠で保持し、2段階コピーで流し込む | 「タイトルと本文」をまとめて1回でコピーする導線もある |

**乖離ではなく設計の違い**であり、note-post のドキュメント化にあたって note-helper 側のコード・
仕様変更は行わない。差分仕様書 §2.3 が引用する「note-auto-fill-gas」（記事生成の方針の引き継ぎ元）と
note-helper が使う GAS API（noteArticleApi.js）は名称が近いが、本書の調査範囲では両者の同一性・
関係は確認できていない（§9 未確定事項）。

## 4. 利用者とロール

| 利用者 | 前提 | 制約 |
| --- | --- | --- |
| ログイン済みの一般利用者 | `guardPage()` によるサーバー検証済みセッション（`tsam-auth-session`） | 未ログインはログイン画面へ強制遷移。中身（`#np-content`）は描画されない。 |
| AI 生成利用者 | 上記に加え、KeyStore に自分の Gemini APIキーを保存済み（`KeyStore.has('gemini')`） | 未設定時は案内（Portal への誘導リンク）を表示し、生成以外の機能（書く・貼る・保存・作成画面を開く）はそのまま使える。 |
| 手書き・貼り付け利用者 | ログインのみ | Gemini キー不要。 |

ロールによる権限分岐（管理者／一般利用者の区別）はこのアプリには存在しない。

## 5. 機能要件

| ID | 要件 | 補足 |
| --- | --- | --- |
| FR-01 | Portal（`public/portal/app-registry.js`）にアプリID `note-post` で掲載し、ページ自身も `setScreenDepth(2)` + `guardPage()` で保護する | `id` は登録済み。以後変更しない（基底仕様書 §3.1、apps-grid-spec-v1.md §4-c）。 |
| FR-02 | タイトル入力欄と本文欄を分けて持つ。文字数カウント（コードポイント基準）は本文のみに上限（30,000字）を設け、超過は赤く示す | タイトルは空でも許容する（note 側も無題を許すため。差分仕様書 §2.1）。検証は本文の空・上限超過のみを見る（post.js `validatePostText`）。 |
| FR-03 | 「note で書く（タイトルをコピー）」で、タイトル（空なら本文）をクリップボードへコピーし、note の作成画面（`https://note.com/notes/new`）を別タブ（`noopener,noreferrer`）で開く | 本文の検証（空・上限超過）を通過してからのみ実行する。クリップボードが許可されない環境では、コピーを諦めて作成画面のオープンのみ行い、その旨を画面に表示する（差分仕様書 §2.2）。 |
| FR-04 | 「本文をコピー」で、本文をクリップボードへコピーする（2段階目） | FR-03 と同じ検証を通過してから実行する。 |
| FR-05 | 「下書き保存」で端末内（localStorage、キー `tsam-note-post-v1`）へタイトル付きで追記する。一覧から「呼び出す」「削除」（削除は確認あり）ができる | 本文が空の下書きは保存できない。壊れた保存データは読み捨て、次の保存で作り直す（アプリを止めない。post.js）。 |
| FR-06 | 「作成画面を開いた」事実を、タイトル・本文・日時つきで履歴へ記録し新しい順に表示する。記録範囲がこちら側の事実に限られる旨を画面に明記する | 保持は直近100件。超えた分は古い順に捨てる（post.js `HISTORY_LIMIT`）。 |
| FR-07 | 「テーマ・指示」（上限100字）から Gemini で記事を1本生成し、タイトル・本文をそれぞれの欄に入れる | 出力は `responseMimeType: 'application/json'` で `{ "title", "body" }` を受け取る（コードフェンス付きでも剥がして読む）。本文が空なら生成失敗として扱う。入力中の内容がある場合は置き換え前に確認する（差分仕様書 §2.3）。 |
| FR-08 | 「書き方の調整」欄（文体・トーン等の指示）を常設し、入力は自動的に端末内へ保存、以後の生成で毎回使う | 空にすれば使われない。先頭2000字で頭打ちにしてプロンプトへ差し込む（下書き・履歴の操作では消えない。基底仕様書 §3.6、post.js `saveStylePrompt`/`loadStylePrompt`）。 |
| FR-09 | Gemini APIキー未設定時は生成ボタン付近に Portal への設定案内を表示し、画面へ戻ったとき（`visibilitychange`/`focus`）に状態を読み直す | キー入力欄はこのアプリに作らない（KeyStore の一元管理。基底仕様書 §3.6）。 |
| FR-10 | localStorage が使えない環境でも、書く・生成する・作成画面を開く操作は動作させ、保存機能のみ使えない旨を画面に表示する | `isStorageAvailable()` によるプローブ判定（post.js）。 |

## 6. 非機能要件

| ID | 分類 | 要件 |
| --- | --- | --- |
| NFR-01 | セキュリティ | 記事本文・下書き・履歴は端末内（localStorage）にのみ保存し、当社サーバーへは一切送信しない。送信先は Gemini API と認証確認のみに CSP で固定する（基底仕様書 §7、index.html の CSP コメント）。 |
| NFR-02 | セキュリティ | Gemini APIキーは KeyStore からその都度読み、モジュール内変数として保持しない。例外メッセージ・console にキーを出さず、`x-goog-api-key` ヘッダーで送りURLへは載せない（gemini.js 冒頭コメント）。 |
| NFR-03 | セキュリティ | CSP は `index.html` の `<meta>` で宣言し、`connect-src` を `self`／Gemini／認証確認先（Apps Script・auth-verify Worker）に限定する。**note.com へは fetch しない**（作成画面は別タブで開くのみ）ため `connect-src` に含めない（index.html 冒頭コメント）。 |
| NFR-04 | セキュリティ | DOM 組み立ては `createElement`/`textContent` のみで行い `innerHTML` を使わない（app.js 全体、リポジトリ共通方針）。 |
| NFR-05 | 可用性 | Gemini・当社認証APIが不調でも、書く・貼る・下書き保存・作成画面を開く操作は独立して利用できる（生成のみが影響を受ける）。 |
| NFR-06 | 運用 | 本番アプリ間で共通層を作らない方針に従い、`gemini.js` のエラー分類・呼び出し方式は台本メーカー（`short-script/gemini.js`）と同型実装として**複製**しており、import はしない（gemini.js 冒頭コメント、[repository-structure.md](../../repository-structure.md) §4-1）。 |
| NFR-07 | 運用 | 配信は本リポジトリの `main` へのコミット＋手動デプロイ（`npm run deploy`）。Meta・Google Cloud 側の作業は不要（Google OAuth を使わないため）。 |
| NFR-08 | アクセシビリティ | セマンティックHTML、`role="status"`/`aria-live` によるメッセージ通知、`prefers-reduced-motion` への配慮（`auth.css` 共通方針、AGENTS.md）。 |

## 7. 制約条件

- サーバーコードを持たない静的アプリであること（BYOK 原則の帰結）。
- Portal と同一オリジンに配置すること（KeyStore・guardPage 参照の必須条件）。
- 外部ライブラリを追加しないこと。素の ES モジュールと `fetch` のみを使う。
- `public/production-app/` 配下でアプリ間の共通層（`shared/`/`common/`/`lib/`）を作らないこと。
  同じロジックが要る場合は複製し、複製元パスと複製日を冒頭コメントに書く
  （[repository-structure.md](../../repository-structure.md) §4-1）。
- テスト環境 `public/apps/`（note-helper を含む）のコードを import しないこと。
- `APP_REGISTRY`（`public/portal/app-registry.js`）の `id`（`note-post`）はあとから変更しないこと。
- note には本文プリフィルの URL が存在しないため、2段階コピー方式以外の流し込み手段を持たない
  （差分仕様書 §2.2、§3「採用しなかった提案」）。

## 8. 外部依存

| 依存先 | 用途 | 認証・鍵の扱い |
| --- | --- | --- |
| Gemini API（`generativelanguage.googleapis.com`） | AI モードの記事生成（`generateContent`） | 利用者本人の APIキーを `x-goog-api-key` ヘッダーで送信（BYOK）。当社は預からない。 |
| Apps Script（`script.google.com` / `script.googleusercontent.com`） | `guardPage()` のセッション検証・ログアウト（`public/auth/api.js` 経由） | 当社の認証基盤。エンドポイントURLは本書に値を書かない。 |
| auth-verify Worker（Cloudflare Workers） | セッション検証のキャッシュ付き代理（`verifySession` の宛先。`public/auth/config.js` の `verifyApiUrl`） | 判定はしない代理であり、有効性の根拠は引き続き Apps Script 側にある。URLは本書に値を書かない。 |
| note（`note.com`） | 記事作成画面（`https://note.com/notes/new`）を別タブで開く | fetch はしない。認証は note 側で完結（未ログイン時は note がログインへ誘導することを実機確認済み。差分仕様書 §2.2）。 |
| Portal アプリ一覧（`public/portal/app-registry.js`） | Portal 上でのカード掲載（アプリID `note-post`／名称「note 下書き」／アイコン「n」） | 登録済み。値そのものは秘密情報ではない。 |

このアプリは Google OAuth（GIS）を使わない。

## 9. 前提条件・未確定事項

- 「note に本文プリフィルの URL が存在しない」ことは 2026-08-12 時点の実機確認結果であり
  （差分仕様書 §2.2）、note 側の仕様変更で将来的に成立しなくなる可能性がある。継続的な再確認の
  運用ルールが定められているかどうかは、コード・既存仕様書からは確認できず**未確定**。
- 実 Gemini API が `responseMimeType: 'application/json'` 指定のもとで、コードフェンスなしの
  安定した `{title, body}` JSON を返し続けることは、同型実装（threads-post／short-script）の
  実装方針を踏襲しているが、note-post 自体での実 API 疎通確認の記録は本書の調査範囲では
  見つからず**未確定**。
- §3.3 で触れた「note-auto-fill-gas」（差分仕様書 §2.3 が生成方針の引き継ぎ元として言及）と、
  `note-helper` が通信する GAS API（`noteArticleApi.js`）が同一のバックエンドを指すのかは、
  本書の調査範囲（note-post 側の実装・仕様書）からは確認できず**未確定**。
- ログイン後の実UI（書く→生成→保存→作成画面を開く一連の操作）の目視確認は、要ログイン環境
  またはプレビュー配信で行う必要があり、本書作成時点では実施していない。

加えて、本書作成にあたり実装（テストスイート構成）から確認できた事実として次を記す
（詳細は [03_detailed-design.md](./03_detailed-design.md) §8）。

- `tests/unit/note-post.mjs`（`node tests/run.mjs note-post`）は Node のみで完結する単体テストであり、
  実ブラウザでの DOM 描画（`app.js`）自体は対象にしていない（同ファイル冒頭コメント）。
