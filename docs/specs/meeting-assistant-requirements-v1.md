# Meeting Assistant 要件定義書

- バージョン: v1.0
- 作成日: 2026年8月25日
- ステータス: 実装済み・本番公開済み（v1.0）
- 公開URL: `https://tsam-ai.com/meeting-assistant/`
- 実装: `public/meeting-assistant/`（ビルド無しの静的 HTML / CSS / ESM）

## 改訂履歴

| 版 | 日付 | 内容 |
| --- | --- | --- |
| v1.0 | 2026-08-25 | 初版。ブラウザ / PWA 版の完成状態（PR #63 / #64、Cloudflare Workers Version `2954f7a8`）を要件として確定。スマートフォンネイティブ版（`mobile/meeting-assistant/`）は開発停止・保持 |

## §1 目的と位置づけ

### §1-1 目的

本アプリは、対面（On-site）またはオンライン会議（Remote）の音声をブラウザだけで録音し、利用者自身の Google Drive へ保存したうえで、Gemini による文字起こし・To Do 抽出・議事録生成を行い、その結果を Markdown として同じ Drive に保存する Web アプリである。

利用者の操作は「録音開始 → 録音停止」の 2 つを基本とし、停止後は Drive 保存 → 文字起こし → 議事録 → Markdown 保存まで自動で進める。音声・文字起こし・議事録は**利用者の Google Drive にのみ**置き、当社サーバーには送らない。Gemini API キーも利用者の端末内にだけ保存する。

### §1-2 他システムとの関係

| 対象 | 関係 |
| --- | --- |
| `https://meeting.tsam-ai.com/`（`~/projects/meeting-assistant`、Cloudflare Worker + Workflows） | **別アプリ**。リポジトリ・Worker・認証方式（サーバー側認可コードフロー）がすべて異なる。本要件の対象外であり、互いに変更を波及させない |
| `public/production-app/voice-recorder/` | 録音経路（AudioWorklet → Worker(lamejs) → OPFS）の流用元。本アプリ側は複製であり、双方向の自動反映はない |
| `public/production-app/interview-recorder/` | Remote 録音のミックス（getDisplayMedia + getUserMedia）の流用元 |
| `public/production-app/meeting-minutes/` / `audio-transcriber/` | Gemini 呼び出し・議事録構造（根拠照合）の流用元 |
| `mobile/meeting-assistant/`（Capacitor、Android Foreground Service、iOS AVAudioRecorder） | **開発停止・保持**。削除・変更しない。ブラウザ側の `native-bridge.js` は Capacitor が無い環境では常に無効で、PC / スマートフォンブラウザの経路に影響しない |
| TSAM AI Portal（`/portal/`、`/login/`） | **独立入口**。ポータル認証・共通セッションを使わず、ポータルのアプリ一覧にも登録していない |

### §1-3 アプリ基本情報

| 項目 | 定め |
| --- | --- |
| アプリID | meeting-assistant |
| 公開URL | `https://tsam-ai.com/meeting-assistant/`（`next.config.ts` の `/:path*/ → /:path*/index.html` 書き換えで配信） |
| 配信 | Cloudflare Workers（OpenNext）。本番反映は `npm run deploy`（predeploy-check → build → deploy）。`main` の内容から行う |
| 対応環境 | PC: Chrome / Edge 最新版（Remote 録音はタブ音声取得のため PC のみ）。スマートフォン: Android Chrome / iOS Safari 最新版、およびホーム画面に追加した PWA |
| 認証 | Google OAuth（GIS 暗黙フロー、スコープ `drive.file` のみ）。トークンはメモリ保持のみ |
| 秘密情報 | client secret / refresh token は持たない。Gemini API キーは `localStorage`（`meeting-assistant-keys`）にのみ保存し、サーバーへ送らない |

## §2 スコープ

### §2-1 含む機能

