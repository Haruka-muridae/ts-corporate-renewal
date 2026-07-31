# 音声文字起こし

端末またはGoogleドライブの音声ファイルを、端末内AIまたは Gemini API で文字起こしするアプリ。

`apps/` 配下の他アプリと同じく、ビルド不要の素の ES Modules で動く。
npm の依存は追加していない（`package.json` は変更していない）。

## 2つの文字起こしモード

| | 完全無料・端末内処理 | Gemini API |
| --- | --- | --- |
| 音声の送信先 | **送信しない**（この端末内で完結） | Google の Gemini API |
| APIキー | 不要 | 利用者自身のキーが必要 |
| 初回の待ち時間 | AIモデルのダウンロード（数十MB） | なし |
| 精度 | モデル依存。会議録音などは苦手 | 一般に高い |
| 費用 | 無料 | 無料枠の範囲内なら無料 |
| 通信 | モデルの取得のみ（Hugging Face / jsDelivr） | 音声本体を送信 |

### 端末内モード

Transformers.js（`@huggingface/transformers` **4.2.0**、バージョン固定）の
`automatic-speech-recognition` パイプラインで Whisper を実行する。

- 既定モデル: `onnx-community/whisper-base`（多言語 / q8 量子化）
- 選択可能: `onnx-community/whisper-tiny` / `onnx-community/whisper-base` / `onnx-community/whisper-small`
- モデルIDは `config.js` の `WHISPER` で一元管理する。他のファイルには書かない
- WebGPU が使えれば WebGPU、駄目なら WASM へ自動で落とす
- 推論は Web Worker（`whisper-worker.js`）で行い、画面は固まらない
- 音声は 16kHz モノラルへ変換してから渡す（`audio-loader.js`）
- 長い音声は `WHISPER.segmentSeconds`（既定 5 分）ごとに区切り、順に処理して連結する

`whisper-small` を既定にしなかったのは、量子化しても 200MB を超え、
スマートフォンでの初回ダウンロードが現実的でないため。精度が要るときは画面から切り替える。

### WASM で必要な回避策（重要）

WASM で実行するときだけ、ONNX Runtime へ
`session_options: { graphOptimizationLevel: 'basic' }` を渡している
（`config.js` の `WHISPER.wasmSessionOptions`）。

これが無いと、モデルの読み込み段階で必ず次のエラーになる。

```
Can't create a session. ERROR_CODE: 1,
qdq_actions.cc:137 TransposeDQWeightsForMatMulNBits
Missing required scale: model.decoder.embed_tokens.weight_merged_0_scale
```

実ブラウザでの切り分け結果:

| 条件 | 結果 |
| --- | --- |
| dtype を q8 / int8 / uint8 / q4 / fp32 に変更 | **すべて同じ失敗** |
| モデルを onnx-community / Xenova の tiny / base に変更 | **すべて同じ失敗** |
| WebGPU で実行 | 成功（既定設定のまま） |
| `graphOptimizationLevel: 'disabled'` | 成功（ただし 'basic' の約3倍遅い） |
| `graphOptimizationLevel: 'basic'` | **成功。これを採用** |

つまりモデルや dtype の選び方の問題ではなく、Transformers.js 4.2.0 が同梱する
ONNX Runtime のグラフ最適化の不具合である。
ライブラリを更新するときは、この回避策がまだ必要かを再確認すること。

### WebGPU から WASM への切り替え

WebGPU の可否は `navigator.gpu` の有無では判定できない。
Chrome は GPU が使えない環境でも `navigator.gpu` を残すため、
`requestAdapter()` が `null` を返して初めて分かる。Worker 側で実際に要求している。

また、**同じ Worker の中で `device` を変えて `pipeline()` を作り直しても効かない**。
ONNX Runtime が最初に解決したバックエンドを持ち続けるため、
2回目に `device: 'wasm'` を渡しても
`no available backend found. ERR: [webgpu]` で失敗する（実測）。

