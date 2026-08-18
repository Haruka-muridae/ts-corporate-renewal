# 面談録音アプリ 要件定義書

- バージョン: v1.0
- 作成日: 2026年8月18日
- 最終改訂: 2026年8月18日
- ステータス: 実装済み(v1.0)

## 改訂履歴

| 版 | 日付 | 内容 |
| --- | --- | --- |
| v1.0 | 2026-08-18 | 初版。スタンドアロン版 interview-recorder（単体公開版）を Portal 配下の本番アプリへ移植した要件を定義 |

## §1 目的と位置づけ

### §1-1 目的

本アプリは、オンライン面談（Web会議）の音声を、ブラウザだけで録音するPortalアプリである。

タブ音声共有とマイクをその場でミックスし、MP3へ逐次エンコードしてから利用者の端末へダウンロードさせる。録音データを当社サーバーへ一切送信しない点、および録音前に相手への通告・同意確認を必須とする点が、本アプリの中心的な設計方針である。

### §1-2 移植元との関係

本アプリは、単体公開版として先行運用していた interview-recorder リポジトリ（`/home/yuki9/projects/interview-recorder/public/`）を、TSAM AI Portal 配下の本番アプリとして移植したものである。

- 録音同意モーダル・タブ音声＋マイクのミックス・MP3逐次エンコード（WebM安全網付き）・ローカルダウンロードという状態機械（idle / capture-guide / no-tab-audio / recording / done）は移植元と同一であり、変更していない。
- 移植で追加したのは、guardPage によるログイン確認、CSP、Portal導線（フッターの「ポータルへ戻る」）のみである。
- 移植元リポジトリはこの移植によって変更されない。

### §1-3 アプリ基本情報

| 項目 | 定め |
| --- | --- |
| アプリID | interview-recorder |
| 表示名 | 面談録音 |
| 配置先 | public/production-app/interview-recorder/ |
| Portalのhref | production-app/interview-recorder/ |
| アイコン | 録 |
| UI言語 | 日本語 |
| 対象利用者 | TSAM AI Portalへ有効なアカウントでログインした利用者 |
| 実行方式 | 静的ホスティング、ブラウザ内処理のみ（完全クライアントサイド、外部送信なし） |

## §2 スコープ

### §2-1 含む機能

- 録音前の同意確認モーダル（通告・同意の明示確認）
- `getDisplayMedia` によるタブ音声＋動画の共有取得（動画は保存しない）
- タブ音声が無い場合の警告画面とマイクのみでの続行
- タブ音声とマイクの AudioContext 上でのミックス
- MediaRecorder による WebM 録音（安全網）
- AudioWorklet + lamejs によるリアルタイム MP3 逐次エンコード（既定の保存形式）
- 録音結果（MP3、MP3が作れない場合はWebM）と記録情報（JSON）のローカルダウンロード
- 離脱確認（beforeunload）による未保存録音の保護

### §2-2 含まない機能

- 録音データ・記録情報の当社サーバーまたは外部サービスへの送信
- Google Drive 等への自動保存（voice-recorder アプリとは独立した機能である）
- 文字起こし・議事録生成（audio-transcriber / meeting-minutes へは自動連携しない）
- 複数トラックの個別録音、話者分離
- モバイル・タブレット向けの `getDisplayMedia` 対応（非対応ブラウザでは開始ボタンを無効化する）

## §3 同意確認ゲート仕様

- 開始画面で「録音を開始」を押すと、録音同意モーダルを表示する。
- モーダルの確認文言は「面談相手に、録音することを通告しましたか？」とする。
- 「はい、通告して同意を得ました」を選んだ場合のみ、音声キャプチャ手順（画面共有ダイアログ）へ進む。
- 「いいえ、まだです」を選んだ場合、録音は開始できない旨の案内を表示し、録音フローへは進まない。
- 背景クリックまたは Esc キーでモーダルを閉じられるが、いずれも「はい」として扱わない。
- 同意確認の日時（`consentConfirmedAt`、ISO 8601）を録音セッションのメタデータとして保持し、結果画面と記録情報（JSON）ダウンロードの両方に記録する。
- この同意確認は当社サーバーへの通告記録ではなく、利用者の自己申告に基づくローカルなゲートである。相手への実際の通告・同意取得責任は利用者にある（`legal.html` §2 を参照）。

## §4 録音方式

| 項目 | 仕様 |
| --- | --- |
| 音源 | タブ音声（`getDisplayMedia` の audio track）＋マイク（`getUserMedia`） |
| ミックス | Web Audio API（`AudioContext`）上で各ソースにゲイン（既定 0.7）をかけてから加算 |
| 主形式 | MP3（lamejs、既定ビットレート 64kbps）。AudioWorklet で PCM を逐次取得し、1152サンプル×8（約0.21秒）ごとにエンコードする |
| 安全網 | MediaRecorder による WebM（`audio/webm;codecs=opus` 優先）を並行して録音し、MP3生成に失敗した場合はWebMを既定の保存形式にする |
| タブ音声が無い場合 | マイクのみでの続行を選べる。結果画面にその旨の警告を残す |
| マイクが拒否された場合 | タブ音声のみで続行できる。タブ音声も無い場合は録音を開始しない |
| 停止 | 「録音を停止」操作、または共有停止バーからのタブ共有終了 |
| 出力ファイル名 | `面談録音_YYYYMMDD_HHMMSS.{mp3\|webm\|json}` |

