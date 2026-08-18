# 音声文字起こしアプリ 詳細設計書 v1.0

| 項目 | 内容 |
| --- | --- |
| アプリID | `audio-transcriber` |
| 実装 | `public/production-app/audio-transcriber/` |
| 上位文書 | [../specs/audio-transcriber-requirements-v1.md](../specs/audio-transcriber-requirements-v1.md)（本文の版は 1.3） |
| テスト | `tests/unit/audio-transcriber.mjs`（`node tests/run.mjs audio-transcriber`） |
| 規模 | 約6,600行 |
| 作成日 | 2026年8月18日 |

**このアプリだけ「処理系を2つ持つ」。** 端末内 Whisper（外へ音声を出さない）と
Gemini（利用者自身のキーで送る）を、利用者が選ぶ。
設計上の分岐はほぼすべてこの二択に由来する。

---

## §1 責務と境界

### 1-1. 引き受けること

- 端末のファイル、または Drive の「TSAM AI ＞ Voice Recorder」から音声を受け取る
- **モードA**: 端末内 Whisper（Transformers.js）で文字起こしする。音声は外部へ出ない
- **モードB**: 利用者の Gemini APIキー（KeyStore 経由）で文字起こしする
- 結果を整形し、コピー・TXT ダウンロード・話者名の置換を行う
- AI議事録アプリ（`meeting-minutes`）へ引き継ぐ

### 1-2. 引き受けないこと

- **録音。** `voice-recorder` の担当
- **議事録への整形。** `meeting-minutes` の担当
- **APIキーの保管。** KeyStore（[../specs/keystore-spec-v1.md](../specs/keystore-spec-v1.md)）
- **当社サーバーでの処理。** 音声も文字起こし結果も当社へ送らない

### 1-3. 隣との関係

| 相手 | 関係 |
| --- | --- |
| `voice-recorder` | **同じ OAuth クライアントID**を使い、同じフォルダ名を読む。だから `drive.file` のままで一覧・取得できる（§5-2）。フォルダ名を変えるなら両方同時 |
| `meeting-minutes` | `sessionStorage` のキー `tsam-meeting-minutes-handoff-v1` で引き継ぐ（§5-4） |
| KeyStore | Gemini キーの唯一の置き場所。`settings-store.js` は**触らない** |
| `public/apps/audio-transcriber/` | 複製元（テスト環境）。import しない |

---

## §2 モジュール構成

| ファイル | 責務 | 行数 | 備考 |
| --- | --- | --- | --- |
| `config.js` | 静的設定（上限・モデル候補・プロンプト・Drive） | 337 | 唯一の設定源 |
| `state.js` | 画面状態の純粋な状態機械 | 119 | DOM・fetch・文言を置かない |
| `audio-loader.js` | 読み込み・検証・PCM 化・区間分割 | 295 | 取得元によらず**必ずここを通す** |
| `whisper-transcriber.js` | 端末内モードの窓口（UIスレッド側） | 322 | Worker との通信・分割・連結・中止 |
| `whisper-worker.js` | Transformers.js を動かす Worker | 275 | CDN から動的 import |
| `gemini-transcriber.js` | Gemini（Files API ＋ generateContent） | 653 | キーは引数のみ |
| `drive-client.js` | Drive API v3 | 562 | 認可は持たない |
| `oauth.js` | GIS とトークン取得 | 266 | `DriveAuthError` で返す |
| `result-exporter.js` | 整形・コピー・ダウンロード | 167 | 純粋関数中心 |
| `settings-store.js` | 選択設定の永続化 | 86 | **秘密情報を置かない** |
| `minutes-handoff.js` | 議事録アプリへの引き継ぎ | 128 | 書くだけ。期限は判定しない |
| `script.js` | 画面 | 1,964 | 判断と文言はここ |

### 2-1. 分け方の原則

`state.js` に**「ボタンを押せるか」の判断表（`CAN`）**を持たせ、
その判断を外へ散らさない、と明示されている。
状態が増えたら表を必ず更新する、という運用がコメントで宣言されている。

