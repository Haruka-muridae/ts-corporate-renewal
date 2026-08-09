# ブラウザ検証ページ

`run.mjs` では確かめられないもの（CORS・Resumable Upload・Web Push）を、
実ブラウザで確認するためのページ。**検証専用で、配信物ではない。**

`public/` の外にあるため、`https://tsam-ai.com/` からは届かない。

## 開き方

`file://` では ES モジュールも Service Worker も動かない。HTTP で開く。

```powershell
py -m http.server 8010 --directory verification/pipeline/probes
```

<http://localhost:8010/> を開く。`localhost` は Secure Context 扱いなので
Web Push と Service Worker が動く。

**CORS の検証（T1-6）だけは `localhost` では意味がない。** 許可されるオリジンは
サービス側の設定で決まるため、**本番と同じオリジン**（Vercel のプレビューURL、
または `https://tsam-ai.com/`）で確認する必要がある。その場合はページを
一時的に `public/` 配下へ置いて確認し、**確認後に必ず消す**（`public/` は配信される）。

## 使うトークンについて

いずれのページも、検証用のアクセストークンを画面から手で貼る。

- **ページはトークンをどこにも保存しない。** リロードで消える
- 検証が終わったら、使ったトークンは失効させる
- **スクリーンショットにトークンを写さない。** results/ へ貼るときも同じ

## ページ一覧

| ファイル | 項目 | 何を見るか |
| --- | --- | --- |
| `cors-threads.html` | T1-6 | ブラウザ → Threads API が CORS で通るか |
| `resumable-upload-youtube.html` | T3-7 | ブラウザ → YouTube の Resumable Upload が通るか。中断・再開も |
| `web-push.html` | T6-5 | 許諾UI・指定時刻の発火・スリープ中の挙動 |
