# 音声文字起こしアプリ 要件定義書

## 1. 文書情報

| 項目 | 内容 |
| --- | --- |
| システム名 | 音声文字起こしアプリ（アプリID `audio-transcriber`） |
| 文書種別 | 要件定義書 |
| バージョン | 1.1 |
| 作成日 | 2026年8月11日 |
| 改訂日 | 2026年8月11日 |
| 開発方式 | tsam-ai.com 配信の静的フロントエンドのみ（サーバーコードなし） |
| 実装 | `public/production-app/audio-transcriber/`（**実装済み**。テスト環境 `public/apps/audio-transcriber/` からの複製・適合） |
| 想定利用者 | TSAM AI 利用ユーザー（お客様全員） |
| 単体テスト | `tests/unit/audio-transcriber.mjs` |

テスト環境版の詳細な検証記録（WASM回避策の切り分け・実アカウントでのDrive確認・
実ブラウザ確認）は `public/apps/audio-transcriber/README.md` にある。
本書は本番版の要件を定めるもので、テスト版と挙動を変えていない箇所は
そちらの記録を検証の根拠として引き継ぐ。

---

## 2. システムの目的

TSAM AI の利用者が、端末内の音声ファイルまたはブラウザ録音アプリ
（`voice-recorder`）が Google ドライブへ保存した録音を、
**自分の端末内で、または自分の Gemini APIキーで**文字起こしできるようにする。

重点は次の順とする。

1. **音声・APIキー・トークンを利用者の管理下から出さない。**
   端末内モードでは音声を外部へ送信しない。Gemini モードでも
   当社サーバーはどこにも登場しない。
2. ブラウザ録音アプリの録音を、追加の権限なしに（`drive.file` のまま）
   そのまま文字起こしの入力にできる。
3. 結果はその場で編集でき、コピー・TXTダウンロード・Drive保存ができる。

---

## 3. 背景と課題

- ブラウザ録音アプリにより、録音（MP3）は利用者の
  「マイドライブ ＞ TSAM AI ＞ Voice Recorder」に貯まる。
  次の課題は「録音の文字化」である。
- 外部の文字起こしサービスへ音声を渡すと、内容（会議・商談）が
  第三者のサーバーを経由する。端末内で完結する選択肢を既定にする。
- サーバーで変換・文字起こしを行う方式は、長時間音声（90分・約86MB）の
  受信と処理が静的構成のホスティングでは成立しない
  （ブラウザ録音アプリが v1.2 でブラウザ完結へ改めたのと同じ判断）。

---

## 4. システム概要

### 4.1 全体構成

```
利用者のブラウザ（audio-transcriber アプリ。静的配信）
  │
  ├─ 入力① 端末のファイル選択（外部通信なし）
  ├─ 入力② Google Drive（drive.file。Voice Recorder フォルダ限定）
  │
  ├─ モードA 端末内Whisper（Transformers.js / Web Worker）
  │     通信はモデルの取得のみ（jsDelivr / Hugging Face）
  │
  ├─ モードB Gemini API（利用者自身のAPIキー。REST直・SDKなし）
  │     Files API へアップロード → generateContent → アップロードを削除
  │
  └─ 出力: 画面で編集 / コピー / TXTダウンロード /
           Drive「TSAM AI ＞ Audio Transcriber」へTXT保存
```

当社サーバーはどこにも登場しない。通信先は CSP（§11）で固定する。

### 4.2 2つの文字起こしモード

| | 完全無料・端末内処理（既定） | Gemini API |
| --- | --- | --- |
| 音声の送信先 | **送信しない**（端末内で完結） | Google の Gemini API |
| APIキー | 不要 | 利用者自身のキーが必要 |
| 初回の待ち時間 | AIモデルのダウンロード（数十MB〜） | なし |
| 精度 | モデル依存。会議録音などは苦手 | 一般に高い |
| 話者分離 | なし | モデルの能力の範囲で期待できる |

端末内モードは Transformers.js（`@huggingface/transformers` **4.2.0 固定**）の
Whisper（tiny / base / small、q8 量子化、既定 base）を Web Worker で実行する。
WebGPU が使えれば WebGPU、駄目なら WASM へ自動で落とす。技術上の必須事項:

- **WASM 時は `graphOptimizationLevel: 'basic'` を渡す。** これが無いと
  同梱 ONNX Runtime の不具合でモデル読み込みが必ず失敗する
  （切り分けの記録はテスト版 README）。ライブラリ更新時に再確認すること。
- **WebGPU で失敗したら Worker ごと作り直して WASM で再挑戦する。**
  同じ Worker 内でバックエンドを変えても効かない（実測）。

Gemini モードは公式 REST を直接呼ぶ（SDKなし・依存追加なし）。モデルは
`models.list` の結果から自動選択し、取れなければ候補（Flash 系）を順に試す。

### 4.3 使用サービス

| サービス | 用途 | 備考 |
| --- | --- | --- |
| Google Identity Services | OAuth 認可（トークンモデル） | 「Google Driveから選択」押下時のみ |
| Drive API | 録音の一覧・取得、結果TXTの保存 | `drive.file` のみ |
| jsDelivr / Hugging Face | Transformers.js 本体と Whisper モデルの取得 | 端末内モードのみ。音声は送らない |
| Gemini API | 文字起こし（Files API / generateContent） | Gemini モードのみ。利用者自身のキー |

---

## 5. 対象ユーザーとアクセス制御

- TSAM AI のログインユーザー。起動時に共通実装の `guardPage()` を通し、
  利用者が返るまで `main` を描画しない（voice-recorder / receipt-ocr と同じ）。
  `setScreenDepth(2)` を最初に宣言する。
- 静的配信のため HTML / JS の取得自体は防げない（SECURITY_NOTES.md）。
  Drive のデータを守るのは OAuth であって画面ガードではない。
- Google 連携（Drive）は「Google Driveから選択」または「Googleドライブへ保存」を
  押した時だけ求める。ページを開いただけでは認可を要求しない。

---

## 6. 前提条件

1. Drive 連携を使う場合、利用者がブラウザ録音アプリで録音を保存済みで、
   「マイドライブ ＞ TSAM AI ＞ Voice Recorder」が存在すること。
   **無い場合、本アプリはフォルダを作らず**「先にブラウザ録音アプリで保存」と
   案内する（作ると録音アプリが使うのとは別の空フォルダが増えるだけ）。
2. Gemini モードを使う場合、利用者が Google AI Studio で発行した自分の
   APIキーを、**ポータルの「API設定」で登録済み**であること（KeyStore。§10）。
   本アプリにキーの入力欄は無い。
3. **Google Cloud 側の確認（公開前・コードには現れない）:** §13 を参照。
4. デプロイは手動（`npm run deploy`）。`main` へのマージでは公開されない。

---

## 7. スコープ

### 7.1 含める機能

- 端末からの音声選択（MP3 / WAV / M4A / AAC / OGG / WebM / FLAC。
  2段階検証: `<audio>` メタデータ → `decodeAudioData`）
- Drive の Voice Recorder フォルダからの音声選択（一覧・取得）
- 端末内Whisper文字起こし（モデル選択・言語選択・タイムスタンプ・
  5分区間ごとの分割処理・進捗表示・中止）
- Gemini API 文字起こし（モデル自動選択・アップロード後の削除）
- 結果の編集・コピー・TXTダウンロード・Drive保存・話者名の一括置換

### 7.2 含めない機能（現時点の判断）

| 機能 | 含めない理由 |
| --- | --- |
| Google Picker（ドライブ全体からの選択） | 固定フォルダで足りる。テスト版の drive-picker.js は未使用のため本番へ複製していない。使うなら CSP の追加が要る |
| アプリ内でのキー入力・登録UI | キーの登録・変更・削除はポータル「API設定」（KeyStore）に一本化する（§10）。本アプリは有無の表示と導線だけを持つ |
| 話者分離（端末内モード） | Whisper 単体では不可。Gemini モードで代替 |
| リアルタイム文字起こし | 録音済みファイルの変換で足りる。録音はブラウザ録音アプリが担当 |
| サーバー側での変換・キュー | 「当社サーバーへ送信ゼロ」の原則が崩れる（§12） |

---