各ロジック層は「DOM・文言を置かない」「返すのはコードと数値だけ」で統一されている。
文言への変換は `script.js` が一手に引き受ける。

---

## §3 状態とデータ構造

### 3-1. 画面状態（`state.js`）

`idle` → `file-selected` → （`loading-model` ／ `uploading`）→ `transcribing`
→ `completed` ／ `cancelled` ／ `error`

- **`BUSY_STATES`**（`loading-model` `uploading` `transcribing`）に居る間は
  新しいファイルを受け付けない
- 更新は `update(patch)` / `transition(next, patch)`、購読は `subscribe()`

### 3-2. 永続化するもの

| 場所 | キー | 内容 |
| --- | --- | --- |
| `localStorage` | `tsam-audio-transcriber-settings-v1` | 文字起こしの方法・言語・タイムスタンプ有無・Whisper モデル・Gemini モデル |
| `sessionStorage` | `tsam-meeting-minutes-handoff-v1` | 議事録アプリへの引き継ぎ（§5-4） |

**`settings-store.js` に置いてはならないもの**が明記されている。
Gemini APIキー（唯一の置き場所は KeyStore）と、音声ファイル本体（Blob・ファイル名）。

保存できない環境（プライベートモード等）では**画面を止めない。**
読めない・書けない・壊れた値は、すべて「何も保存されていない」として扱う。

### 3-3. メモリだけに置くもの

- Drive のアクセストークン（`oauth.js` のクロージャ）
- Gemini APIキー（使用時に KeyStore から読み、引数として渡すだけ）
- デコード済み PCM（区間ごと）

---

## §4 主要フロー

### 4-1. ファイル受け入れ（`acceptFile()` → `audio-loader.js`）

**「対応形式か」を2段階で判定する。**

```
1. 選択時 … <audio> に Blob URL を読ませ、メタデータが取れるかで判定（probeAudio）
             ブラウザが実際にコンテナとコーデックを解釈した結果なので、
             拡張子の詐称では通らない。長さもここで得る
2. 文字起こし時 … decodeAudioData で全体を PCM へ展開（decodeToPcm）
```

拡張子と MIME は自己申告で当てにならず、かといって選択のたびに全体を PCM へ展開すると
長時間音声でメモリが尽きる。**1で弾ければ、重い2に入る前に分かりやすいエラーを出せる。**

上限は `config.js` の `LIMITS`。

| モード | サイズ | 長さ | 根拠 |
| --- | --- | --- | --- |
| 端末内 | 512MB | 4時間 | デコード後 PCM が「秒数 × 16000 × 4バイト」載る。**長さでも止める** |
| Gemini | 200MB | 2時間 | Files API は 2GB まで許すが、ブラウザからの単発アップロードとして大きすぎる。無料枠の消費も抑える |

### 4-2. モードA（端末内 Whisper）

```
decodeToPcm → splitPcm（区間分割）→ Worker へ順に渡す → 結果を連結
```

- Worker は Transformers.js を**CDN から動的 import** する（§5-1）
- **WebGPU で初期化に失敗したら、Worker を作り直して WASM で再挑戦する。**
  `WEBGPU_FAILED` は内部専用のコードで、利用者には見せない
- 通信が発生するのはモデルとライブラリの取得だけ。**音声は外部へ一切送らない**

### 4-3. モードB（Gemini）

```
1. normalizeApiKey()
2. listUsableModels()      … 利用者のキーで models.list を呼び、実際に使えるモデルを確認
   resolveModelOrder()     … 取れなければ config.js の配列順に総当たり
3. uploadAudio()           … Files API へアップロード
4. waitUntilActive()       … 2秒間隔・最大10分待つ
5. generateTranscript()    … generateContent
6. deleteUploadedFile()    … 後始末
```

**モデルを決め打ちにしない**のがこのフローの要点。
候補は `gemini-3.6-flash` → `3.5-flash` → `2.5-flash` の順で、404 / 400（未対応）なら次へ落とす。

