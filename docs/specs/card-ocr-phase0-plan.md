# 名刺OCRアプリ フェーズ0 検証計画

起案: 2026年8月3日

[meishi-ocr-requirements-v3.md](./meishi-ocr-requirements-v3.md) §18 フェーズ0
（方式検証PoC）を実行するための計画。**何を検証しないで済むか**を先に確定し、
残った項目だけに手を掛けることを目的とする。

この文書は要件定義書の下位にある。食い違いがあれば要件定義書が正。

---

## §1 テスト環境 `card-scanner` の監査結果

`public/apps/card-scanner/`（5,937行）を精読した。**要件定義書の方式Bは、
Gemini分類を除いてほぼ全て、このアプリで実証済みである。**

同アプリは `/apps/`（テスト環境）にあり、本番アプリから import してはならない
（[repository-structure.md](../repository-structure.md) §2-1、要件定義書 §3）。
以下は「動くことが確かめられている」という**証拠**として扱い、
コードは本番側へ複製する。

### 1-1. 実証済み（フェーズ0で作り直す必要がない）

| 要件 | 実証している実装 | 根拠 |
| --- | --- | --- |
| **OAuthスコープが `drive.file` のみで足りる** | `DRIVE_SCOPE` は1つだけ。増やさない旨がコメントで固定されている | [drive-auth.js:37](../../public/apps/drive-auth.js#L37) |
| トークンモデル（GIS、メモリ保持） | `initTokenClient` にスコープを渡し、`hasGrantedAllScopes` で付与を検証。トークンは変数に保持 | [drive-auth.js:169-208](../../public/apps/drive-auth.js#L169-L208) |
| **`drive.file` だけで Sheets を操作できる** | 「`spreadsheets.create` と `values.append` は、アプリ自身が作成したスプレッドシートに対してであれば `drive.file` で動作する」 | [card-scanner/README.md:57-59](../../public/apps/card-scanner/README.md) |
| OCR: multipart アップロード＋`ocrLanguage` | `uploadType=multipart` ＋ `mimeType: application/vnd.google-apps.document` ＋ `ocrLanguage` | [drive-ocr.js:439-467](../../public/apps/card-scanner/drive-ocr.js#L439-L467) |
| OCR言語ヒント `ja` | `const OCR_LANGUAGE = 'ja'` | [drive-ocr.js:58](../../public/apps/card-scanner/drive-ocr.js#L58) |
| OCR: `files.export`（text/plain） | `response.text()` で受ける（JSONではない） | [drive-ocr.js:475-480](../../public/apps/card-scanner/drive-ocr.js#L475-L480) |
| **一時ドキュメントの即時完全削除** | `try / finally` で、エクスポート失敗時も削除する | [drive-ocr.js:514-529](../../public/apps/card-scanner/drive-ocr.js#L514-L529) |
| 削除失敗を全体の失敗にしない | `deleteFile` 内で握り、ログだけ残す | [drive-ocr.js:488-502](../../public/apps/card-scanner/drive-ocr.js#L488-L502) |
| **保存構造の3段階解決**（キャッシュ検証→検索→作成） | 「キャッシュが空というだけでは作らない。検索を必ず通す」 | [drive-folders.js:11-27](../../public/apps/card-scanner/drive-folders.js#L11-L27) |
| localStorage はキャッシュであって正本でない | 正本は Drive の実体。消えても段階2で復旧する | [drive-folders.js:5-22](../../public/apps/card-scanner/drive-folders.js#L5-L22) |
| スプレッドシートの用意（作成→フォルダへ移動→見出し行） | `spreadsheets.create` は親を指定できないため、作成後に Drive API で付け替える | [sheets-client.js:567-612](../../public/apps/card-scanner/sheets-client.js#L567-L612) |
| 台帳IDのキャッシュと再発見 | フォルダと同じ3段階 | [sheets-client.js:642-670](../../public/apps/card-scanner/sheets-client.js#L642-L670) |
| **数式インジェクション対策** | `USER_ENTERED` で送りつつ、`/^[=+\-@]/` に一致する値へ先頭アポストロフィを付ける | [sheets-client.js:163-175](../../public/apps/card-scanner/sheets-client.js#L163-L175) |
| 行追加（`values.append`） | `appendCardRow` | [sheets-client.js:942-960](../../public/apps/card-scanner/sheets-client.js#L942-L960) |
| 重複判定キーと重複検出 | メール→携帯→会社名+氏名の優先順位。キー列だけを読む | [sheets-client.js:194-200](../../public/apps/card-scanner/sheets-client.js#L194-L200) / [:832](../../public/apps/card-scanner/sheets-client.js#L832) |
| 画像のSHA-256 | Web Crypto。`crypto.subtle` が無い環境向けに純JS版も持つ | [metadata.js:26-52](../../public/apps/card-scanner/metadata.js#L26-L52) |
| 画像の縮小・JPEG化 | `shrinkToJpeg`、既定の長辺1,600px | [capture.js:23](../../public/apps/card-scanner/capture.js#L23) / [:140](../../public/apps/card-scanner/capture.js#L140) |
| 401時の再認可リトライ | `forceConsent: true` で取り直して1回だけ再実行 | [script.js:1094-1097](../../public/apps/card-scanner/script.js#L1094-L1097) |

**要件定義書 §18 フェーズ0の項目のうち、次の2つは実証済みとして扱ってよい。**

- 「ブラウザからの Drive OCR（multipart + ocrLanguage + export + delete）の疎通」
  → 疎通は実証済み。**精度検証（サンプル30枚以上）だけが残る**
- 「drive.file スコープのみでの保存構造作成・再発見・Sheets操作の成立性検証」
  → **成立性は実証済み。** 再検証は不要

### 1-2. 未検証（フェーズ0で確かめる必要がある）

| 項目 | なぜ未検証か |
| --- | --- |
| **Gemini API の呼び出し** | card-scanner は生成AIを一切使っていない（`gemini` の文字列がリポジトリ内の同アプリに存在しない）。README も「生成AIは使用していない」と明記 |
| **KeyStore 経由のキー取得** | 同上。card-scanner は API キーを必要としない |
| **Portal と同一オリジンでの KeyStore 参照** | card-scanner は `/apps/` 配下で、KeyStore（`public/auth/keystore.js`）を使っていない |
| **`guardPage()` による TSAM AI 認証** | card-scanner は `/apps/` のセッション（`tsam-ai-session`）側。`guardPage` の参照が無い |
| **OAuth同意画面の「外部・本番」公開** | 公開ステータスはコードから判定できない。要件定義書 §6 前提条件4 が要求する状態かどうか不明 |
| **Cloud プロジェクト単位クォータの上限** | コードからは分からない。ダッシュボードでのみ確認できる |
| **CSP の適用可否** | 現在 CSP は設定されていない。GIS を読み込む構成で適用できるかは未確認 |
| **OCR精度（日英混在・縦書き等）** | 疎通と精度は別。要件定義書 §16.1 の評価用サンプル50枚での実測が必要 |
| **行順崩れ対策プロンプト** | Gemini を使わないため検証しようがない |
| **無料枠キーでのレート上限挙動** | 同上 |

### 1-3. 本番へ複製流用できるロジック

**そのまま複製できる**（純粋関数・DOMやアプリ状態に依存しない）:

| 複製元 | 内容 |
| --- | --- |
| `card-scanner/capture.js` | 画像の読み込み・縮小・JPEG化（185行） |
| `card-scanner/metadata.js` の SHA-256 部分 | Web Crypto ＋ 純JS版フォールバック |
| `card-scanner/card-parser.js` | 正規表現による事前抽出（884行、DOM・fetch を参照しない） |
| `card-scanner/sheets-client.js` の `escapeCellText` / `buildDuplicateKey` | 数式インジェクション対策と重複判定キー |
| `card-scanner/drive-ocr.js` の OCR 3手順 | multipart 組み立て・export・delete |
| `card-scanner/drive-folders.js` の3段階解決 | 保存先の解決手順 |

**複製時に変える必要があるもの**:

- フォルダ名。card-scanner は `TSAM AI/名刺スキャナ/`、要件定義書 §FR-07 は
  `TSAM AI/名刺データ/`（[drive-ocr.js:47-53](../../public/apps/card-scanner/drive-ocr.js#L47-L53)）
- 認可層。card-scanner は `apps/drive-auth.js` を使うが、本番は自前に複製する
- 認証。`guardPage()` を入れる（card-scanner には無い）
- 台帳の列構成。要件定義書 §11.2 に合わせる

---

## §2 未検証項目の検証方法

KeyStore と OAuth には**オリジンの制約**がある。これが検証場所を決める。

- KeyStore は `localStorage`。**オリジンが違えば別の保管庫**になる
  （[keystore-spec-v1.md](./keystore-spec-v1.md) §3）
- OAuth は「承認済みJavaScript生成元」に登録したオリジンでしか動かない

### 2-1. ローカルで検証できるもの

`npm run dev`（`http://localhost:3000`）で確認できる。KeyStore は
**同じローカルオリジンの Portal でキーを保存すれば参照できる**。
本番に保存したキーは見えないが、参照の仕組み自体は確かめられる。

| 項目 | 方法 | 合否 |
| --- | --- | --- |
| `guardPage()` が未ログインを弾く | セッションを消して検証ページを開く | `/login/` へ遷移する |
| KeyStore からキーを取得できる | ローカル Portal でキーを保存 → 検証ページで `KeyStore.get('gemini')` | 取得できる。未保存時は Portal へ誘導 |
| KeyStore を直接触っていない | コード検査＋自動テスト | `localStorage` の直接参照が無い |
| **Gemini API の呼び出し** | 利用者キーを `x-goog-api-key` に載せて `generativelanguage.googleapis.com` を叩く | JSON が返る。キーが URL に出ない |
| 構造化出力（JSON Schema） | 同上。名刺テキストのサンプルを投げる | §FR-12 の必須項目が揃う |
| 行順崩れ対策プロンプト | OCR結果を模した「行が入れ替わったテキスト」を投げる | 会社名・氏名が正しい項目に入る |
| 無料枠のレート上限挙動 | 上限まで連続で投げる | 429 が返り、AI-002 の案内に落ちる |
| 数式サニタイズ | `=1+1` を含む値を `escapeCellText` に通す | 先頭にアポストロフィが付く |
| 外部通信先が3系統のみ | `fetch` をスタブして呼び出し先を記録 | §12 の3ホスト以外へ出ない |

> **Gemini はローカルで検証できる。** Gemini API はブラウザから直接叩くだけで、
> オリジンの登録を必要としない（キーはヘッダーで送る）。
> これがローカル検証の範囲を大きく広げている。

### 2-2. 本番URLでしか検証できないもの

| 項目 | なぜローカルで無理か |
| --- | --- |
| **Google OAuth の同意フロー** | 承認済みJavaScript生成元に `http://localhost:3000` が登録されていなければ動かない。登録状況は未確認（§6-1 の確認事項） |
| **本番のキーでの通し確認** | 本番 `tsam-ai.com` の KeyStore に保存されたキーは、他オリジンからは読めない |
| Drive OCR の実データ精度 | OAuth が要るため、上に従属する |
| 保存構造の作成・再発見 | 同上 |
| OAuth同意画面の「未確認アプリ」警告の有無 | 実際の同意画面でしか見えない |
| Cloud クォータの上限値 | ダッシュボードで確認する（コード検証ではない） |

### 2-3. 中間案 — Vercel のプレビューURL

プレビューは `*.vercel.app` で**別オリジン**だが、ブランチごとに安定した
エイリアスが割り当てられる。これを承認済みJavaScript生成元へ登録すれば、
**本番を触らずに OAuth まで含めた検証ができる**。

| | 本番URL | プレビューURL | ローカル |
| --- | --- | --- | --- |
| KeyStore | 本番のキーが使える | そのオリジンで保存し直す | 同左 |
| OAuth | 生成元登録済み（card-scanner 実績） | **生成元の追加登録が必要** | 生成元の追加登録が必要 |
| 到達性 | 誰でも（URLを知れば） | Vercel SSO で保護 | 自分だけ |
| main への影響 | **あり** | 無し | 無し |

**推奨はプレビューURL方式。** `main` を触らずに済み、かつ Vercel SSO で
第三者から見えない。生成元を1つ追加するだけで足りる。

---

## §3 本番ドメインでの検証の進め方

§2-3 の推奨（プレビュー）で足りない場合の手順。**本番の利用者に見える場所へ
検証ページを置く行為**なので、慎重に扱う。

### 3-1. 「Portal未掲載＋`guardPage()` のみ」方式の可否

**技術的には可能。ただし「隠れている」とは考えないこと。**

- `APP_REGISTRY` に載せなければ Portal のグリッドには出ない
- `guardPage()` を入れれば、未ログインでは中身が描画されない
- **しかし HTML と JS の取得自体は防げない。** 静的ホスティングの限界であり、
  [app-registry.js](../../public/portal/app-registry.js) の注意書きと
  SECURITY_NOTES.md が明記しているとおり

したがって、置いてよいのは次を全て満たす場合に限る。

1. 検証ページに秘密情報を書かない（キーもIDもコードに埋めない）
2. 利用者のデータを読み書きしない（自分のアカウントでのみ操作する）
3. 撤去期限を決めてから置く

### 3-2. 手順

```text
1. docs/card-ocr-phase0-plan ブランチから feat/card-ocr-poc を切る
2. public/production-app/card-ocr/poc/ に検証ページを置く
   - guardPage() を必ず入れる
   - APP_REGISTRY には登録しない
3. PR を作り、プレビューURLで動く範囲を先に確認する
4. main へマージ（＝本番公開）。ここは人の判断で行う
5. 本番URL https://tsam-ai.com/production-app/card-ocr/poc/ で検証する
6. 検証が終わったら撤去する（下記）
```

### 3-3. 撤去手順

```text
1. public/production-app/card-ocr/poc/ を削除する PR を作る
2. テストスイート（tests/unit/card-ocr-poc.mjs）も一緒に削除し、
   tests/run.mjs の SUITES から外す
3. main へマージ。1〜2分で URL が404になることを確認する
4. Google Cloud の承認済みJavaScript生成元から、検証用に足したオリジンを外す
```

**撤去を忘れないための仕掛け**: 検証ページの `<h1>` と画面上部に
「検証用。◯月◯日に撤去予定」と日付を書いておく。

---

## §4 人（事業者）側の作業一覧

コードからは実行できない作業。上から順に行う。

### 4-1. Google Cloud の既存設定は流用できるか

**コードから判定できた範囲では、大部分が流用できる。**

| 項目 | 判定 | 根拠 |
| --- | --- | --- |
| Google Drive API の有効化 | **流用可**（有効化済み） | card-scanner と voice-recorder が使用中 |
| Google Sheets API の有効化 | **流用可**（有効化済み） | card-scanner が使用中。README が「このアプリで初めて使う」として有効化を指示済み |
| 承認済みJavaScript生成元 `https://tsam-ai.com` | **流用可** | card-scanner は `tsam-ai.com/apps/card-scanner/` で動作しており、同一オリジン |
| 要求スコープ `drive.file` | **流用可**。追加不要 | [drive-auth.js:37](../../public/apps/drive-auth.js#L37) |
| OAuthクライアントID | **流用は可能だが、分離を推奨**（下記） | [auth-config.js:29](../../public/apps/auth-config.js#L29) に既存IDがある |
| OAuth同意画面の公開ステータス | **不明。要確認** | コードからは判定できない |

> **クライアントIDの分離について**: 要件定義書 §13.4 は「OAuthクライアントは
> 開発用・本番用を分離する」としている。既存IDはテスト環境 `/apps/` が使って
> いるため、本番アプリで共用すると、片方の設定変更がもう片方に及ぶ。
> **新規に作ることを推奨する。** ただし `drive.file` スコープで作成した
> ファイルは**クライアントIDごとに見える範囲が決まる**ため、
> card-scanner が作ったファイルは新しいクライアントからは見えない。
> 本アプリは独自の保存構造を作るので実害は無いが、認識しておくこと。

### 4-2. 作業手順

**A. OAuth同意画面の状態を確認する**

```
https://console.cloud.google.com/apis/credentials/consent
```

- [ ] ユーザータイプが「外部」になっているか
- [ ] 公開ステータスが「本番」か「テスト」か
- [ ] 「テスト」の場合、テストユーザーに自分が入っているか（上限100名）
- [ ] 要求スコープに `drive.file` 以外が入っていないか

→ 結果をこの文書の §6 へ追記する。**「テスト」のままでも、テストユーザーに
自分を入れればフェーズ0の検証はできる。** 「本番」への切り替えは MVP 公開前でよい。

**B. 本番用の OAuth クライアントIDを作る**（推奨）

```
https://console.cloud.google.com/apis/credentials
→ 認証情報を作成 → OAuth クライアント ID → ウェブアプリケーション
```

- [ ] 名前: `TSAM AI card-ocr`（用途が分かる名前にする）
- [ ] 承認済みJavaScript生成元に次を追加
      - `https://tsam-ai.com`
      - 検証にプレビューを使うなら、そのブランチのエイリアスURL
      - ローカル検証をするなら `http://localhost:3000`
- [ ] 発行されたクライアントIDを控える（**秘密ではない**。リポジトリに入れてよい）

> クライアントシークレットは使わない。静的サイトに置けないため
> （[drive-auth.js:29-30](../../public/apps/drive-auth.js#L29-L30)）。

**C. Gemini APIキーを用意する**

```
https://aistudio.google.com/apikey
```

- [ ] キーを発行する（**無料枠で可**。要件定義書 §14.6）
- [ ] `https://tsam-ai.com/portal/` にログインし、API設定パネルへ保存する
- [ ] ローカル検証もするなら `http://localhost:3000/portal/` でも保存する
      （オリジンが違うため別途保存が必要）

**D. クォータの確認**

```
https://console.cloud.google.com/apis/api/drive.googleapis.com/quotas
https://console.cloud.google.com/apis/api/sheets.googleapis.com/quotas
```

- [ ] プロジェクト単位の1分あたり/1日あたりの上限値を控える
- [ ] 想定利用者数に対して足りるかを判断する（要件定義書 §13.1）

**E. 評価用サンプルの用意**

- [ ] 名刺50枚（要件定義書 §16.1 の内訳: 日本語横書き20 / 縦書き8 /
      日英併記8 / 英語のみ5 / ロゴ表記のみ4 / 低品質5）
- [ ] **第三者の個人情報である。** 検証後の取り扱いを決めてから集める

---

## §5 検証の順序と合否判定基準

依存関係の順に並べてある。前が通らないと後ろは検証できない。

| # | 検証項目 | 場所 | 合格基準 |
| --- | --- | --- | --- |
| 1 | `guardPage()` が未ログインを弾く | ローカル | 未ログインで `/login/` へ遷移し、本文が描画されない |
| 2 | KeyStore からキーを取得できる | ローカル | 保存済みなら取得、未保存なら Portal へ誘導。`localStorage` の直接操作が無い |
| 3 | Gemini API の疎通 | ローカル | 200 が返る。キーが URL・console・当社ドメインへの通信に出ない |
| 4 | 構造化出力が仕様どおり | ローカル | §FR-12 の必須項目が揃い、`uncertainFields` が返る。推測での補完が無い |
| 5 | 行順崩れ耐性 | ローカル | 行を入れ替えたテキストでも主要5項目が正しい欄に入る |
| 6 | 数式サニタイズ | ローカル（テスト） | `= + - @` 始まりの値にアポストロフィが付く |
| 7 | 外部通信先が3系統のみ | ローカル（テスト） | §12 の3ホスト以外へ `fetch` しない |
| 8 | OAuth 同意フロー | プレビュー or 本番 | `drive.file` のみを要求。同意後にトークンが取れる |
| 9 | 保存構造の作成 | プレビュー or 本番 | `TSAM AI/名刺データ/` とスプレッドシートが作られる。30秒以内（§13.1） |
| 10 | 保存構造の再発見 | プレビュー or 本番 | 2回目の起動で重複作成されない |
| 11 | Drive OCR の疎通 | プレビュー or 本番 | テキストが返り、一時ドキュメントが残らない |
| 12 | **OCR精度** | 本番相当 | 主要5項目の正解率85%以上、メール正規化一致率95%以上（§16.2） |
| 13 | 1件あたりの所要時間 | 本番相当 | 中央値45秒以内、95パーセンタイル90秒以内（§13.1） |
| 14 | 無料枠のレート上限挙動 | ローカル | 429 で AI-002 の案内に落ち、画面が壊れない |
| 15 | CSP 適用可否 | プレビュー | GIS を読み込んだ状態で CSP を付けて動作する、または「適用しない」と判断する |
| 16 | クォータ上限 | ダッシュボード | 想定利用者数に対する結論が出る |

**フェーズ0の完了条件**: 1〜11 と 14 が合格し、12・13・15・16 について
「合格」または「MVPでの対応方針が決まった」状態になること。

---

## §6 未解決の論点・確認したいこと

自律作業中に判断できなかった点をここへ集約する。**上から重要度順。**

### 6-1. OAuth同意画面の現在の公開ステータス（要確認）

コードからは判定できない。card-scanner の README は「OAuth 同意画面: 変更不要」
としているが、これは「スコープを増やさないので再設定が要らない」という意味で、
公開ステータスが「本番」であることを示していない。

**「テスト」のままでもフェーズ0は進められる**（テストユーザーに自分を入れる）。
判定は §4-2 A で行う。

### 6-2. OAuthクライアントを分けるか（方針判断）

§4-1 のとおり、既存IDを流用することは技術的に可能だが、要件定義書 §13.4 の
「開発用・本番用を分離する」と衝突する。**新規作成を推奨**するが、
運用の手間が増えるため事業者判断としたい。

### 6-3. 検証場所（プレビュー / 本番）

§2-3 で**プレビューURL方式を推奨**した。本番へ検証ページを置く方式（§3）も
手順は用意したが、`main` へのマージが必要で、これは人の操作になる。

### 6-4. 保存フォルダ名の確定

要件定義書 §20 で「TSAM AI / 名刺データ / 名刺管理（仮）」のままである。
card-scanner は `TSAM AI/名刺スキャナ/` を使っており、**同じ `TSAM AI` 直下に
2つのアプリのフォルダが並ぶ**ことになる。これでよいかの確認。

### 6-5. 評価用サンプル名刺の取り扱い

50枚は第三者の個人情報である。検証後に破棄するのか、業務データとして
残すのかを、集める前に決める必要がある（要件定義書 §14.5）。

### 6-6. `card-parser.js` の複製範囲

884行あり、そのまま複製すると本番側の保守対象が増える。フェーズ0では
Gemini の精度を見てから、正規表現抽出をどこまで残すか決めたい。
**フェーズ0では複製せず、Gemini 単独の精度を先に測ることを提案する。**

---

## 付録: この計画で変更した想定

要件定義書 §18 フェーズ0の項目のうち、**2項目は「実証済み」として
再検証を省く**ことを提案している（§1-1）。省く根拠は card-scanner の
実装であり、コードの該当箇所を上に示した。

この判断に異議がある場合は、§1-1 の根拠を確認したうえで差し戻してほしい。