そのため WebGPU で失敗したときは、`whisper-transcriber.js` が
**Worker ごと作り直して** WASM で再挑戦する。
この設計を変えるときは、必ず GPU を無効にした実ブラウザで確認すること
（Chrome なら `--disable-gpu` で再現できる）。

### Gemini API モード

公式 REST を直接呼ぶ（SDK は使わない。理由は `gemini-transcriber.js` 冒頭に記載）。

```
Files API へアップロード（resumable）
  → state が ACTIVE になるまで待つ
  → models/{model}:generateContent に file_data として渡す
  → 結果を取得
  → アップロードしたファイルを削除（成功・失敗・中断のいずれでも実行）
```

モデルは `config.js` の `GEMINI.models` で管理し、既定は「自動」。
自動のときは利用者のキーで `models.list` を呼び、実際に使えるものから選ぶ。
一覧が取れない場合は候補を順に試し、`404` / 音声非対応 / サーバーエラーなら次の候補へ落とす。

2026年7月時点の候補（音声入力対応・Flash 系・無料枠あり）:
`gemini-3.6-flash` → `gemini-3.5-flash` → `gemini-2.5-flash`

## 対応ファイル形式

MP3 / WAV / M4A / AAC / OGG / WebM / FLAC

拡張子とMIMEだけでは判定せず、次の2段階で確認する。

1. 選択時 … `<audio>` にBlob URLを読ませ、メタデータが取れるかを見る（ブラウザが実際にコンテナとコーデックを解釈する）
2. 文字起こし時 … `decodeAudioData` で全体をPCMへ展開する

拡張子を偽ったファイルは1で弾かれる。1を通って2で落ちる形式（環境によっては m4a）もあり、
その場合は「MP3またはWAVへ変換してください」と案内する。

## 音声ファイルの取得元

取得元は次の2つだけで、画面上でも2つの選択肢として並べている。

| 取得元 | 対象 |
| --- | --- |
| 端末から選択 | この端末のファイル（対応形式は上記のとおり） |
| Google Driveから選択 | **マイドライブ ＞ TSAM AI ＞ Voice Recorder** の中だけ |

Drive 側は音声録音アプリ（`apps/voice-recorder/`）が保存した録音を対象にする。
**ドライブ全体は検索しない。**

## Google ドライブ連携

認可は `apps/drive-auth.js` を再利用する。**このアプリ用に認可処理を書き起こしていない**。
要求するスコープは `https://www.googleapis.com/auth/drive.file` のみ。
アクセストークンはメモリ上だけに置き、ページを再読み込みすれば消える。

Google Drive を使うには **Googleの認可が必要**。「Google Driveから選択」を押した
時だけ認可画面が出る。ページを開いただけでは認可を求めない。

### フォルダの特定方法

フォルダIDは利用者ごとに違うため、コードに固定値として書かない。
毎回、名前と親フォルダの関係から上から順に解決する。

```
1. 'root' in parents          から TSAM AI を探す
2. <TSAM AI の ID> in parents から Voice Recorder を探す
3. <Voice Recorder の ID> in parents から音声ファイルを取る
```

実際に発行するクエリ（実ブラウザで確認済み）:

```
name='TSAM AI' and mimeType='application/vnd.google-apps.folder'
  and 'root' in parents and trashed=false

name='Voice Recorder' and mimeType='application/vnd.google-apps.folder'
  and '<TSAM_AI_FOLDER_ID>' in parents and trashed=false

'<VOICE_RECORDER_FOLDER_ID>' in parents and trashed=false
```

**名前だけで Drive 全体を検索するクエリは発行しない。**
すべてのクエリに `in parents` が入る。

解決したフォルダIDは同じセッションの間だけ変数に持つ。
localStorage / sessionStorage / Cookie / URL / Drive のいずれにも書かない。
ページを再読み込みすれば消え、また名前から解決し直す。