### 4-4. Drive から読む

```
resolveVoiceRecorderFolder() … 'TSAM AI' → 'Voice Recorder' を名前で解決
listVoiceRecorderAudio()     … 音声ファイルだけ抽出（isAudioFile）
loadVoiceRecorderAudio()     … 実体を取得
```

見つからない場合は候補フォルダを提示して選ばせる（`renderFolderCandidates`）。
ページ送りは `listPageSize: 100`・`maxListPages: 10` で頭打ち（暴走の歯止め）。

### 4-5. 議事録への引き継ぎ（`minutes-handoff.js`）

`sessionStorage` に `{ version: 1, transcript, metadata, createdAt }` を書く。

- **URL のクエリ・ハッシュへ本文を載せない**（受け側の要件 §5-1）
- **`localStorage` へ恒久保存しない**
- **有効期限（30分）の判定は受け側が行う。** このファイルは書くだけ

---

## §5 外部インターフェース

### 5-1. Transformers.js / Hugging Face（モードA）

| 項目 | 値 |
| --- | --- |
| ライブラリ | `@huggingface/transformers` **4.2.0 固定**（jsDelivr。`latest` を指さない） |
| モデル | `onnx-community/whisper-tiny` / `-base`（既定）/ `-small` |
| 量子化 | q8（onnx-community の Whisper に必ず用意がある。fp32 は大きく速度も出ない） |

`whisper-small` は精度が高いが量子化しても 200MB 超で、スマートフォンでは初回
ダウンロードが現実的でない。そのため既定は `whisper-base`。
`*.en` 系は英語専用なので候補に入れない。

CSP は `script-src` / `worker-src` / `child-src` に `blob:` と jsDelivr、
`connect-src` に jsDelivr・`huggingface.co`・`*.hf.co`・`cdn-lfs` 系を要する。
**`worker-src` に jsDelivr が要るのは、Transformers.js のバンドル URL 自体を
入れ子のワーカーとして起動するため**（実ブラウザで確認済み。上位文書 §）。

### 5-2. Google Drive

スコープは `drive.file` のみ。このスコープで見えるのは
**A. 同じ OAuth クライアントのアプリが作成したファイル**と
**B. 利用者が Picker で明示的に選んだファイル**の2種類。

このアプリが読むのは A である。`voice-recorder` が**同じクライアントID**で
保存しているため、`drive.file` のままで一覧・取得できる。
**Picker は使わない**（テスト版に残っていた `drive-picker.js` は本番へ複製していない）。

### 5-3. Gemini

`generativelanguage.googleapis.com` の `v1beta`。Files API と `generateContent`。

**SDK（`@google/genai`）ではなく REST を直接使う。** このアプリは npm ビルドを持たない
素の ES Modules で構成されており、SDK を入れるにはバンドラの導入が要る（既存構成を壊す）。

文字起こしの指示文（`TRANSCRIPTION_PROMPT`）は、要約させないこと・
聞き取れない箇所を `[聞き取り不能]` と明示させること・言い直しやフィラーを
過度に削除させないこと・話者を区別することを求める。

### 5-4. 議事録アプリ

`sessionStorage` キー `tsam-meeting-minutes-handoff-v1`、メジャーバージョン 1。

---

## §6 エラー設計

**層ごとに独立したエラー型を持ち、`script.js` が文言へ変換する。**

| 層 | 型 |
| --- | --- |
| `audio-loader.js` | `AudioError` / `AudioErrorCode` |
| `whisper-transcriber.js` | `WhisperError` / `WhisperErrorCode`（`WORKER_FAILED` `WEBGPU_FAILED` `MODEL_LOAD_FAILED` `MODEL_RUN_FAILED` `OUT_OF_MEMORY` `CANCELLED` `UNKNOWN`） |
| `gemini-transcriber.js` | `GeminiError` / `GeminiErrorCode` |
| `drive-client.js` | `DriveError` / `DriveErrorCode` |
| `oauth.js` | `DriveAuthError`（`POPUP_CLOSED` `POPUP_BLOCKED` `ACCESS_DENIED` `SCOPE_NOT_GRANTED`） |

