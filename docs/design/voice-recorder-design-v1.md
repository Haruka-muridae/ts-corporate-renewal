# ブラウザ録音アプリ 詳細設計書 v1.0

| 項目 | 内容 |
| --- | --- |
| アプリID | `voice-recorder` |
| 実装 | `public/production-app/voice-recorder/` |
| 上位文書 | [../requirements/mvp-requirements.md](../requirements/mvp-requirements.md)（本書はその下位） |
| テスト | `tests/unit/voice-recorder.mjs`／`tests/unit/voice-recorder-notifier.mjs` |
| 規模 | 約3,700行（`vendor/lamejs.iife.js` を除く） |
| 作成日 | 2026年8月18日 |

このアプリだけ**バックエンドを持たない設計に一度作り直した経緯**がある。
要件書 v1.1 はサーバー側 MP3 変換と API 8本を前提にしていたが、
90分・約86MB の受信と FFmpeg 実行が関数上で成立しないため v1.2 でブラウザ完結へ改めた。
**「APIを足せば解決する」と考える前に上位文書 §14 を読むこと。**

---

## §1 責務と境界

### 1-1. 引き受けること

- マイクから最長**90分**録音し、**逐次** MP3（128kbps モノラル）へ変換する
- 変換済みデータを OPFS（端末内の一時領域）へ追記し、**録音全体をメモリに載せない**
- 停止後、利用者のマイドライブ「TSAM AI ＞ Voice Recorder」へ再開可能アップロードで保存する
- 保存または破棄のあと、一時ファイルを削除する

### 1-2. 引き受けないこと

- **サーバー側の処理。** 当社サーバーへ音声を送らない
- **録音の復旧。** MVP では持たない。異常終了で残った `.part` は次回起動時に無条件削除する
- **文字起こし。** `audio-transcriber` の担当（§1-3）
- **共有設定の付与。** `drive.js` に `permissions.create` を呼ぶ関数は無い。**足さないこと**

### 1-3. 隣との関係

| 相手 | 関係 |
| --- | --- |
| `public/auth/session.js` | `guardPage({ next: 'voiceRecorder', params: { eventId } })` |
| `audio-transcriber` | **保存先フォルダ名を共有する。** 文字起こし側が同じ場所を読みに来る。`DRIVE_NAMES` を変えるなら両方同時に変える |
| `public/apps/voice-recorder/` | 複製元（テスト環境）。**import しない。** 片方を直しても他方へは反映されない |
| カレンダー通知 | `?eventId=` 付きでこの画面を開く導線があった。**通知機能は本番に無く、現在この値は常に空**（§10-3） |

---

## §2 モジュール構成

| ファイル | 責務 | 行数 | 依存先 |
| --- | --- | --- | --- |
| `index.html` | 画面の骨格・CSP | 240 | — |
| `config.js` | 静的設定（唯一の設定源） | 174 | なし |
| `errors.js` | エラーコードと**画面文言** | 151 | なし |
| `filename.js` | 保存名の組み立て（純粋な文字列処理） | 89 | `config.js` |
| `oauth.js` | GIS 読み込みとトークン取得 | 153 | `config.js` `errors.js` |
| `drive.js` | Drive API v3（フォルダ解決・重複名・再開可能アップロード） | 380 | `config.js` `errors.js` `filename.js` |
| `recorder/recorder.js` | 録音のオーケストレーション（**画面を知らない**） | 535 | `config.js` `capabilities` `opfs-storage` |
| `recorder/encoder-worker.js` | PCM → MP3 逐次変換と OPFS 書き込み（classic worker） | 279 | `vendor/lamejs.iife.js` |
| `recorder/pcm-worklet.js` | AudioWorklet。PCM の取り出し | 84 | — |
| `recorder/opfs-storage.js` | OPFS のメインスレッド側操作 | 141 | — |
| `recorder/sync-access-probe-worker.js` | `SyncAccessHandle` が使えるかの実地確認 | 56 | — |
| `recorder/capabilities.js` | 対応環境の判定（機能検出のみ） | 172 | `config.js` |
| `app.js` | 画面。**判断と文言はここ** | 804 | 上記すべて ＋ `public/auth/` |

### 2-1. 層の分け方（このアプリの中核的な設計）