## 8. 業務フロー（利用者の操作）

1. Portal からアプリを開く（ログイン必須）。
2. 音声を選ぶ。「端末から選択」または「Google Driveから選択」
   （後者は初回に Google の認可ポップアップが出る）。
3. モードを選ぶ（既定は端末内処理）。Gemini モードでキーが未登録なら
   案内が出るので、ポータルの「API設定」で登録して戻る（§10）。
4. 「文字起こしを開始」。進捗が表示され、「中止する」で止められる。
5. 結果を編集し、コピー / TXTダウンロード / Drive保存を行う。
   Drive保存先は「マイドライブ ＞ TSAM AI ＞ Audio Transcriber」
   （**初回保存時に自動作成**。ファイル名は `<元の音声名>.txt`）。

---

## 9. 機能要件

### FR-01 画面ガード

`guardPage({ next: 'portal' })` を通るまで内容を描画しない。

### FR-02 Google連携

- スコープは `drive.file` の1つのみ。**増やさない。**
  drive / drive.readonly を足すと利用者のドライブ全体が見える状態になる。
- **クライアントIDはブラウザ録音アプリと同一**（受領書スキャナとも共通）。
  `drive.file` で見えるのは「同じOAuthクライアントのアプリが作成した
  ファイル」だけなので、同一IDでないと録音が見えない。
  **同一性は単体テストで突き合わせる**（`tests/unit/audio-transcriber.mjs`）。
- トークンはメモリ上のみ。localStorage / sessionStorage / Cookie / URL /
  console へ出さない。ページを離れれば消える。

### FR-03 フォルダの特定（読み取り元は作らない・保存先は作る）

- フォルダIDをコードに書かない。毎回「名前と親の関係」で
  `'root' in parents` から1階層ずつ解決する。
  **名前だけで Drive 全体を検索するクエリを発行しない**（全クエリに
  `in parents` が入ることを単体テストで固定する）。
- フォルダ名は `config.js` の `DRIVE_NAMES` に定義する。root と
  Voice Recorder は録音アプリ側 `voice-recorder/config.js` にも同名定義が
  あり、**片方だけ変えないこと**（一致を単体テストで検知する）。
- 読み取り元（Voice Recorder）は**見つからなくても作らない**。
  保存先（Audio Transcriber）は初回TXT保存時に作成する。
- 同名フォルダが複数あるときは最初の1件を勝手に使わず、作成・更新日時を
  添えて利用者に選ばせる。
- 解決したフォルダIDはメモリ上のみに置き、再読み込みで解決し直す。

### FR-04 音声の取得と検証

- 取得元は「端末」と「Voice Recorder フォルダ直下」の2つだけ。
- Drive の一覧は更新日時の新しい順。MIME が空・octet-stream の場合は
  拡張子でも音声判定する。音声以外は一覧に出さない。
- 選んだファイルは必ず Blob として取得し、以降は端末選択と同じ経路を通る
  （Drive の URL を Gemini へ渡さない。Google 側に読む権限が無い）。
- 401 は「利用許可の期限切れ」、403 は「アカウント・権限の確認」を促す
  専用文言で出し分ける（単なる「失敗しました」にしない）。

### FR-05 端末内文字起こし

- 音声は 16kHz モノラルへ変換し、`segmentSeconds`（5分）ごとに区切って
  Web Worker で順に処理・連結する。§4.2 の WASM 回避策と
  Worker 再作成を必須とする。
- 中止（AbortController）で処理を止められ、中止後に再実行できる。

### FR-06 Gemini 文字起こし

- APIキーは `x-goog-api-key` ヘッダーで送る（クエリ文字列に入れない）。
- アップロードしたファイルは成功・失敗・中断のいずれでも削除する。
- API のエラーメッセージを画面へそのまま出さない（プロジェクト情報が
  混じることがある）。HTTPステータスとエラーコードから日本語文言へ変換する。
- 429 は「無料枠または利用上限を超えました」とし、勝手に課金へ誘導しない。

### FR-07 結果の書き出し

- TXT は UTF-8・BOM無し。ファイル名は元の音声名の拡張子を `.txt` へ
  差し替え、パス区切りとOSで使えない文字を落とす。
