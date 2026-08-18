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