| ID | 機能 | PC | スマートフォン |
| --- | --- | --- | --- |
| F-1 | On-site 録音（マイク） | ○ | ○ |
| F-2 | Remote 録音（会議タブの音声 + マイクのミックス） | ○ | **表示しない** |
| F-3 | Drive から音声を選び議事録を作成 | ○ | ○ |
| F-4 | 過去の議事録（Markdown 一覧・Drive で開く） | ○ | ○ |
| F-5 | 設定（Google Drive 連携 / Gemini API キー / 対応種別） | ○ | ○ |
| F-6 | Google Drive 保存（音声・Markdown） | ○ | ○ |
| F-7 | Gemini 連携（文字起こし・To Do・議事録） | ○ | ○ |
| F-8 | Markdown 保存 | ○ | ○ |
| F-9 | PC 最前面表示（Document Picture-in-Picture の録音コントローラー） | ○ | 非対応ブラウザでは非表示 |
| F-10 | 保存待ち録音の回収（未連携・失敗・中断した録音を端末から Drive へ） | ○ | ○ |
| F-11 | PWA（manifest、ホーム画面追加、standalone） | ○ | ○ |

### §2-2 含まない機能・保証しないこと

- スマートフォンでの**画面 OFF 録音・完全バックグラウンド録音**は保証しない（§5-6）。
- スマートフォンネイティブ版（Android / iOS）の新規開発（停止中のコードは保持）。
- ポータル認証・共通セッション・課金・複数利用者の管理。
- Gemini API キーの共有・サーバー側保管。
- Service Worker によるオフライン動作（PWA は manifest のみ。Chrome の installability 条件は満たす）。
- 議事録の画面内編集（結果は Drive の Markdown で扱う）。

## §3 画面

### §3-1 画面一覧と遷移

| 画面 | data-screen | 入口 | 内容 |
| --- | --- | --- | --- |
| ホーム | `home` | `/meeting-assistant/` | 「▼ 設定 ▼」（中央、開閉式）、タイトル「Meeting Assistant」（押すと再読み込み）、円形ボタン On-site / Remote / Drive、保存待ち録音の一覧（該当時のみ）、「過去の議事録 ›」、© 表示 |
| On-site | `offline` | 円ボタン | 所属・氏名・対応種別、録音開始 / 停止、経過時間と上限、最前面表示（対応時）。スマートフォンには「画面を消さないでください」の注意を表示 |
| Remote | `online` | 円ボタン（PC のみ） | 同意確認チェック、所属・氏名・対応種別、録音開始 / 停止、注意書き（会議タブを選ぶ・「タブの音声も共有する」をオン） |
| Drive | `pick` | 円ボタン | Potenitas voice 内の音声一覧（処理済み / 未処理バッジ）、「一覧を更新」「議事録を作成」 |
| 過去の議事録 | `records` | 「過去の議事録 ›」 | Potenitas record 内の Markdown 一覧、「Markdownを開く」 |
| 処理中 | `process` | 自動 | 音声の準備 / 文字起こし / To Do・議事録 / Markdown 保存 の 4 段階 |
| 完了 | `done` | 自動 | 「Markdown を開く」 |

- 履歴は `home / offline / online / pick / records` を `#画面名` で `pushState` し、「‹ Meeting Assistant」とブラウザの戻るで戻れる。`process` / `done` は履歴に積まない。
- 説明文（「録音するか音声を選び…」）はホームに出さない（設計指示書 `docs/specs/assets/meeting-assistant/meeting-assistant-design.png` の適用時に確定した判断）。
- 録音中は他画面への移動・タイトルの再読み込みを止め、タブを閉じる操作には確認を出す。

### §3-2 ホームのレイアウト（設計指示書準拠）

- 背景は純白 `#FFFFFF`。装飾・アニメーションは加えない。
- 円は同じ大きさで、上段に On-site（淡いピンク `#e8a8a8`、左）と Remote（淡いグリーン `#cfe8c8`、右）、その下に Drive（淡いイエロー `#f3e6b0`、中央）を置き、上の 2 つに少し重ねる（重なり量は円の 12%）。押した円が前面に来る。
- Remote を出さない環境では On-site と Drive を横に並べ、少し重ねる（1 段）。
- 円の大きさは `clamp(120px, 30vw, 190px)`。幅 375px 未満では `clamp(118px, 42vw, 170px)`、横向きで高さが低いときは `clamp(96px, 22vh, 150px)`。
- 「過去の議事録 ›」は円の下の横長ボタン（枠線付き・白背景・角丸）。

### §3-3 環境判定（`platform.js`）