- 話者名の置換は行頭（またはタイムスタンプ直後）の「話者n：」だけを対象にし、
  本文中の同じ語は変えない。

### FR-08 制限値

| 項目 | 端末内モード | Gemini モード |
| --- | --- | --- |
| ファイルサイズ | 512 MB | 200 MB |
| 音声の長さ | 4 時間 | 2 時間 |

上限は `config.js` の `LIMITS` で管理する（単体テストで固定）。

---

## 10. APIキーの扱い（利用者の Gemini キー）— KeyStore 方式

キーは **KeyStore**（`public/auth/keystore.js`。docs/specs/keystore-spec-v1.md）で
管理する。本アプリにキーの入力欄は無く、登録・変更・削除はポータルの
「API設定」で行う（short-script / receipt-ocr と同じ流儀）。

- 画面が見るのは **有無だけ**（`isKeyStoreAvailable()` / `KeyStore.has()`）。
  Gemini モード選択時に3状態で出し分ける:
  ① localStorage 不可（プライベートモード等）→ その旨の案内、
  ② 未登録 → ポータル「API設定」への導線を出し実行ボタンを無効化、
  ③ 登録済み → 実行可能。ポータルの別タブで設定して戻る場合に備え、
  visibilitychange / focus で有無を読み直す。
- **値を読むのは実行直前の `KeyStore.get(PROVIDERS.gemini)` の1回だけ。**
  モジュール変数・DOM・state・console へ保持しない。
  `gemini-transcriber.js` も引数で受け取るだけで、内部に保持しない。
- KeyStore の外で localStorage を触らない（keystore-spec-v1.md §2-1）。
  当社サーバー（GAS）へ送らない（同 §2）。
- 送信は `x-goog-api-key` ヘッダーのみ（§FR-06）。

---

## 11. セキュリティ要件と CSP

サイト全体のCSPは無いため、`index.html` の `<meta>` による
**ページ限定**のCSPを置く。テスト版のCSPに本番の認証系接続先を合成した。

| 許可 | 理由 |
| --- | --- |
| `script-src` に `'wasm-unsafe-eval'` | ONNX Runtime の WebAssembly 実行に必須。`'unsafe-eval'` は許可しない |
| `worker-src` に `blob:` と `https://cdn.jsdelivr.net` | ONNX Runtime が内部生成する blob ワーカーに加え、**Transformers.js のバンドルURL自体を入れ子のワーカーとして起動する**（許可しないとモデル読み込みが失敗する。実ブラウザで確認） |
| `connect-src` に jsDelivr / huggingface.co / *.hf.co / cdn-lfs 系 | ライブラリとモデルの取得（リダイレクト先CDNを含む） |
| `connect-src` に `generativelanguage.googleapis.com` | Gemini API |
| `connect-src` に `www.googleapis.com` / `frame-src` `script-src` に `accounts.google.com` | Drive API と Google Identity Services |
| `connect-src` に `script.google.com` / `script.googleusercontent.com` | 当社の認証系（`guardPage()` が呼ぶ Apps Script）。無いとログイン確認が失敗する |

その他の対策:

| 脅威 | 対策 |
| --- | --- |
| トークンの漏えい | メモリ上のみ保持（§FR-02） |
| APIキーの漏えい | KeyStore（端末内 localStorage）のみ。値を読むのは実行直前の1回だけで、画面・ログ・当社サーバーへ出さない（§10） |
| ドライブの過剰読み取り | `drive.file` のみ。クエリは常に `in parents` 付き |
| XSS（外部由来の文字列） | ファイル名・Drive表示名・API応答はすべて `textContent` で扱う。innerHTML を使わない |
| 機密の混入したエラー表示 | 例外の message を画面へ出さず、コードから日本語文言へ変換する |

---

## 12. 採用しなかった案とその理由

- **テスト環境（`public/apps/`）からの import**: 本番アプリからテスト環境を
  参照しない境界（docs/repository-structure.md §1）に反する。複製で適合した。
  フォルダ名・クライアントIDの「複製ゆえのずれ」は単体テストの突き合わせで防ぐ。