## §5 完全クライアントサイド・データ非送信

- 録音データ（音声）、記録情報（JSON）、同意確認の日時を含む一切のデータを、当社サーバーまたは外部サービスへ送信しない。
- 保存は利用者自身の操作によるローカルダウンロードのみで完結する。
- Cookie・アクセス解析（アナリティクス）を使用しない。
- 唯一の通信は、Portal共通の認証確認（guardPage によるセッション検証。§6参照）である。

## §6 認証・画面ガード

ページロード時に次を実行する（他の本番アプリと同じ約束）。

```js
import { guardPage } from '../../auth/session.js';
import { setScreenDepth } from '../../auth/config.js';
import { SCREEN_DEPTH } from './config.js';

setScreenDepth(SCREEN_DEPTH);   // production-app/interview-recorder/ は深さ2

async function init() {
  const user = await guardPage();
  if (!user) return;            // すでにログイン画面へ遷移している
  el.authLoading.hidden = true;
  el.appMain.hidden = false;
  // ここから既存の初期化（開始画面の機能検出表示など）
}
init();
```

- 認証確認が完了するまで、`#app-main`（アプリ本体）を描画しない。`#auth-loading` のみを表示する。
- 無効な場合はローカルの認証セッションを消去し、`/login/?next=portal` へ遷移する。
- URLへの直接アクセスでも同じ確認を行う。
- 録音同意モーダル・状態機械・録音／MP3エンコード処理は、この認証ガードとは独立して変更していない。

## §7 CSP（Content-Security-Policy）

```
default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self';
img-src 'self' data:; media-src 'self' blob:;
connect-src 'self' https://auth-verify.potenitas-lp.workers.dev;
object-src 'none'; base-uri 'none'; form-action 'none'
```

- `connect-src` は `auth-verify.potenitas-lp.workers.dev`（guardPage のセッション検証の宛先）のみを許可する。本アプリは録音・記録情報を外部送信しないため、`script.google.com` 等の認証系エンドポイントや `generativelanguage.googleapis.com` 等のAI APIは許可に含めない。
- `worker-src 'self'` は AudioWorklet（`pcm-capture-worklet.js`）の読み込みに必要。
- `media-src 'self' blob:` は録音結果の `<audio>` 再生（`URL.createObjectURL` によるblob URL）に必要。
- `script-src 'self'` のみで、インラインスクリプトは使用しない。lamejs（`vendor/lamejs/lame.min.js`）は非moduleスクリプトとして `app.js` より先に読み込む。

## §8 同梱ライブラリ（lamejs）

- MP3エンコードには [lamejs](https://github.com/zhuker/lamejs)（バージョン1.2.1、LGPL）を改変せず同梱する。
- 配置先: `public/production-app/interview-recorder/vendor/lamejs/`（`lame.min.js` / `LICENSE` / `COPYING`）。
- ライセンス全文へのリンクを `legal.html` に掲載する。

## §9 Portal登録要件

`public/portal/app-registry.js` に次の形式で追加する。

```js
Object.freeze({
  id: 'interview-recorder',
  name: '面談録音',
  href: 'production-app/interview-recorder/',
  icon: '録',
}),
```

- id は公開後に変更しない。
- href の先頭に `/` を付けない。
- 既存の `tsam-app-layout` の配置データを壊さない。

## §10 テスト

### §10-1 テスト配置

- テストID: interview-recorder
- 配置: `tests/unit/interview-recorder.mjs`
- 単一実行: `node tests/run.mjs interview-recorder`
- 全体実行: `node tests/run.mjs unit`

### §10-2 単体テストで見る範囲

`config.js` の公開値（純粋な定数・Node から直接importできる範囲）のみを対象にする。

- `SCREEN_DEPTH === 2`
- `MP3_BITRATE_KBPS === 64`
- `PCM_FLUSH_SAMPLES` が1152の倍数であること（MP3の1フレーム単位）
- `MP3_WORKLET_URL` が同一オリジンの相対パスであること
- `MIX_SOURCE_GAIN` が0より大きく1以下であること

`app.js` は `document` / `navigator.mediaDevices` / `AudioWorklet` 等の実ブラウザ機能に強く依存するため、Node環境でのユニットテスト対象にしない。状態機械（idle / capture-guide / no-tab-audio / recording / done）と同意ゲートの動作確認は、実ブラウザでの手動確認に委ねる。

### §10-3 実機確認（リリース前）

- Portalグリッドに「面談録音」が表示される
- Portalからアプリを開ける（未ログイン時はログイン画面へ遷移する）
- 「いいえ」を選ぶと録音を開始できない
- タブ音声＋マイクで録音し、MP3としてダウンロードできる
- タブ音声を共有しない場合の警告とマイクのみ続行ができる
- AudioWorklet非対応環境相当（MP3生成失敗）でもWebMで録音が完了する
- 記録情報（JSON）に同意確認日時が含まれる

## §11 既知の制約

- モバイル・タブレットのブラウザでは `getDisplayMedia` が使えず、録音を開始できない場合がある（開始ボタンが無効化され、案内が表示される）。
- 同意確認はローカルなゲートであり、相手への実際の通告・同意取得の適法性は利用者自身の責任である。
- 当社サーバーにデータを保存しないため、端末をまたいだ録音の共有・復旧は提供しない。