フォルダ名は `apps/drive-folders.js` で音声録音アプリと共有している。
どちらか一方だけ名前を変えると噛み合わなくなるため、ここでまとめて定義する。

### drive.file スコープで足りる理由

`drive.file` で見えるのは「同じOAuthクライアントのアプリが作成したファイル」と
「Picker で明示的に選ばれたファイル」だけである。

音声録音アプリは、このアプリと **同じOAuthクライアント**
（`apps/auth-config.js` の `clientId`）で、**同じ `apps/drive-auth.js`** を使い、
`TSAM AI / Voice Recorder` へ録音を保存している。
同一クライアントが作成したファイルなので、`drive.file` のまま一覧・取得できる。

したがって **追加スコープも OAuth の再同意も不要**である。

ただし次の場合は見えない。これは仕様であり、
**スコープを `drive.readonly` などへ広げて回避してはならない。**

- 利用者が手動でアップロードした音声
- 別のGoogleアカウントで録音したファイル
- 別のOAuthクライアントのアプリが作ったファイル

実アカウントで一覧が取れない場合は、まず次を疑うこと。

1. 音声録音アプリと同じGoogleアカウントでログインしているか
2. 録音アプリで一度もDrive保存をしていない（フォルダ自体が無い）
3. OAuthクライアントが録音アプリと同じか

### 401 / 403 のときの挙動

| 状況 | 画面の挙動 |
| --- | --- |
| 401（トークン期限切れ） | メモリ上のトークンと解決済みフォルダIDを捨て、「利用許可の期限が切れました。『再読み込み』を押して、もう一度許可してください。」と表示。ダイアログの「再読み込み」で再認可へ進む |
| 403（権限不足・スコープ外） | 「アクセスが拒否されました。権限が足りないか、このアプリに許可されていないファイルの可能性があります。音声録音アプリと同じGoogleアカウントでログインしているかご確認ください。」と表示。**単なる「取得に失敗しました」にはしない** |

いずれもモックで確認済み。実アカウントでは401・403を意図的に発生させていない。

### フォルダが無い場合

**勝手に作らない。** 次のエラーを表示する。

```
Google Driveに「マイドライブ ＞ TSAM AI ＞ Voice Recorder」フォルダが
見つかりませんでした。先に音声録音アプリで録音を保存してください。
```

フォルダは音声録音アプリがDrive保存時に自動作成する
（`apps/voice-recorder/drive-client.js` の `ensureRecordingFolder`）。
このアプリ側で作ると、録音アプリが使うのとは別の空フォルダが増えるだけになる。

### 同名フォルダが複数ある場合

**最初の1件を勝手に使わない。** 作成日時と更新日時を添えて候補を並べ、
どれを使うかを利用者に選ばせる。選ばれたフォルダIDを親として、次の階層へ進む。

```
同じ場所に「TSAM AI」フォルダが複数見つかりました。
使用するフォルダを特定できません。下から選んでください。
```

`Voice Recorder` が重複した場合も同じ扱いにする。

### 音声ファイルの一覧

`Voice Recorder` フォルダ直下だけを見る。更新日時の新しい順。
ページ分割されている場合は最後までたどる（上限 `DRIVE.maxListPages`）。

音声かどうかは MIME で判定し、MIME が空や `application/octet-stream` の場合は
拡張子でも判定する（Drive の MIME が当てにならないことがあるため）。
音声以外のファイルは一覧に出さない。

0件のときは「Voice Recorderフォルダに音声ファイルがありません。」と表示する。

選んだファイルは必ずブラウザへ Blob として取得し、以降は端末選択のファイルと同じ経路を通る。
Drive の URL をそのまま Gemini へ渡すことはしない（Google 側に読む権限が無く、必ず失敗する）。

### Google Picker は使わない

主経路では Google Picker を使用しない。固定フォルダを Drive API で読む方式に統一している。