```
app.js                     ← DOM・文言・利用者への判断
  └→ recorder/recorder.js  ← 状態機械。DOM を触らない。エラーは code だけ返す
       ├→ AudioWorklet     ← PCM を切り出す（音声スレッド）
       └→ Worker           ← MP3 化と OPFS 書き込み（SyncAccessHandle は Worker 限定）
  └→ drive.js              ← Drive だけ。判断も文言も持たない
  └→ errors.js             ← code → 文言の変換を1か所に集約
```

**`recorder.js` に DOM・文言・エラー表示を書かない**という制約が明示されている。
状態と結果はコールバック（`onStateChange` / `onTick` / `onWarning` / `onStopped` /
`onFinalized` / `onError`）で外へ渡す。**この境界が、移植時にそのまま切り取り線になる**（§7）。

---

## §3 状態とデータ構造

### 3-1. `Recorder` の状態

`RecorderState`: `idle` → `preparing` → `recording` → `stopping` → `finalized`（または `error`）

`Recorder` が持つ主な内部状態は、送出済み秒数（`sentSeconds`）、エンコード済み秒数
（`encodedSeconds`）、書き込み済みバイト数（`bytesWritten`）、サンプルレート、
停止理由（`stopReason`）。**PCM も MP3 も保持しない**（端数と直近チャンクのみ）。

### 3-2. 永続化するもの

| 場所 | 内容 | 寿命 |
| --- | --- | --- |
| OPFS `recordings/*.mp3.part` | 録音中の一時ファイル | 保存／破棄で削除。異常終了時は次回起動時に削除 |
| Google Drive | 確定した MP3 | 利用者のもの |

**`localStorage` を使っていない。** このアプリに端末内へ残す設定が無いためである。

### 3-3. メモリだけに置くもの

アクセストークンと有効期限。`oauth.js` のクロージャ変数で、**参照を返す getter も作らない。**
`localStorage` / `sessionStorage` / Cookie / URL / ログのいずれにも書かない。

### 3-4. ファイル名

| 種類 | 生成場所 | 形 |
| --- | --- | --- |
| OPFS の一時名 | `opfs-storage.js` の `buildPartName()` | 端末内の作業ファイル |
| Drive の保存名 | `filename.js` の `buildDefaultFileName()` | `YYYYMMDD_HHmmss_録音.mp3` |

保存名の基準は**録音開始時刻・ブラウザのローカル日時**（UTC ではない）。
「お客様名・イベント名」欄に入力があれば、末尾の `_録音` の代わりに `_<入力>` を使う。

サニタイズ（`stripUnsafe`）が落とすのは**制御文字と `/` `\` だけ**。
ドットを落とすと拡張子が壊れ、空白を落とすと利用者が付けた区切りが消えるため、
記号や空白は残す。

同名の回避（`_2` `_3`…）は `drive.js` の `pickAvailableName()` が行う。
保存先の状況が要るため、純粋関数である `filename.js` には置いていない。

---

## §4 主要フロー

### 4-1. 起動（`main()`）

1. `guardPage({ next: 'voiceRecorder', params: { eventId } })`
   - **戻り先を Portal ではなくこの画面にしている。** 通知から `?eventId=` 付きで
     開かれたとき、`next` が `'portal'` だと**どの予定の通知だったのかが消える**
     （実機検証で確認済み）。持ち回せるのは `session.js` の画面ごとの許可リストに
     載せた値だけで、元 URL をそのまま引き継ぐわけではない
2. `isOauthConfigured()` が偽なら、連携ボタンを押せる状態のまま失敗させず、その場で理由を出す
3. `cleanupStaleFiles()` … 残存 `.part` を無条件削除（24時間待ちのような猶予は置かない。
   復旧機能を持たない以上、残存は名残とみなす）
4. 対応環境の判定と空き容量の表示

### 4-2. 録音開始（`Recorder.start()`）

```
1. detectSupport()          … セキュアコンテキスト・マイク・AudioContext・
                              AudioWorklet・Worker・OPFS を個別に判定
2. probeSyncAccessSupport() … SyncAccessHandle を Worker 内で実地に試す
                              （機能検出だけでは判別できないため）
3. checkFreeSpace(MIN_FREE_BYTES = 250MB)
4. getUserMedia → AudioContext → sampleRate が 44100/48000 か検査
                              （規格外はリサンプリングせず開始しない）
