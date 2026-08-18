# 詳細設計書の作成中に見つかった乖離・課題

起票: 2026年8月18日

[../instructions/2026-08-18-app-design-docs-handoff.md](../instructions/2026-08-18-app-design-docs-handoff.md) §11-3 に従い、
設計書を書く過程で見つかったものを1件1項目で積む。**この作業ではコードを直していない。**

重大度の基準:

| 重大度 | 意味 |
| --- | --- |
| 高 | 安全性（トークン・スコープ・送信先）に関わる。作業を止めて報告する |
| 中 | 実装と文書が食い違っている。どちらを直すか判断が要る |
| 低 | 文書間の不整合・記述漏れ。実害は無いが放置すると判断を誤らせる |

---

## #1 Transformers.js（jsDelivr / Hugging Face）が外部依存の承認記録に無い

| 項目 | 内容 |
| --- | --- |
| 重大度 | 低 |
| 該当 | [../external-dependency-approvals.md](../external-dependency-approvals.md) §1 の表 |
| 根拠 | `public/production-app/audio-transcriber/config.js` の `WHISPER.libraryUrl` と `whisper-worker.js` の動的 import が `https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/…` を指す。上位文書 [../specs/audio-transcriber-requirements-v1.md](../specs/audio-transcriber-requirements-v1.md) には外部通信・CSP の表として記載があるが、承認記録の表には行が無い |
| 影響 | 次の作業者が「これは承認済みなのか」を判断できない。承認記録はまさにその判断のために作られた文書である |
| 提案 | 承認記録へ1行足す（承認日は当時の記録を確認して埋める。**推測で日付を書かない**） |

---

## #2 `docs/specs/README.md` の版と各文書本文の版が食い違う

| 項目 | 内容 |
| --- | --- |
| 重大度 | 低 |
| 該当 | [../specs/README.md](../specs/README.md) の一覧表 |
| 根拠 | `audio-transcriber-requirements-v1.md`（表 v1.1 / 本文 1.3）、`meeting-minutes-requirements-v1.md`（v1.0 / v1.1）、`note-post-requirements-v1.md`（v1.0 / v1.1）、`short-script-spec-v1.md`（v1.4 / 1.5） |
| 影響 | 一覧を見て「最新を読んだ」と誤認する |
| 提案 | 一覧表を本文に合わせる（本文が正）。設計書のコミットとは分けて行う |
| 状態 | **対応済み（2026-08-18）。** 一覧表を本文の版（v1.5 / v1.3 / v1.1 / v1.1）に合わせた |

---

## #3 `receipt-ocr` の既知の未反映7件が残っている

| 項目 | 内容 |
| --- | --- |
| 重大度 | 中 |
| 該当 | `public/production-app/receipt-ocr/`（とくに `oauth.js`） |
| 根拠 | [../receipt-ocr-findings-20260804.md](../receipt-ocr-findings-20260804.md)。`card-ocr` のフェーズ0で直した内容が未反映と記録されている。`card-ocr/gis-loader.js` の冒頭コメントは「`receipt-ocr` の `oauth.js` は現にそうなっている（#1）。同じ形にしない」と名指ししている |
| 影響 | #1（失敗した Promise をキャッシュし続ける）は、**一度連携に失敗すると再試行しても直らない**状態を作る。案内が「もう一度お試しください」でも、そのとおりにして直らない |
| 提案 | 設計書の作成とは別作業として、7件の現状を確認し、直すか「直さない理由」を記録する。**この作業ではコードを変更していない** |

---

## #4 `short-script` の動画生成リクエストで尺が 30 に固定されている

| 項目 | 内容 |
| --- | --- |
| 重大度 | 中（**補助サービス側の実装しだいで低にも高にもなる**） |
| 該当 | `public/production-app/short-script/companion.js` の `renderVideo()` |
| 根拠 | リクエスト本文の組み立てに `duration: 30` がリテラルで書かれている。呼び出し側（`app.js`）は `currentScript`（`durationSec` に 30 または 60 を持つ）を渡しているが、`renderVideo()` はその値を読んでいない。`config.js` の `DURATIONS` は `[30, 60]` |
| 影響 | 画面で 60 秒を選んでも、補助サービスへは 30 が渡る。台本の中身（シーン数と各シーンの秒数）は 60 秒ぶんで作られているため、**補助サービスがこの `duration` をどう使うかによって、動画が途中で切れる／無視されて台本どおりになる、のどちらにもなりうる** |
| 確認できていないこと | ai-video-app は**このリポジトリの外**にあり、`duration` の用途を確認できていない。無視される値であれば実害は無い |
| 提案 | 補助サービス側の仕様を確認したうえで、`script.durationSec ?? 30` を渡すか、送らないかを決める。**この作業ではコードを変更していない** |