### 6-1. Gemini の応答をそのまま見せない

`gemini-transcriber.js` の冒頭が明示している。**応答本文にキーやプロジェクト情報が
混じることがある**ため、エラーメッセージを利用者へそのまま出さない。
外へ渡すのはコードだけ。

これは投稿系アプリ（`threads-post` など）が「`detail` を必ず表示する」としているのと
**方針が逆**である。用途が違う（あちらはテキスト生成、こちらは音声アップロードを含む）。
移植時に取り違えないこと。

### 6-2. WebGPU の失敗は利用者に見せない

内部で WASM へ切り替えて再挑戦するため、失敗として扱わない（§4-2）。

---

## §7 移植（他プロダクトへの組み込み）

### 7-1. 移植単位

| 単位 | ファイル | 依存 | 単独で持ち出せるか |
| --- | --- | --- | --- |
| **端末内文字起こし** | `whisper-transcriber.js` ＋ `whisper-worker.js` ＋ `audio-loader.js` ＋ `config.js` の `WHISPER` `LIMITS` | CDN（jsDelivr / Hugging Face） | **可**。外部へ音声を出さない文字起こしが要る場面ではそのまま使える |
| 音声の検証・PCM 化 | `audio-loader.js` | `config.js` の2定数 | 可。2段階判定（§4-1）は他の音声アプリでも有効 |
| Gemini 音声文字起こし | `gemini-transcriber.js` | なし（キーは引数） | 可 |
| Drive 読み取り | `drive-client.js` ＋ `oauth.js` | `config.js` | 可（同一クライアントIDで作られたファイルに限る） |
| 状態機械 | `state.js` | なし | 可（`CAN` 表を作り直す） |
| 書き出し | `result-exporter.js` | なし | 可 |

### 7-2. 置換点

1. **`config.js` 全体。** `OAUTH.clientId`（**`voice-recorder` と同一にする必要があるか**を
   移植先で判断する。同一でないと相手のファイルが見えない）、`DRIVE_NAMES`、
   `LIMITS`、`WHISPER.libraryUrl`（**バージョンを固定したまま**）、`GEMINI.models`、
   `TRANSCRIPTION_PROMPT`
2. **CSP。** §5-1 の5つのディレクティブすべて。1つでも欠けるとモデル読み込みが失敗する
3. **CDN 依存の是非。** 移植先が外部 CDN を禁じるなら、Transformers.js とモデルを
   自ホストする必要がある。**その場合 `worker-src` と `connect-src` の設計をやり直す**
4. **`public/auth/` への依存**（`guardPage()` ／ KeyStore）
5. **`sessionStorage` の引き継ぎキー。** 受け側が無いなら丸ごと落とす
6. **`settings-store.js` のキー**（`-v1` の版番号込み）

### 7-3. 前提

- セキュアコンテキスト
- **WebGPU があれば速いが、無くても WASM で動く**（自動で落ちる）
- 端末内モードはメモリを大量に使う。4時間・512MB の上限は
  「秒数 × 16000 × 4バイト」の見積もりから来ている
- Gemini モードは利用者がキーを持っていること（BYOK）

### 7-4. 持ち出してはいけないもの

- **Gemini の応答本文を画面へ出す改変**（§6-1）
- `settings-store.js` にキーを保存する改変
- 引き継ぎ本文を URL に載せる改変（受け側要件 §5-1 違反）

---

## §8 テスト設計

スイート: `tests/unit/audio-transcriber.mjs`。

`script.js`（DOM）はテストしない。テスト対象は
`state.js`（遷移と `CAN` 表）、`audio-loader.js`（拡張子判定・分割）、
`gemini-transcriber.js`（モデル順の決定・エラー写像・コードフェンス剥がし）、
`drive-client.js`（クエリ組み立て・HTTP エラー写像）、
`result-exporter.js`（ファイル名・整形・話者置換）、
`minutes-handoff.js`（`storage` と `now` を引数で受け取り、DOM を参照しない設計）。