| 判定 | 方法 | 用途 |
| --- | --- | --- |
| スマートフォン / タブレット | `navigator.userAgentData.mobile` → UA 文字列（Android / iPhone / iPad / iPod / Mobile 等）→ iPadOS（`MacIntel` かつ `maxTouchPoints > 1`） | Remote を隠す、注意書きを出す、認証方式の切替 |
| standalone（ホーム画面追加） | `navigator.standalone === true` または `display-mode: standalone` | OAuth をリダイレクト方式にする |
| ネイティブ（Capacitor） | `Capacitor.isNativePlatform()` | 停止中の経路。ブラウザでは常に false |
| Remote を出すか | ネイティブでなく、スマートフォンでなく、`getDisplayMedia` がある | `body.ma-no-remote` で円を隠し、`#online` 直打ちはホームへ戻して「Remote録音はパソコン版で利用できます。」を表示 |

`body` に `ma-native` / `ma-no-remote` / `ma-mobile` / `ma-standalone` を付ける。

### §3-4 レスポンシブと Safe Area

- `viewport-fit=cover` を宣言し、`.vr-main` の上下左右 padding に `env(safe-area-inset-*)` を加算する（ホーム画面追加 PWA・Android の edge-to-edge で、設定リンク・見出し・下端が端末の表示と重ならない）。全画面が `.vr-main` の内側にあるため、トップ / On-site / Remote / Drive / 過去の議事録 のすべてに効く。
- 入力欄は 16px 以上（iOS のフォーカス時拡大を防ぐ）。ボタン・リンクは `touch-action: manipulation`、タップハイライト無し。
- 幅 30rem 以下では操作ボタンを縦積み（全幅）にする。
- 対応幅: 320 / 375 / 390 / 412 / 768 / 1280。横向きスマートフォンでも 1 画面に収まる。

## §4 録音

### §4-1 方式

| 項目 | 定め |
| --- | --- |
| 取り込み | AudioWorklet（`recorder/pcm-worklet.js`）→ メインスレッド → Dedicated Worker（`recorder/encoder-worker.js`、lamejs） |
| 形式 | MP3 128kbps モノラル、サンプルレート 44.1kHz / 48kHz（それ以外は開始しない） |
| 一時保存 | OPFS `recordings/` に逐次書き込み（SyncAccessHandle）。10 秒ごとに flush。録音全体をメモリに持たない |
| 上限 | 90 分（残り 5 分で予告、到達で自動停止）。`localhost` では `?testMaxSeconds=` / `?testWarningSeconds=` で短縮可 |
| 空き容量 | 開始前 250MB、録音中 100MB を下回れば停止 |
| 自動停止 | 上限 / 中断（着信・画面ロック・アプリ切替で AudioContext が suspended / interrupted）/ 空き容量不足 / エンコード遅延（未処理 10 秒）/ マイク切断。いずれも手動停止と同じく確定して保存へ進む |
| 確定待ち | 停止後 30 秒以内に確定しなければ失敗として画面を解放する（録音は台帳に残る） |
| iOS 対策 | `AudioContext` を作成後に `resume()` し、`running` にならなければ開始せず案内する（無音録音の防止） |
| 画面消灯 | Screen Wake Lock を録音中だけ要求する（補助。取得できなくても録音は続ける） |

### §4-2 Remote 録音（PC のみ）

- 録音前に「会話参加者から録音について必要な同意を得ています」のチェックを必須とする（未チェックでは開始しない）。
- `getDisplayMedia({ video: true, audio: true })` で会議タブを選び、マイクと 0.7 ずつのゲインでミックスする。タブ音声が共有されなければマイクのみ、マイクが取れなければタブ音声のみで録音し、その旨を表示する。
- Remote では録音開始前の Google 連携を行わない（`getDisplayMedia` に必要な利用者操作の猶予をポップアップで消費しないため）。未連携で録音した場合は §4-4 の保存待ちに残る。

### §4-3 ファイル名

`【対応方法】所属 氏名【対応種別】.mp3`（`filename.js`）

