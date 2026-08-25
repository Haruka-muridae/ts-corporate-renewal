# Meeting Assistant ブラウザ版（PC / スマートフォン PWA）v1

作成: 2026-08-25
対象: `public/meeting-assistant/`（配信 URL: `https://tsam-ai.com/meeting-assistant/`）

## 0. 現在地

- スマートフォンネイティブ版（`mobile/meeting-assistant/`、Capacitor + Android Foreground Service + iOS AVAudioRecorder）の開発は **一旦停止**。コードは削除・変更せず、将来再開できる状態で保持する。
- 今後は **ブラウザ版を優先**して完成させる。PC とスマートフォンのブラウザ / PWA から同じ Meeting Assistant を使えることが目的。

## 1. 対象機能

| 機能 | PC ブラウザ | スマートフォンブラウザ / PWA |
| --- | --- | --- |
| On-site 録音（マイク） | ○ | ○ |
| Remote 録音（会議タブ音声 + マイク） | ○ | **表示しない**（`platform.js` の判定でホームの円を隠し、`#online` 直打ちもホームへ戻す） |
| Drive から音声を選ぶ | ○ | ○ |
| 過去の議事録 | ○ | ○ |
| 設定（Google Drive 連携 / Gemini API キー / 対応種別） | ○ | ○ |
| Google Drive 保存（Potenitas voice / record） | ○ | ○ |
| Gemini 連携（文字起こし・議事録） | ○ | ○ |
| Markdown 保存 | ○ | ○ |
| PC 最前面表示（Document PiP） | ○ | 非対応ブラウザでは非表示 |

**保証しないこと（現フェーズ）**: スマートフォンでの画面 OFF 録音・完全バックグラウンド録音。
画面が消えたり他アプリへ切り替えたりすると録音は止まり得る。止まった場合も、そこまでの録音は端末（OPFS）に残り、Drive へ保存できる（§3）。

## 2. 端末判定と画面（`platform.js`）

- `isMobileBrowser()`: `navigator.userAgentData.mobile` → UA 文字列 → iPadOS（Macintosh UA + タッチ）の順で判定。
- `isStandaloneDisplay()`: ホーム画面に追加した PWA か（`navigator.standalone` / `display-mode: standalone`）。
- `canOfferRemote({ native, mobile, canCaptureTab })`: Remote 円を出すか。ネイティブ・スマートフォンでは出さない。
- `body` に `ma-no-remote` / `ma-mobile` / `ma-standalone` / `ma-native` を付け、CSS で 2 円レイアウト（On-site と Drive を横に並べて少し重ねる）へ切り替える。

ホーム画面は設計指示書（`docs/specs/assets/meeting-assistant/meeting-assistant-design.png`、円の参考図 `meeting-assistant-circles-reference.png`）どおり、設定リンクは左上、3 つの円は少し重なる配置、その下に「過去の議事録 ›」。背景は純白。説明文は出さない（既存決定）。

Safe Area: `viewport-fit=cover` + `env(safe-area-inset-*)` を `.vr-main` の全辺 padding に加算。入力欄は 16px 以上（iOS のフォーカス時拡大を防ぐ）。

## 3. 録音の確定と保存待ち台帳（`pending-store.js`）

録音の確定は「録音停止」ボタン以外でも起きる（90 分上限・中断・空き容量不足・処理遅延・マイク切断）。すべて `Recorder` の `onFinalized` に集約し、次の順で扱う。

1. 確定ファイル（OPFS の `rec-….mp3.part`）を **保存待ち台帳**（`localStorage` の `meeting-assistant-pending`、ネイティブ版の Checkpoint と同じ形）に載せる。音声データやトークンは台帳に入れない。
2. Google 連携済み（トークン有効）なら、そのまま Drive へアップロード → 台帳と OPFS から削除 → 文字起こし・議事録へ。
3. 未連携なら台帳に残してホームへ戻す。ホームの「未アップロードの録音があります」から **「Driveへ保存」**（利用者の押下＝ポップアップを開ける文脈）で連携してから保存する。失敗した行は「前回の保存に失敗」と表示し「Driveへ再送」になる。「破棄」で端末から削除できる。
4. 起動時の OPFS 掃除（`cleanupStaleFiles`）は台帳に載っているファイルを残し、それ以外の `.part` だけ消す。台帳にあるのに OPFS に無い行は落とす。

補助:

- **録音開始の押下で先に Google 連携**する（`connectBeforeRecording`）。停止処理のあとでは利用者操作の猶予が切れてポップアップが阻止されるため。断られても録音は始め、そのセッション中は再要求しない。
- **Screen Wake Lock**（`wake-lock.js`）: 録音中は画面の自動消灯を抑える。取得できなくても録音は続ける。画面 OFF 録音を可能にするものではない。
- **AudioContext の `resume()`**（`recorder/recorder.js`）: iOS Safari で suspended のまま無音録音になるのを防ぐ。

## 4. Google 認証（`oauth.js`）

| 方式 | 使うとき | 仕組み |
| --- | --- | --- |
| ポップアップ（既定） | PC / 通常のスマートフォンブラウザ | Google Identity Services のトークンクライアント。起動時に GIS を先読み（`preloadGis`）。 |
| リダイレクト | standalone PWA、またはポップアップが開けなかったとき（`config.js` の `OAUTH.redirectFallback`） | 同じ画面を `accounts.google.com/o/oauth2/v2/auth`（`response_type=token`）へ遷移させ、戻り URL の fragment からトークンを受け取る。 |

リダイレクト方式の安全策:

- `state`（乱数 16 バイト）を `sessionStorage` に置いて往復を突き合わせる。不一致・往路の記録なし・10 分超過は捨てる。
- fragment は受け取った直後に `history.replaceState` で URL から消す。トークンはメモリだけ（従来どおり）。
- 往路に預けるのは再開先（画面名・保存待ち録音の ID）だけ。戻ったら自動で続きを行う。
- スコープは `drive.file` のみ。client secret / refresh token は使わない。

### ユーザー作業（Google Cloud Console）

リダイレクト方式を使うには、既存の OAuth クライアント（`config.js` の `OAUTH.clientId`）に次を追加する。

- **承認済みのリダイレクト URI**: `https://tsam-ai.com/meeting-assistant/`
  （ローカル確認用に `http://localhost:8788/meeting-assistant/` 等も必要なら追加）

未登録のまま standalone PWA で連携すると Google 側で `redirect_uri_mismatch` のエラー画面になる（トークンは発行されないため漏えいはしない）。通常のブラウザタブでは従来のポップアップ方式なので、この登録が無くても使える。

## 5. テスト

- `tests/unit/meeting-assistant.mjs`（`~/dev/node22/bin/node tests/run.mjs meeting-assistant`）
  - 環境判定 / Remote 非表示 / 2 円レイアウト / Safe Area
  - OAuth リダイレクト: 認可 URL・fragment 解析・state 突き合わせ・古い往復の破棄・トークンを保存しない
  - 保存待ち台帳: 追加・失敗上書き・削除・上限・壊れた JSON・localStorage 無し
- Gemini API の実テストは行わない（要件）。

## 6. 実機で確認すること（未実施）

- iPhone Safari / ホーム画面追加 PWA: 録音開始→停止→Drive 保存、リダイレクト認証の往復、Safe Area。
- Android Chrome / PWA: 同上。Wake Lock の効き。
- PC Chrome / Edge: 90 分上限での自動停止後に Drive 保存されること（従来は失われていた）。
- 未連携で録音→ホームの「Driveへ保存」→処理画面まで進むこと。