- **サーバー側での文字起こし・変換**: 長時間音声の受信と処理が静的構成で
  成立しない。当社サーバーが音声内容を預かることにもなる。
- **Google Picker**: 固定フォルダ方式で足り、Picker は CSP の追加許可
  （apis.google.com / docs.google.com）とブラウザキーが要る。テスト版で
  検討済みの残置コードも本番へは複製しない（§7.2）。
- **スコープ拡大（drive.readonly 等）による「見えない録音」対策**:
  手動アップロードや別アカウントの音声が見えないのは `drive.file` の仕様。
  スコープを広げず、「端末から選択」への誘導で対応する。
- **Voice Recorder フォルダの自動作成**: 録音アプリが使うのとは別の
  空フォルダを増やすだけで、利用者を混乱させる。
- **whisper-small の既定化**: 量子化しても 200MB 超で、スマートフォンの
  初回ダウンロードが現実的でない。base を既定にし画面で切り替える。
- **APIキー形式の正規表現検証**: Google のキー形式は移行中
  （2026年9月の Authorization Key 化）。決め打ちすると新形式を弾く。
  形式の警告と疎通テストはポータル側の責務（keystore-spec-v1.md §4-2）。
- **画面でのキー都度入力（テスト版の方式）**: 本番の正は KeyStore
  （keystore-spec-v1.md）。都度入力は毎回39文字の貼り付けを強いるうえ、
  キーの扱いがアプリごとにばらつく。本番アプリ間で管理の入口を
  ポータル「API設定」の1つに揃えるため、v1.1 で KeyStore 方式へ変更した。

---

## 13. 公開前に必要な Google Cloud 側の確認事項

コードには現れない、人手の作業・確認。

1. **Google Drive API が有効**であること（プロジェクトは録音アプリと同じ。
   テスト版で有効化・動作確認済み）。
2. OAuth クライアント（録音アプリと共通のID）の
   **承認済みの JavaScript 生成元**に本番オリジン（`https://tsam-ai.com`）が
   入っていること。ローカル確認には `http://localhost:8000` が要る
   （`127.0.0.1` は別オリジン扱い）。
3. OAuth 同意画面が「テスト」状態なら、利用者を追加するか本番公開へ
   切り替えること（テスト状態のままだと登録外アカウントは認可できない）。
4. 本番URLで「Google Driveから選択」を押し、認可が通ること・
   録音アプリの録音が一覧に出ることを実アカウントで確認すること
   （テスト版はローカルオリジンでのみ確認済み）。
5. Gemini モードの実APIキーでの通信確認（テスト版から未確認のまま。
   確認できたら画面の「実環境によって利用できない場合があります」の
   注記を外す）。

Picker を使わないため、Picker API のブラウザキーは不要。

---

## 14. 用語集

| 用語 | 意味 |
| --- | --- |
| drive.file | 「そのクライアントIDのアプリが作ったファイルだけ」に絞ったドライブ権限。録音を読める根拠（§FR-02） |
| トークンモデル | リフレッシュトークンを持たず、短命のアクセストークンだけで動くOAuthの形。静的サイト向け |
| Transformers.js | ブラウザ内で機械学習モデルを動かすライブラリ。Whisper の実行に使う（4.2.0 固定） |
| WASM回避策 | Transformers.js 4.2.0 同梱の ONNX Runtime の不具合を避けるための `graphOptimizationLevel: 'basic'` 指定（§4.2） |
| Voice Recorder / Audio Transcriber | 利用者のドライブ「TSAM AI」直下のフォルダ名。前者は録音の読み取り元（作らない）、後者はTXTの保存先（初回保存時に作成） |

---

## 15. 変更履歴

| 版 | 日付 | 内容 |
| --- | --- | --- |
| 1.0 | 2026-08-11 | 初版。テスト環境 `public/apps/audio-transcriber/` からの本番複製・適合（自前OAuth・guardPage・CSP合成・Portal掲載）に合わせて起こした |
| 1.1 | 2026-08-11 | Gemini APIキーをテスト版の都度入力方式から KeyStore 方式へ変更（本番の正 docs/specs/keystore-spec-v1.md への適合。§6・§7.2・§8・§10・§11・§12） |