- 対応方法は録音方法から自動で決める（On-site → 現地対応、Remote → 遠隔対応）。
- 所属・氏名・対応種別は空欄なら省略する。全て空のときは録音開始時刻 `YYYY-MM-DD_HH-mm`（Asia/Tokyo）を使う。
- 制御文字と `/` `\` を落とす（記号・空白は残す）。同名があれば Drive 側で `_2`, `_3` … を付ける。
- 対応種別は設定で管理する（`localStorage` `meeting-assistant-kinds`。既定: 商談 / 面談 / 打ち合わせ / 定例会議 / 採用面談 / ヒアリング。40 文字以内、重複不可）。

### §4-4 確定後の流れと保存待ち台帳（`pending-store.js`）

録音の確定は停止ボタン以外でも起きるため、すべて `Recorder.onFinalized` に集約し、次の順で扱う。

1. **録音開始の直後**に台帳（`localStorage` `meeting-assistant-pending`）へ「録音中」の行を載せる。録音中にページが落ちても、次回起動時にこの行が OPFS の途中ファイルを掃除から守り、「録音が途中で終わっています」として回収できる。
2. 確定したら行を「保存待ち」に更新する。音声データ・トークンは台帳に入れない。台帳はメモリ上が正で、`localStorage` に書けない環境でも画面を開いている間は一覧に出る（その旨を案内する）。件数の上限は設けない。
3. Google 連携済み（トークン有効）なら、そのまま Drive へアップロード → 台帳と OPFS から削除 → 文字起こし・議事録へ。
4. 未連携なら台帳に残してホームへ戻す。ホームの「未アップロードの録音があります」から**「Driveへ保存」**（利用者の押下）で連携し、保存 → 議事録へ進む。失敗した行は「前回の保存に失敗」となり「Driveへ再送」。「破棄」で端末から削除できる。
5. 起動時の OPFS 掃除は、台帳に載っているファイルを残し、それ以外の `.part` と probe 用 `.tmp` だけ消す。台帳にあるのに OPFS に無い行（`NotFoundError`）だけ落とし、OPFS 自体に届かないときは台帳に触らない。
6. 同じ録音の Drive 送信中は「Driveへ保存」を無効にする（二重送信防止）。Worker が 0 バイトと報告したときだけ「空録音」として削除する。

On-site は録音開始の押下で先に Google 連携を求める（停止後ではポップアップが阻止されるため）。断られても録音は始め、そのセッション中は再要求しない。

## §5 Google 連携

### §5-1 認証（`oauth.js`）

| 方式 | 使うとき | 仕組み |
| --- | --- | --- |
| ポップアップ（既定） | PC / 通常のスマートフォンブラウザ | Google Identity Services のトークンクライアント。起動時に GIS を先読みする |
| リダイレクト | standalone PWA、またはスマートフォンでポップアップを開けなかったとき | 同じ画面を `accounts.google.com/o/oauth2/v2/auth`（`response_type=token`）へ遷移させ、戻り URL の fragment からトークンを受け取る |

- スコープは `https://www.googleapis.com/auth/drive.file` のみ。`include_granted_scopes` は送らない（共有 clientId の他アプリのスコープを拾わない）。
- トークンはモジュール内メモリだけに置き、期限の 60 秒前で無効扱いにする。401 を受けたら捨てて再連携する。
- リダイレクト方式: `state`（乱数 16 バイト）を `sessionStorage` に置いて往復を突き合わせ、不一致・往路の記録なし・10 分超過・時計の巻き戻りは捨てる。fragment は受け取った直後に URL から消す。往路に預けるのは再開先（画面名・保存待ち録音の ID）だけで、戻ったら続きを自動で行う。復路で拒否された場合、次の録音開始で再び Google へ飛ばない。
- 戻り先 URL は「今開いている場所」から算出し、`index.html` を落として末尾スラッシュを必ず付ける（`https://tsam-ai.com/meeting-assistant/`）。Google Cloud Console の「承認済みのリダイレクト URI」に登録済み。
- 受容している点: 暗黙フローのため `#access_token=…` が一瞬アドレスバーに載る。fragment はサーバーへも Referer へも送られず、`state` 検証でトークン注入を防ぐ。
- 設定の「Google Drive 連携」で状態（未連携 / 連携済み・残り時間）を表示し、「連携する」「連携しなおす」を押せる。

### §5-2 Drive の保存先とファイル

| 対象 | 場所（マイドライブ以下） | 形式 |
| --- | --- | --- |
| 音声 | `Potenitas System ＞ Potenitas Administrator ＞ Potenitas meet ＞ Potenitas voice` | `【対応方法】所属 氏名【対応種別】.mp3`（resumable upload、8MB チャンク） |
| 議事録 | `Potenitas System ＞ Potenitas Administrator ＞ Potenitas meet ＞ Potenitas record` | 音声と同じ語幹の `.md`（`text/markdown`）。同名があれば上書き（再生成前に確認） |

