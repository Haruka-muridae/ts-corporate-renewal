# 長時間録音モード（β）設計メモ

音声録音・MP3変換アプリに追加した「長時間録音モード」の設計と、MVPの範囲・制約をまとめる。通常録音モード（最大5分・MediaRecorder方式）は従来どおりで、本モードとは内部実装を分離している。

## 目的

Windows Chrome / Edge、Android Chrome、iPhone Safari で、最大60分の録音を可能な限り安定して行う。録音全体の PCM・MP3 をメモリに保持せず、音声は外部へ送信しない。

## 構成

```
getUserMedia → AudioContext → AudioWorklet(pcm-worklet.js)
  → main(long-recorder.js) → Worker(long-encoder-worker.js)
  → lamejs 逐次エンコード → OPFS(SyncAccessHandle) へ追記
停止時: flush → 確定 → File 取得 → プレビュー / 端末保存 → 一時ファイル削除
```

- `pcm-worklet.js` … PCM をモノラル化して約0.2秒ごとに送るだけ（重処理なし）。
- `long-encoder-worker.js` … Int16化・1152サンプル単位のMP3エンコード・OPFS書き込み・定期flush・停止時flush。
- `long-recorder.js` … オーケストレーション（マイク・AudioContext・Worklet・Worker・タイマー・監視・停止・破棄・解放）。
- `opfs-storage.js` … メインスレッド側のOPFS操作（estimate・起動時削除・File取得・削除）。
- `capabilities.js` … 対応環境判定と容量確認。

## 出力仕様

- モノラル / 96kbps
- 対応サンプルレート: 44,100Hz / 48,000Hz のみ（規格外は長時間モードを開始せず通常録音へ誘導。MVPではリサンプリングしない）
- 最大60分 / 55分で警告 / 60分自動停止

## 容量

- 96kbps MP3 は約 0.70MB/分、60分で約 42MB。
- 開始前に `navigator.storage.estimate()` で空きを確認し、150MB未満は開始しない。
- 録音中も約15秒ごとに確認し、安全下限（50MB）を割ったら自動停止して確定する。
- `estimate()` は推定値であり、実際に書き込める量と一致しない場合がある。

## メモリ

録音時間に依存せず一定。PCM は Worklet→Worker の約0.2秒ぶんのみ、MP3 は生成直後にOPFSへ書いて破棄する。Worker が追いつかない場合は未処理秒数を監視し、5秒でwarning、10秒で安全停止する。

## 一時ファイルの扱い（重要 / MVP方針）

- 録音中は OPFS の `recordings/rec-YYYYMMDD-HHmmss-<random>.mp3.part` へ逐次保存する。
- 正常停止時に確定し、保存または破棄の後に削除する。
- **異常終了（再読み込み・タブ強制終了・OSによる破棄など）で残った `.part` は、次回この画面を開いたときに `opfs-storage.js` の `cleanupStaleFiles()` が無条件で自動削除する。** 24時間の経過待ちはせず、起動時に即削除する。削除失敗は `console.warn` に記録し、通常利用は継続する。
- **MVPでは復旧機能を実装しない。** flush前のMP3が確実に再生できる保証がなく、デコーダ依存が大きいため、「復旧可能」と表示して利用者に過度な期待を与えないことを優先した。復旧UI・部分ファイル再生・起動時の復旧案内は持たない。

## プライバシー

- 通常録音: ブラウザ内（メモリ）でのみ処理。外部送信なし。
- 長時間録音: 外部送信なしは同じだが、録音中は端末内ストレージ（OPFS）へ一時保存する。保存完了/破棄後に削除。ブラウザのサイトデータ削除で消える場合がある。
- 通信は一切行わない（fetch / XHR / WebSocket / EventSource / sendBeacon / Google API / 解析 / 外部JS / CDN いずれもなし）。

## プラットフォーム制約

- iPhone Safari: 画面ロック・バックグラウンド・別アプリ・着信で録音は停止する。継続は保証しない。`AudioContext` の `suspended`/`interrupted` を検知したら確定・停止し、その時点までを保存可能にする。`visibilitychange` の非表示化は警告のみ（デスクトップは継続するため）。
- Android Chrome: 端末・省電力設定により停止する場合がある。同様に警告を表示。
- Screen Wake Lock API は今回は使用しない（画面を表示したまま使う注意書きで対応）。将来候補。

## 将来拡張（今回未実装）

録音途中からの復旧、Google Drive 保存、文字起こし、要約、話者分離、ノイズ除去、ビットレート選択、Wake Lock、PWA / Service Worker。
