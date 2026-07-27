# 将来拡張の受け口

このディレクトリには「まだ実装していないが、後から足せるようにしておく」ための
インターフェースだけを置く。既定では `src/config.js` の `FEATURE_FLAGS` がすべて
`false` のため、ここのコードは実行されない。

## 追加を想定している機能と、変更が必要な場所

| 機能 | 主な変更箇所 | 備考 |
| --- | --- | --- |
| Transformers.js による Embedding | `embedding.js` / `workers/embed.worker.js`（新規） | チャンク保存後に非同期で生成する。DriveへはアップロードしないIndexedDB専用テーブル `embeddings` を v3 で追加する |
| ベクトル検索 | `vector-search.js` | コサイン類似度を総当たりで計算。件数が増えたら近似最近傍へ差し替える |
| ハイブリッド検索 | `search/search-service.js` | MiniSearch のスコアとベクトル類似度を正規化して合成する |
| WebGPU ローカルLLM | `webgpu.js` | 非対応環境では `WEBGPU_UNSUPPORTED` を表示し、検索機能は従来どおり使えるようにする |
| Googleスプレッドシート | `sync/file-types.js` / `workers/parse.worker.js` | `files.export` で CSV を取得し、シート単位でチャンク化する |
| Googleスライド | 同上 | `text/plain` へのエクスポートに対応。スライド番号を heading に入れる |
| OCR | `workers/ocr.worker.js`（新規） | 画像PDF向け。ライブラリ追加は要確認 |
| 要約・回答生成 | `future/llm.js` | ローカルLLM前提。外部生成AI APIは使わない方針を維持する |
| PWA | `vite.config.js` / `manifest.webmanifest`（新規） | Service Worker を足す場合、CSP の `worker-src` を確認する |
| 複数ナレッジフォルダ | `db/db.js` v3 / `sync/sync-engine.js` | `files.folderId` は既にあるため、`settings.selectedFolder` を配列化する |

## 守るべき制約

- Google Drive へは書き込まない（抽出テキスト・Embedding・索引を含む）。
- 外部の生成AI APIへ本文を送らない。
- OAuthトークンをストレージへ保存しない。
- 追加ライブラリはバンドルへ同梱し、実行時に外部CDNから取得しない（CSPと整合させる）。