- フォルダ ID は持たず、毎回「名前と親」から解決し、無ければ作る。
- Drive 画面は Potenitas voice 直下の音声（拡張子 / MIME で判定）だけを表示し、同じ語幹の `.md` が record にあれば「処理済み」とする。

## §6 文字起こし・議事録・Markdown

### §6-1 Gemini（`config.js` にモデルを集約）

| 項目 | 定め |
| --- | --- |
| 既定モデル | `gemini-2.5-flash-lite`（最軽量）。404 のときだけ `gemini-3.5-flash-lite` へフォールバック。UI からモデルは選ばせない |
| 文字起こし | Files API（resumable、`upload, finalize`）へ音声を上げ、`TRANSCRIPTION_PROMPT`（要約しない・補完しない・聞き取れない箇所は「[聞き取り不能]」・話者は「話者1」「話者2」・可能ならタイムスタンプ）で本文のみ返させる |
| 議事録 | `responseSchema`（JSON）で 概要 / 議題 / 決定事項 / タスク / 未決事項 を構造化出力。決定事項・タスクの `evidence` を文字起こし原文と照合し、見つからなければ「根拠を確認できません」に降格する。担当・期限は推測せず空のまま |
| 上限 | 音声 200MB / 2 時間、文字起こし 60,000 文字（45,000 で警告）、出力 8,192 トークン |
| API キー | 利用者が Google AI Studio で発行し、設定画面から登録。未登録なら音声の Drive 保存までを行い、設定を開いて案内する |
| モック | `localhost` かつ `?mockGemini=1` のときだけ固定結果を返す（テスト用。本番では無効） |

### §6-2 Markdown の固定構造（`markdown.js`）

```
# 引用元
音声ファイル: <Drive の URL>

# To Do
- <タスク>（担当: … / 期限: …）

# 議事録
## 会議情報 / ## 概要 / ## 議題 / ## 決定事項 / ## タスク / ## 未決事項（空は「記載なし」）

# 文字起こし
<本文>
```

## §7 設定

| 項目 | 保存先 | 内容 |
| --- | --- | --- |
| Google Drive 連携 | メモリ（トークン） | 状態表示、連携する / 連携しなおす。standalone では「Google の画面へ移動して戻る」旨を表示 |
| Gemini API キー | `localStorage` `meeting-assistant-keys` | 保存 / 削除。保存済みの値は再表示しない。取得先リンク（Google AI Studio） |
| 対応種別 | `localStorage` `meeting-assistant-kinds` | 追加 / 削除（§4-3） |

設定はホームの「▼ 設定 ▼」の開閉式パネルで、3 つのアコーディオンとして表示する。画面遷移しない。

## §8 セキュリティ

- CSP: `default-src 'self' …; script-src 'self' https://accounts.google.com; worker-src 'self'; connect-src 'self' … https://www.googleapis.com https://generativelanguage.googleapis.com; frame-src https://accounts.google.com; object-src 'none'; base-uri 'none'; form-action 'none'`。`innerHTML` は使わず、外部由来の値は `textContent` / `createElement` だけで描画する。
- 秘密情報: client secret / refresh token を持たない。トークンは URL（履歴）・`localStorage` / `sessionStorage`・ログへ書かない。Gemini キーは端末内のみ。`config.js` に API キーをハードコードしない（テストで検査）。
- 通信先: Google（accounts / www.googleapis.com / generativelanguage.googleapis.com）のみ。当社サーバーへは音声・文字起こし・議事録・キーのいずれも送らない。
- 同じ OAuth clientId を兄弟アプリと共有しているため、スコープの拡張は本アプリの意図に反する（§5-1）。

## §9 テスト