5. AudioWorklet を読み込み、PCM を Worker へ送る
6. タイマー開始（経過時間・15秒ごとの空き容量監視）
```

失敗は `toStartErrorCode()` が DOM 例外名から分類する
（`NotAllowedError`/`SecurityError` → `PERMISSION_DENIED`、
`NotFoundError`/`OverconstrainedError` → `NO_DEVICE`、
`NotReadableError`/`AbortError` → `DEVICE_BUSY`）。

### 4-3. 録音中の自動停止・警告

| 契機 | 閾値 | 動き |
| --- | --- | --- |
| 上限接近 | `WARNING_SECONDS`（既定 85分） | 予告（`onWarning('limit-approaching')`） |
| 上限到達 | `MAX_SECONDS`（既定 90分） | 自動停止（`reason: 'limit'`） |
| バックプレッシャ | 未処理 5秒で警告、10秒で停止 | Worker がエンコードに追いつかないと送出済み PCM がメモリに溜まり、「メモリ一定」の前提が崩れる |
| 空き容量 | `SAFE_MIN_BYTES`（100MB）を下回る | 自動停止して確定する |
| タブが隠れた／中断 | — | 警告（`hidden` / `interrupted`） |

**予告 = 上限 − 5分**の関係は必ず保つ（`config.js` の注記）。

### 4-4. 停止と確定

`stop(reason)` → Worker が残りをエンコードして `.part` を確定 → `onFinalized({ file, fileName, sizeBytes, durationSeconds })`。
以後、画面はプレビューと保存操作を出す。

### 4-5. Drive への保存（`saveToDrive()`）

```
1. ensureAccessToken()（oauth.js）
2. resolveTargetFolder()   … 'TSAM AI' を root 直下で、'Voice Recorder' をその直下で
                             findOrCreateFolder（**名前から解決し、無ければ作る**）
3. pickAvailableName()     … 同名があれば _2, _3…
4. uploadResumable()       … 8MB チャンクの再開可能アップロード
                             （Google の仕様で 256KB の倍数。90分＝約86MB で11回程度）
5. 一時ファイルを削除
```

**フォルダIDを固定登録しない。** ID は利用者ごとに異なり、固定値は他人のドライブで必ず失敗する。
加えて `drive.file` スコープでは、アプリが作成していないフォルダへ書き込めない。

### 4-6. 破棄（`discard()`）

Worker を中断し、`.part` を削除する。プレビュー用の Object URL も解放する。

---

## §5 外部インターフェース

### 5-1. Google OAuth

| 項目 | 値 |
| --- | --- |
| スクリプト | `https://accounts.google.com/gsi/client`（認可の提供元なので第三者CDNとは扱わない） |
| 方式 | 暗黙フロー（トークンモデル）。refresh token・client secret を使わない |
| スコープ | `https://www.googleapis.com/auth/drive.file` **のみ。増やさない** |
| クライアントID | `config.js` の `OAUTH.clientId`（`receipt-ocr` と同一のものを使う。公開値） |

### 5-2. Google Drive API v3

| 用途 | エンドポイント |
| --- | --- |
| 検索・フォルダ作成・削除 | `GOOGLE_API.driveFiles` |
| 再開可能アップロード | `GOOGLE_API.driveUpload` |
| 保存先の表示用アカウント | `fetchAccountEmail()` |

**当社ドメインへの通信は `guardPage()` の検証だけ。** 音声は Google と利用者の端末の間だけを動く。

### 5-3. 送らないもの

音声データ・トークン・ファイル名のいずれも当社サーバーへ送らない。

---

## §6 エラー設計

### 6-1. 2層になっている

| 層 | 型 | 目的 |
| --- | --- | --- |
| `recorder/` | `RecorderErrorCode`（12種） | 録音機構の失敗を機械的に分類する |
| アプリ全体 | `AppError` ＋ `ErrorCode`（認証・端末・容量・保存の4群） | 画面文言へ変換する |

`app.js` の `toAppErrorCode()` が前者を後者へ写す。**2つある理由**は、
`recorder.js` が画面を知らない層だからである（§2-1）。

### 6-2. 文言の方針

`errors.js` は「**次に何をすればよいか**まで書く」と定めている。