`drive-picker.js` と `picker-key.local.example.js` は、将来ドライブ全体から
選ばせたくなったときのために残してあるが、**現在どこからも読み込んでいない**。
再び使う場合は `index.html` の CSP に次を戻す必要がある（今は外してある）。

- `script-src` / `connect-src` … `https://apis.google.com`
- `frame-src` … `https://docs.google.com` `https://content-drive.googleapis.com`

### Google Cloud 側の必要設定

1. **Google Drive API を有効化する**（プロジェクトは既存アプリと同じもの）
   - 2026-07-27 時点で有効化済み。実アカウントで `files.list` / `files.get` が
     200 を返すことを確認している
2. OAuth クライアント（`apps/auth-config.js` の `clientId`）の
   **承認済みの JavaScript 生成元**に、使用するオリジンを追加する

```
本番    https://tsam-ai.com
ローカル http://localhost:8000
```

`http://127.0.0.1:8000` は `localhost` とは別オリジン扱いになるため、
使う場合は別途登録が要る。詳細は `apps/AUTH_SETUP.md` を参照。

ローカル（`http://localhost:8000`）は登録済みで、実際に認可が通ることを確認済み。
**本番オリジンでの認可は未確認**（下記「未確認事項」を参照）。

Picker を使わないため、**Picker API のブラウザキーは不要**である。

### 本番公開後に必要な確認

1. `https://tsam-ai.com` が承認済みのJavaScript生成元に入っていること
2. 本番URLで「Google Driveから選択」を押し、認可が通ること
3. 音声録音アプリの録音が一覧に出ること
4. OAuth同意画面が「テスト」状態なら、利用者を追加するか本番公開へ切り替えること
   （テスト状態のままだと、登録外のアカウントは認可できない）

### 実OAuthでの確認方法

実アカウントでの確認は次の順で行う。

1. 音声録音アプリ（`/apps/voice-recorder/`）で短い録音を1件Driveへ保存する
2. 同じブラウザ・同じGoogleアカウントで `/apps/audio-transcriber/` を開く
3. 「Google Driveから選択」を押し、認可画面で許可する
4. 手順1で保存した録音が一覧に出ることを確認する
5. 選んで再生できること、文字起こしが始まることを確認する

一覧が空の場合は、開発者ツールのネットワークタブで `files?q=...` の応答を確認する。
`files: []` が返っているなら、アカウント違いかフォルダ未作成である。

## Gemini APIキーの取得と扱い