| 種別 | 実行 | 内容 |
| --- | --- | --- |
| 単体（純ロジック） | `~/dev/node22/bin/node tests/run.mjs meeting-assistant`（221 件） | モデルと秘密情報、Drive フォルダ、ファイル名、対応種別、Markdown 命名と処理済み判定、Markdown 固定構造、To Do の非推測、Gemini モック、独立入口（HTML の導線・文言）、PiP、ネイティブ分岐の保持、環境判定、OAuth リダイレクト（認可 URL・fragment・state 突き合わせ・古い往復・トークンを保存しない）、保存待ち台帳 |
| 全体 | `node tests/run.mjs unit`（5503 件）、`node public/apps/tests/run.mjs unit`（659 件）、`npm run typecheck`、eslint | 他アプリへの回帰 |
| CI | GitHub Actions `tests`（push / pull_request） | 上記スイート |
| 描画 | Windows Chrome ヘッドレス（PC 1280px、iframe ラッパーでスマートフォン幅 320 / 390 / 412 / 横向き） | 円の配置、Remote 非表示、横はみ出しなし |

Gemini API の実呼び出しはテストしない（モックのみ）。

## §10 実機で確認すること（リリース後）

| 項目 | 端末 | 合格条件 |
| --- | --- | --- |
| Safe Area | Android Chrome / iOS Safari / ホーム画面追加 PWA | 「▼ 設定 ▼」・各画面の見出し・下端が端末の表示と重ならず操作できる |
| リダイレクト認証の往復 | iPhone ホーム画面追加 PWA | Google から**同じ PWA**へ戻り、連携済みになる（戻らない場合は Safari で開く案内へ切り替える） |
| On-site 録音 → Drive | スマートフォン | 停止後に Potenitas voice へ保存され、議事録へ進む。未連携で録音した場合はホームの「Driveへ保存」で回収できる |
| 途中で落ちた録音の回収 | スマートフォン | 録音中にタブを落とし、再度開くと「録音が途中で終わっています」から Drive へ保存できる |
| 90 分上限 | PC | 自動停止後に Drive へ保存される |
| Remote 録音 / PiP | PC Chrome / Edge | 従来どおりタブ音声 + マイクで録音でき、最前面表示から停止できる |
| 議事録生成 | 任意 | Gemini API キー登録後に文字起こし・議事録・Markdown が Drive に保存される |

## §11 既知の制約

- スマートフォンで画面が消える・他アプリへ切り替えると録音は止まり得る（そこまでの録音は端末に残り、Drive へ保存できる）。
- Remote 録音は PC の Chrome / Edge のみ（Zoom / Teams はブラウザ版で参加する）。
- OAuth のアクセストークンは約 1 時間で切れる。90 分録音の停止後に切れていた場合は、ホームの「Driveへ保存」から連携しなおして保存する。
- `drive.file` スコープのため、本アプリ以外が作ったファイルは Drive 画面に出ない場合がある。
- Gemini の実挙動（長時間音声の文字起こし精度・継続）は本要件の検証範囲外。

## §12 採らなかった選択肢

| 選択肢 | 採らなかった理由 |
| --- | --- |
| ネイティブ版（Capacitor）を先に完成させる | 実機ビルド・審査の工数が大きく、ブラウザ / PWA で PC とスマートフォンを同一実装にできるため。コードは将来再開できるよう保持 |
| Service Worker でオフライン対応 | 更新時の古いアセット残留のリスクが利点を上回る。installability には不要 |
| 認可コードフロー（サーバー側） | 静的サイトで client secret を持てない。`meeting.tsam-ai.com` 側は Worker を持つため別方式を採っている |
| PC でもポップアップ阻止時にリダイレクトへ切り替える | 未登録の redirect URI で利用者がアプリ外に取り残されるため、PC は従来どおりポップアップ解除を案内する |
| 保存待ち台帳に件数上限を設ける | 上限で古い行を黙って落とすと録音が消える。容量は録音開始前の空き容量確認が守る |
| ホームに説明文を出す | 設計指示書の適用時に「出さない」と確定（単体テストで固定） |

## §13 追加要件（ここに追記する）

| ID | 要件 | 状態 |
| --- | --- | --- |
| （なし） | | |

## 付録 参照

- `docs/specs/meeting-assistant-browser-pwa-v1.md`（ブラウザ / PWA フェーズの設計メモ）
- `docs/specs/assets/meeting-assistant/meeting-assistant-design.png`（ホーム画面の設計指示書）、`meeting-assistant-circles-reference.png`
- `tests/unit/meeting-assistant.mjs`
- `docs/deployment-cloudflare.md`（デプロイ手順）