- ×「マイクを利用できません」
- ○「マイクを利用できません。ブラウザのアドレスバーのアイコンからマイクの使用を許可して、もう一度お試しください。」

**例外の `message` を画面へ出さない。** Google や DOM が返す英語文がそのまま出て、
利用者に読めないため。分岐に使うのは `code` だけ。

オリジン未登録の案内では、推測した固定文字列ではなく
**実際に開いているオリジン**（`globalThis.location.origin`）を出す。
Google Cloud Console に何を登録すべきかを利用者が読める形にするため。

---

## §7 移植（他プロダクトへの組み込み）

### 7-1. 移植単位

| 単位 | ファイル | 依存 | 単独で持ち出せるか |
| --- | --- | --- | --- |
| **長時間録音エンジン** | `recorder/` 一式 ＋ `vendor/lamejs.iife.js` ＋ `config.js` の録音節 | なし（DOM を知らない） | **可。このリポジトリで最も価値のある移植単位** |
| 対応環境の判定 | `recorder/capabilities.js` | `config.js` の3定数 | 可 |
| OPFS 一時保存 | `recorder/opfs-storage.js` ＋ `sync-access-probe-worker.js` | なし | 可 |
| Drive 再開可能アップロード | `drive.js` ＋ `oauth.js` | `errors.js` `filename.js` | 可（Drive を使う場合） |
| 保存名の組み立て | `filename.js` | `config.js` の2定数 | 可（純粋関数） |
| 画面 | `app.js` `index.html` | `public/auth/` | 不可のまま（§7-2 の4） |

### 7-2. 置換点

1. **`config.js` の全定数。** とくに `OAUTH.clientId`（移植先で発行し直す）、
   `DRIVE_NAMES`（保存先の名前）、`MAX_SECONDS` / `WARNING_SECONDS`（**予告＝上限−5分の関係を保つ**）、
   `BITRATE_KBPS`（変えると §7-3 の容量前提も変わる）、`MIN_FREE_BYTES` / `SAFE_MIN_BYTES`
2. **Worker とワークレットの相対パス。** `encoder-worker.js` は `../vendor/` から
   lamejs を読む。ディレクトリを動かすと壊れる
3. **ビットレートの受け渡し。** Worker は定数を持たず `init` メッセージで受け取る。
   **値の正は `config.js` 1か所**という設計なので、Worker 側に二つ目の定義を作らない
4. **`public/auth/` への依存。** `app.js` の `guardPage()` と `setScreenDepth` 相当
5. **CSP。** `index.html`。Google の認可・API のオリジンが要る
6. **`vendor/lamejs.iife.js` のライセンス表示。** `LICENSE-lamejs.txt` と
   `NOTICE-lamejs.txt` を**必ず一緒に持ち出す**

### 7-3. 前提

- **セキュアコンテキスト**（https または localhost）。OPFS・AudioWorklet・マイクのすべてが要求する
- **`SyncAccessHandle` が使えること。** 機能検出だけでは判別できないため、
  起動時に Worker 内で実地に試している（`probeSyncAccessSupport`）
- **サンプルレートが 44100 または 48000。** 規格外はリサンプリングせず開始しない（MVP の割り切り）
- **空き容量。** 90分＝約86MB に対し、開始前に 250MB を要求する。
  `navigator.storage.estimate()` は推定値でしかなく、実際に書き込める量と一致しないため
- 動作保証は Chrome 最新版のみ。**非対応時の代替モードを持たない**

### 7-4. 持ち出してはいけないもの

- **`permissions.create` を足した版。** 共有設定を付与しない設計である
- テスト用の上限上書き（`?testMaxSeconds=`）を localhost 以外へ開くこと。
  現在は `isTestOrigin()` が本番で false になり、上書き値も
  `0 < 値 <= 既定値` に丸められるので上限を延ばせない。**この2重の制限を外さない**
- 当社の保存先フォルダ名（`TSAM AI ＞ Voice Recorder`）。移植先の名前に変える

---

## §8 テスト設計

| スイート | 内容 |
| --- | --- |
| `tests/unit/voice-recorder.mjs` | ファイル名の生成・サニタイズ・連番、容量計算、対応判定、Drive 呼び出しの組み立て |
| `tests/unit/voice-recorder-notifier.mjs` | 通知から開かれたときの `eventId` の持ち回り |