キーは [Google AI Studio](https://aistudio.google.com/apikey) で取得する。

**このアプリはAPIキーを保存しない。**

- 保持するのは `script.js` のモジュールスコープ変数1つだけ
- `localStorage` / `sessionStorage` / Cookie / URL / DOM属性 / Google ドライブ へは書かない
- `console` へ出さない。エラー文言にも混ぜない
- ページを再読み込みするか閉じると消える。共有端末では使用後にページを閉じること

送信は必ず `x-goog-api-key` ヘッダーで行う。
クエリ文字列（`?key=...`）へ入れると、リファラーやアクセスログへ残る恐れがあるため使わない。

Gemini の応答本文にはプロジェクト情報が混じることがあるため、
API のエラーメッセージを画面へそのまま出さない。HTTPステータスとエラーコードから
こちらで用意した日本語文言へ変換して表示する（`gemini-transcriber.js` の `mapGeminiError`）。

### 2026年9月のAPIキー移行について

Google は従来型の Standard API キーを段階的に廃止し、
新しい **Authorization Key** への移行を進めている。
**2026年9月以降、従来型キーが使えなくなる可能性がある。**

このアプリはキーの形式を検証していない（正規表現で決め打ちしていない）ため、
新形式のキーもそのまま貼り付けて使えるはずである。
もし「APIキーが正しくないようです」と表示される場合は、
Google AI Studio で新しい形式のキーを再発行して試すこと。

移行の詳細は Google の公式案内を確認すること。

## 制限

| 項目 | 端末内モード | Gemini モード |
| --- | --- | --- |
| ファイルサイズ | 512 MB | 200 MB |
| 音声の長さ | 4 時間 | 2 時間 |

上限は `config.js` の `LIMITS` で管理する。

- **端末性能に強く依存する**。CPU のみの端末では、1時間の音声に1時間以上かかることがある
- WebGPU 対応ブラウザ（Chrome / Edge の新しめのもの）では大幅に速くなる
- モデルの初回ダウンロードは数十MB〜200MB超。2回目以降はブラウザのキャッシュから読む
  （キャッシュを消すと再ダウンロードになる）
- 長時間音声は `segmentSeconds` ごとに区切って処理するため、区切りの境目で
  文が途切れることがある
- 無料枠を超えた場合、Gemini は 429 を返す。「無料枠または利用上限を超えました」と表示し、
  勝手に課金へ切り替えることはしない

## ファイル構成

| ファイル | 担当 |
| --- | --- |
| `index.html` | 画面の構造。ヘッダー・パンくず・フッターは card-scanner と共通。ページ限定のCSPもここ |
| `style.css` | このアプリ固有のスタイルのみ。`at-` 接頭辞 |
| `script.js` | 状態に応じたDOM更新・文言・イベント。UI層。**APIキーを保持する唯一の場所** |
| `config.js` | 設定値の単一の情報源（モデルID・上限・分割時間・プロンプト） |
| `state.js` | 状態機械。DOM・fetch を参照しない |
| `audio-loader.js` | 音声の検証・デコード・16kHzモノラル化・分割 |
| `whisper-worker.js` | Transformers.js の実行役（Web Worker） |
| `whisper-transcriber.js` | Worker との通信・区間の連結・キャンセル |
| `gemini-transcriber.js` | Gemini REST（Files API / generateContent）とエラー分類 |
| `drive-client.js` | Drive API v3（固定フォルダの解決・一覧・ダウンロード・TXT保存） |
| `drive-picker.js` | Google Picker。**現在未使用**（将来のために残置） |
| `picker-key.local.example.js` | Picker APIキーの雛形。**現在未使用** |
| `result-exporter.js` | コピー・TXTダウンロード・整形（純粋関数中心） |

フォルダ名は `../drive-folders.js`（音声録音アプリと共有）で定義する。
認可（アクセストークンの取得）は `../drive-auth.js` を使う。
これは voice-recorder / card-scanner と共有している。複製しないこと。

## Content Security Policy

サイト全体のCSPは存在しないため、このアプリでは `index.html` の `<meta>` による
**ページ限定**のCSPを置いている。既存ページのCSPは緩めていない。

`'wasm-unsafe-eval'` は ONNX Runtime の WebAssembly 実行に必須で、これが無いと
端末内モードが動かない。`'unsafe-eval'` は許可していない。

`worker-src` には `blob:` に加えて `https://cdn.jsdelivr.net` が要る。
ONNX Runtime が **Transformers.js のバンドルURL自体を入れ子のワーカーとして起動する**ため、
これを許可しないと次の違反でモデルの読み込みが失敗する（実ブラウザで確認）。

```
Creating a worker from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js'
violates the following Content Security Policy directive: "worker-src 'self' blob:"
```

許可した接続先と理由は `index.html` のコメントに記載してある。
接続先を足すときは、必要最小限であることを確認すること。

## ローカルでの起動

ES Modules と Web Worker を使うため、`file://` では動かない。HTTPサーバーが要る。

```bash
# リポジトリのルートで
python -m http.server 8000
# → http://localhost:8000/apps/audio-transcriber/
```

`navigator.clipboard` は安全なコンテキスト（HTTPS または localhost）でしか使えない。
`localhost` なら問題ない。

Google ドライブ連携をローカルで試す場合は、OAuth クライアントの
「承認済みの JavaScript 生成元」に `http://localhost:8000` を追加する。

## 本番公開

静的ファイルをそのまま配置すれば動く。ビルド手順は無い。
公開後は OAuth クライアントの JavaScript 生成元に本番オリジンを追加する。

## テスト方法

自動テストは用意していない（`apps/` 配下の他アプリと同じ方針）。

### 静的確認

```bash
# 構文確認（node で各モジュールを構文解析する）
for f in apps/audio-transcriber/*.js; do node --check "$f"; done

# APIキーの混入確認
grep -rn "AIza\|GEMINI_API_KEY=\|GOOGLE_API_KEY=" apps/
grep -rn "localStorage" apps/audio-transcriber/
```

`node --check` は ES Modules の import を解決しないため、
import パスの誤りはブラウザの開発者ツールで確認する。

### 手動確認

1. MP3 / WAV を端末から選び、ファイル情報とプレーヤーが出ること
2. 画像など非対応ファイルを選び、日本語のエラーが出ること
3. 拡張子だけ `.mp3` にしたテキストファイルを選び、拒否されること
4. 「ファイルを解除する」で未選択へ戻ること
5. モードを切り替えると設定欄が入れ替わること
6. Gemini モードでキー未入力のまま開始し、「APIキーを入力してください」が出ること
7. 端末内モードで短い音声を処理し、進捗とキャンセルが動くこと
8. コピー・TXT保存・クリアが動くこと
9. 幅 375px と 1280px でレイアウトが崩れないこと

### 実Googleアカウントでの確認（2026-07-27）

実アカウント・実Driveで次を確認済み。

| 項目 | 結果 |
| --- | --- |
| OAuth認可（`drive.file` のみ） | 成功。追加スコープ・再同意は不要だった |
| `TSAM AI` の解決（マイドライブ直下） | 成功（HTTP 200） |
| `Voice Recorder` の解決（`TSAM AI` 直下） | 成功（HTTP 200） |
| 音声一覧の取得 | 成功。音声録音アプリが保存した録音4件を取得 |
| 実際に確認できたMIME | `audio/mpeg` のみ（音声録音アプリはMP3固定のため） |
| 音声のBlob取得（`alt=media`） | 成功（HTTP 200）。複数ファイルで確認 |
| ファイル名・MIME・サイズの保持 | 保持される |
| 再生 | 実際に再生位置が進むことを確認 |
| 取得元の表示 | `Google Drive：TSAM AI ＞ Voice Recorder` |
| **Whisper文字起こし** | 成功。5秒の録音を WebGPU で26秒、日本語で出力 |
| **長時間音声の分割** | 1時間・41.2MBの録音が13区間に分割され処理開始することを確認 |
| **処理の中止** | 上記の長時間処理を「中止する」で停止できることを確認 |
| **結果TXTのDrive保存** | 成功。`<元の音声名>.txt` で保存（拡張子の二重化なし） |
| 保存したTXTの中身 | UTF-8で復元可能・BOM無し・文字化け無し・`text/plain` |
| 保存先フォルダの重複作成 | 起きない（2回続けて解決しても同じフォルダIDを返す） |
| アクセストークンの保存 | localStorage / sessionStorage / Cookie / URL すべて空 |
| CSP違反・JS例外・失敗リクエスト | いずれも0件 |

結果TXTの保存先は `マイドライブ ＞ TSAM AI ＞ Audio Transcriber`。
このフォルダは初回保存時に自動作成される（音声の取得元とは別のフォルダ）。

**性能の目安（実測）**: WebGPU で、1時間の録音は5分ごとに13区間へ分割され、
1区間あたり約5分かかった。1時間の音声で1時間前後を見込むこと。
短い録音（5秒）はモデル読み込み込みで26秒だった。

**同一OAuthクライアント・同一Googleアカウントであれば、`drive.file` のままで
音声録音アプリの録音を一覧・取得できる**ことが実環境で確認できた。

発行されたクエリは下の「フォルダの特定方法」に書いたとおりで、
**すべてに `in parents` が入り、名前だけの全体検索は1件も発行されなかった**。

### Drive 経路のモック確認

実アカウントが無くても、発行するクエリと分岐は確認できる。
`fetch` と Google Identity Services を差し替えて次を確認した。

- `TSAM AI` の検索に `'root' in parents` が入ること
- `Voice Recorder` の検索に `'<TSAM AI の ID>' in parents` が入ること
- 一覧の検索に `'<Voice Recorder の ID>' in parents` が入ること
- **どのクエリにも `in parents` が入り、名前だけの全体検索が無いこと**
- 更新日時の降順（`orderBy=modifiedTime desc`）
- `nextPageToken` をたどって2ページ目も取得すること
- 音声以外（`text/plain`）を一覧から除くこと
- MIME が空でも拡張子で音声と判定すること
- フォルダ不在・重複・空フォルダ・401・403・ネットワークエラーの出し分け
- 重複時に候補を選ぶと、そのフォルダIDを親として次の階層を探し直すこと

### 実ブラウザでの確認記録（2026-07-27 / Chrome 141 headless / Windows 11）

Chrome を CDP で操作して確認した。確認済みの項目:

- ページ表示（CSP違反ゼロ・例外ゼロ・404ゼロ）
- MP3 / WAV の選択、差し替え、解除、同一ファイルの再選択
- 非音声ファイルと拡張子偽装ファイルの拒否
- Whisper の実ダウンロードと実推論（WebGPU / WASM の両方）
- 4区間への分割処理とタイムスタンプの区間補正
- 処理中のキャンセルと、キャンセル後の再実行
- 二重実行の防止
- コピー（クリップボード許可あり）・TXT保存（UTF-8・BOM無し）・クリア
- タイムスタンプ表示の切り替え（元データが復元されること）
- 5種のビューポートで横スクロールが出ないこと
- Drive 認証が「ボタンを押すまで開始しない」こと
- Drive 選択ダイアログ（Escapeで閉じる・フォーカスが戻る・5種の画面幅で崩れない）
- Drive のモック応答から選んだ音声が、端末選択と同じ画面へ渡ること

未確認（実環境が要る）:

- Gemini API の実通信（実APIキーが無いため）
- 本番オリジン（https://tsam-ai.com）での認可（ローカルのみ確認済み）
- 401 / 403 の実発生（モックでのみ確認）
- 同名フォルダが実際に重複した状態（モックでのみ確認）
- 音声録音アプリ以外が保存した音声での動作（MP3以外のMIME）
- Google Picker（主経路から外したため、このアプリでは使わない）
- Safari / Firefox での動作

## 既知の制限

- **Drive から選べるのは「マイドライブ ＞ TSAM AI ＞ Voice Recorder」の中だけ**。
  手元の音声を使う場合は「端末から選択」を使う
- 音声録音アプリと違うGoogleアカウントで開くと、一覧は空になる
- 端末内モードの精度はモデル依存。雑音の多い録音や複数話者の会議は苦手
- 端末内モードには話者分離が無い。「話者1」の区別は Gemini モードでのみ期待できる
- 長時間音声は区間の境目で文が途切れることがある。逆に、境目で
  実際には話されていない短い語が入り込むこともある（Whisper の性質。
  46秒の音声を15秒ごとに区切った実測で、境目に「おはようございます」が
  1行混入した）。重要な用途では境目の前後を目視で確認すること
- `decodeAudioData` の対応形式はブラウザによって異なる。特に m4a / AAC は
  Safari では通り Firefox では落ちることがある
- モデルのダウンロード進捗は、ライブラリが返すファイル単位の値をそのまま出している。
  複数ファイルの合計に対する進捗ではない
- Gemini のアップロード進捗は `fetch` では取得できないため、段階的な目安のみを出している