差し替え口は `fetchImpl` / `token` / `signal` / `storage` / `now`。

実モデルの実行・実 API 呼び出しはテストしない。

---

## §9 設定値と環境依存

`config.js`。主なもの。

| 定数 | 意味 |
| --- | --- |
| `SCREEN_DEPTH` | 2 |
| `OAUTH` | クライアントID（公開値）とスコープ `drive.file` |
| `DRIVE_NAMES` | `voice-recorder` と共有する保存先フォルダ名 |
| `AUDIO_EXTENSIONS` / `AUDIO_MIME_TYPES` / `FILE_ACCEPT` | 受け入れ形式 |
| `LIMITS` | モード別のサイズ・長さ上限（§4-1） |
| `WHISPER` | ライブラリ URL（4.2.0 固定）・モデル候補・量子化 |
| `LANGUAGES` / `DEFAULT_LANGUAGE` | 既定は `ja` |
| `GEMINI` | API ベース・モデル候補・`defaultModelId: 'auto'`・ポーリング間隔（2秒）と上限（10分） |
| `TRANSCRIPTION_PROMPT` | 文字起こしの指示文 |
| `DRIVE` | `listPageSize: 100` / `maxListPages: 10` |

**APIキーの取得先 URL を持たない。** 本番のキーは KeyStore で管理し、
取得手順の案内はポータル側が持つ。

---

## §10 既知の制約・未解決

1. **CDN 依存が外部依存の承認記録に載っていない。**
   Transformers.js（jsDelivr）と Hugging Face は上位文書 §（外部通信の表・CSP の表）に
   記載があるが、[../external-dependency-approvals.md](../external-dependency-approvals.md)
   の承認済み表には行が無い。**実装の不具合ではなく文書間の不整合**（[findings-2026-08.md](./findings-2026-08.md) #1）
2. **モデルのダウンロード量が大きい。** `whisper-small` は量子化しても 200MB 超。
   初回はネットワークとストレージを消費する
3. **`voice-recorder` とクライアントIDを共有していることが機能の前提。**
   分けると Drive から録音が見えなくなる（`drive.file` の性質。§5-2）
4. **引き継ぎの期限判定を受け側に委ねている。** 送り側は書くだけなので、
   受け側が判定を落とすと期限切れデータを読む
5. **`script.js` が 1,964 行と大きい。** 判断と文言を集約する設計の帰結だが、
   分割の余地はある（現時点で不具合は無い）

---

## §11 設計判断の記録

| 判断 | 採らなかった案 | 理由 |
| --- | --- | --- |
| 形式判定を2段階にする | 拡張子・MIME で判定／常に全展開 | 自己申告は当てにならず、全展開は長時間音声でメモリが尽きる |
| モデルを固定しない | 1モデル決め打ち | 利用者のキーで使えるモデルが違う。`models.list` → 総当たりの二段構え |
| REST を直接叩く | `@google/genai` SDK | npm ビルドを持たない構成にバンドラを持ち込むことになる |
| WebGPU 失敗時に WASM へ自動再挑戦 | 失敗として表示する | 利用者に選ばせる意味が無い |
| 既定を `whisper-base` にする | `whisper-small` を既定にする | 精度より初回ダウンロードの現実性を採った |
| Picker を使わない | Picker で任意ファイルを選ばせる | 同一クライアントIDで作られたファイルだけを読めばよく、API キーと `pickerAppId` を増やさずに済む |
| Gemini の応答を画面へ出さない | 詳細を出して切り分けやすくする | 応答にキーやプロジェクト情報が混じりうる |
| 設定と鍵の置き場所を分ける | 1つのストアにまとめる | KeyStore の外で `localStorage` を触らない（keystore 仕様 §2-1） |

---

## §12 変更履歴

| 版 | 日付 | 内容 |
| --- | --- | --- |
| v1.0 | 2026-08-18 | 初版。実装（2026年8月時点）を記述 |