実録音はテストしない（マイクと AudioWorklet が要る）。
**上限90分をそのまま検証すると1件に90分かかる**ため、localhost 限定で
`?testMaxSeconds=20&testWarningSeconds=10` の上書きを許している。
定数を書き換えて戻し忘れる事故を避けるための仕組みで、本番では到達しない（§7-4）。

---

## §9 設定値と環境依存

`config.js` が唯一の設定源。主なもの。

| 定数 | 意味 |
| --- | --- |
| `SCREEN_DEPTH` | ルートからの深さ（2） |
| `OAUTH.clientId` / `OAUTH.scope` | 公開値。スコープは `drive.file` のみ |
| `MAX_SECONDS` / `WARNING_SECONDS` | 90分／85分 |
| `BITRATE_KBPS` / `MP3_BYTES_PER_SECOND` | 128kbps ＝ 16,000 bytes/s ≒ 0.96 MB/分 |
| `SUPPORTED_SAMPLE_RATES` | `[44100, 48000]` |
| `MIN_FREE_BYTES` / `SAFE_MIN_BYTES` | 250MB／100MB |
| `DRIVE_NAMES` | `TSAM AI` ／ `Voice Recorder`（**文字起こしアプリと共有**） |
| `TIME_ZONE` / `FILE_NAME_SUFFIX` / `FILE_EXTENSION` / `MP3_MIME` | 保存名 |
| `GOOGLE_API` | Drive のエンドポイント |

**秘密情報を置かない。** クライアントIDは公開値であり、実質的な防御は
Google Cloud 側の「承認済みの JavaScript 生成元」である。

---

## §10 既知の制約・未解決

1. **復旧機能が無い。** 異常終了した録音は失われる（上位文書 §2.2 / §10-14 の割り切り）。
   残った `.part` は次回起動時に削除される
2. **利用者が手で置いた同名ファイルは検出できない。** `drive.file` スコープでは
   アプリの作成物しか見えないため、Drive 側に同名が2つ並ぶことがある。
   スコープを広げない方針を優先した結果であり、避けられない
3. **`?eventId=` の導線は現在使われていない。** 通知機能はテスト環境へ移設され、
   本番に無い。ログイン経由の持ち回りは通知とは独立に効いているため残してあるが、
   **残す／消すの判断は保留中**（[../notifier-v2-resume.md](../notifier-v2-resume.md)）
4. **アクセス制御はクライアント側ガードが主。** 静的配信のため HTML と JS の取得自体は
   防げない（[../../SECURITY_NOTES.md](../../SECURITY_NOTES.md)）。
   Drive のデータを守っているのは OAuth であって `guardPage()` ではない
5. **非対応環境に代替が無い。** テスト環境版は通常録音へ誘導していたが、
   このアプリは長時間録音しか持たないため「利用できない」で終わる

---

## §11 設計判断の記録

| 判断 | 採らなかった案 | 理由 |
| --- | --- | --- |
| ブラウザ完結 | サーバーで MP3 変換（要件書 v1.1 の当初案） | 90分・約86MB の受信と FFmpeg 実行が関数上で成立しない（上位文書 §14） |
| 逐次エンコード＋OPFS | 録音後にまとめて変換 | 90分ぶんの PCM をメモリに載せられない |
| `SyncAccessHandle` を実地に試す | 機能検出だけで判断 | 存在しても使えない環境があり、検出だけでは判別できない |
| 規格外サンプルレートは開始しない | リサンプリングする | MVP の割り切り。実装量に見合わない |
| フォルダを名前から解決 | ID を設定に持つ | ID は利用者ごとに違い、`drive.file` ではアプリ作成物にしか書けない |
| 8MB チャンク | 単発アップロード | 90分＝約86MB。途中で切れたときの再送量が現実的に収まる |
| 上限上書きを localhost 限定で許す | 定数を書き換えてテストする | 戻し忘れが本番へ出る |
| `recorder/` を DOM から切り離す | 画面と一体で書く | テストでき、そのまま移植単位になる（§7-1） |

---

## §12 変更履歴

| 版 | 日付 | 内容 |
| --- | --- | --- |
| v1.0 | 2026-08-18 | 初版。実装（2026年8月時点）を記述 |
