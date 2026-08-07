# 本番配信構成の調査レポート

調査日: 2026年8月7日／読み取りのみ（設定変更は一切行っていない）

このレポートの目的は、LP を配信するための正しい配置場所と公開後のURLを確定させること。

---

## 結論（先に書く）

| | 結論 | 確信度 |
| --- | --- | --- |
| **結論①: 正しい配置場所** | **`public/labs/personal-ai-training/` へ移設が必要**（現状の `labs/` のままでは配信されない） | 確定 |
| **結論②: 公開後のURL** | **`https://tsam-ai.com/labs/personal-ai-training/`** | 確定 |

**ただし、この2つとは別に、指示書の前提と実態が食い違う点が1つある。**

> ### ⚠️ `main` へのマージは公開ではない
>
> 本番（`tsam-ai.com`）は Cloudflare Workers が配信しており、**Git 連携も自動ビルドも
> 設定されていない。** 公開は `npm run deploy`（wrangler）の手動実行でのみ起きる。
> したがって「マージすれば数分後に本番へ出る」は成立しない。詳細は §4。

---

## 1. 収集した証拠

### 1-1. リポジトリ内の配信設定

| 確認対象 | 結果 |
| --- | --- |
| `CNAME` | **存在しない。** 作業ツリーにも `origin/main` にも無い。コミット `8565042 Delete CNAME` で削除済み |
| `.github/workflows/` | `test.yml`（`npm test` のみ）と `nextjs.yml.disabled`（**無効化された** Pages 用の残骸）の2つだけ。**デプロイを行うワークフローは存在しない** |
| `next.config.ts` | `basePath` 無し。`output: "export"` 無し。`trailingSlash: true`。`rewrites().fallback` で `/:path*/` → `/:path*/index.html` |
| `origin/main` の `package.json` | scripts に **`deploy` / `build:cf` / `preview` が無い**。devDependencies に `wrangler` / `@opennextjs/cloudflare` も無い |
| `origin/main` の `wrangler.jsonc` / `open-next.config.ts` | **存在しない**（未マージの `feat/voice-recorder` ブランチにのみ在る） |
| `vercel.json` | 存在しない |

### 1-2. 配信ヘッダーの実測（`curl -sI`）

```
$ curl -sI https://tsam-ai.com/
HTTP/1.1 200 OK
Server: cloudflare
CF-RAY: a274a87c0b38deb7-NRT
CF-Cache-Status: HIT
Cache-Control: public, max-age=0, must-revalidate

$ curl -sI https://tsam-ai.com/event/apply/
HTTP/1.1 200 OK
x-opennext: 1                 ← OpenNext。Vercel はこのヘッダーを出さない
x-powered-by: Next.js
Server: cloudflare
```

- `x-github-request-id`（GitHub Pages）は **出ていない**
- `x-vercel-id` / `x-vercel-cache`（Vercel）も **出ていない**
- 決め手は `x-opennext: 1`。OpenNext は Next.js を Vercel 以外へ載せるための仕組み

### 1-3. 配信ルートが `public/` であることの実測

同じドメインに対して、リポジトリのどのパスが届くかを引いた。

| URL | 応答 | リポジトリ上の実体 |
| --- | --- | --- |
| `https://tsam-ai.com/apps/` | **200** | `public/apps/` |
| `https://tsam-ai.com/production-app/receipt-ocr/` | **200** | `public/production-app/receipt-ocr/` |
| `https://tsam-ai.com/event/` | **200** | `public/event/` |
| `https://tsam-ai.com/docs/repository-structure.md` | **404** | `docs/`（`public/` の外） |
| `https://tsam-ai.com/README.md` | **404** | ルート（`public/` の外） |
| `https://tsam-ai.com/AGENTS.md` | **404** | ルート（`public/` の外） |
| `https://tsam-ai.com/labs/personal-ai-training/` | **404** | `labs/`（`public/` の外） |

**`public/` の中は届き、外は届かない。** 配信ルートはリポジトリのルートではなく `public/` である。

`/apps/` と `/production-app/receipt-ocr/` がどちらも末尾スラッシュのディレクトリURLで
200 を返している事実から、`next.config.ts` の fallback rewrite が
`public/<パス>/index.html` を解決できることも確認できる。**LP を
`public/labs/personal-ai-training/` へ置けば、同じ経路で
`https://tsam-ai.com/labs/personal-ai-training/` が 200 になる。**

---

## 2. GitHub Pages について（指示書が懸念していた点）

指示書は「過去の運用では GitHub Pages が main のルートを丸ごと配信していた」ことを
懸念していた。**この懸念は部分的に当たっている。**

```
$ gh api repos/Haruka-muridae/ts-corporate-renewal/pages
{
  "status": "errored",
  "cname": null,
  "html_url": "https://haruka-muridae.github.io/ts-corporate-renewal/",
  "build_type": "legacy",
  "source": { "branch": "main", "path": "/" },
  "public": true,
  "https_enforced": true
}
```

**GitHub Pages は無効化されていない。** `main` の**ルート**を配信する設定のまま残っている。
実際に github.io ドメインを引くと、リポジトリのルートが公開されている。

| URL | 応答 |
| --- | --- |
| `https://haruka-muridae.github.io/ts-corporate-renewal/` | **200** |
| `.../ts-corporate-renewal/README.md` | **200** ← ルートが配信されている |
| `.../ts-corporate-renewal/docs/repository-structure.md` | **200** ← `docs/` も見える |
| `.../ts-corporate-renewal/public/index.html` | **200** |
| `.../ts-corporate-renewal/labs/` | 404（最後に成功したビルドに存在しないため） |
| `.../ts-corporate-renewal/apps/` | 404（ルート配信なので `public/apps/` が正しいパス） |

最新ビルドは失敗している。

```
$ gh api repos/.../pages/builds/latest
status:  errored
error:   Page build failed.
created: 2026-08-06T15:11:59Z   updated: 2026-08-06T15:23:32Z
```

### ここから言えること

1. **`cname` が `null` なので、GitHub Pages は `tsam-ai.com` を配信していない。**
   配信先は `haruka-muridae.github.io` のみ。したがって**結論①②は影響を受けない。**
2. ただし **`labs/` を `main` へマージすると、Pages のビルドが復旧した時点で
   `https://haruka-muridae.github.io/ts-corporate-renewal/labs/personal-ai-training/`
   として公開されうる。** 現在ビルドが失敗しているため即座には出ないが、
   「出ない保証」ではない。
3. これは LP に限った話ではなく、**`docs/` や `README.md` が現に github.io で
   読める**という既存の状態でもある（本調査で新たに判明した事実。本レポートでは
   状態の記録に留め、設定変更は行わない）。

---

## 3. 前回報告の「`public/` の外は Web に出ない」の根拠

**推測ではなく、リポジトリ内の文書に基づく記述だった。** 出典は次の2つ。

- [docs/repository-structure.md](../../docs/repository-structure.md) §1 の「配信しないもの ─
  `gas-auth/` `tests/` `docs/` `supabase/` `lp-draft/` … `public/` の外にあるため
  Web からは届かない」
- [DEPLOYMENT.md](../../DEPLOYMENT.md) の「配信されないもの」節（同趣旨）

**この記述は `tsam-ai.com` については正しい**（§1-3 の実測で確認）。両文書とも Vercel を
前提に書かれているが、Cloudflare へ移った後も配信ルートが `public/` である点は変わって
いないため、結論としては生き残っている。

**ただし github.io ドメインについては誤り。** 両文書は「リポジトリは公開されているため
GitHub 上では読める」とは書いているが、**GitHub Pages が今も生きていて Web からも
読める**ことには触れていない。前回報告もこの点を見落としていた。

---

## 4. 「マージ＝公開」は成立しない

配信は Cloudflare Workers が行い、**Git 連携も自動ビルドも設定されていない。**

| | Vercel 時代（〜2026-08-05） | 現在（2026-08-06〜） |
| --- | --- | --- |
| 公開の起点 | `main` への push | **`npm run deploy` の手動実行のみ** |
| GitHub Actions | デプロイに不関与 | 同じく不関与 |
| 切り戻し | `git revert` して push | Cloudflare 側の Rollback 操作 |

出典: [docs/deployment-cloudflare.md](../../docs/deployment-cloudflare.md)（`feat/voice-recorder`
ブランチにある。`origin/main` にはまだ無い）。Cloudflare のダッシュボード上、
稼働中の版はすべて `Manually deployed / Wrangler by architect` と記録されている。

### `origin/main` からデプロイできるようになった（調査中に変化した）

調査を始めた時点では、デプロイに必要な次の3点が未マージの `feat/voice-recorder`
ブランチにしか無く、`origin/main` からは `npm run deploy` を実行できなかった。

- `package.json` の `deploy` / `build:cf` スクリプト
- `wrangler.jsonc`（Worker 名・アカウント・ルート・`vars` 4件）
- `open-next.config.ts`

**この状態は本作業中に解消した。** 2026-08-07、オーナーが PR #41
（`merge: ブラウザ完結の録音アプリと Cloudflare デプロイ構成`、コミット `2c417cc`）を
`main` へマージしたため、現在は `main` に3点とも揃っている。

したがって **`main` から `npm run deploy` を実行すれば公開できる状態にある。**
ただし実行そのものは行っていない（§4 のとおりマージは公開ではなく、
デプロイはオーナーの操作）。

> **⚠️ この結果、次の `npm run deploy` は録音アプリと LP を同時に公開する。**
> [REENTRY.md](../../REENTRY.md) 手順4 は「まず今と同じ内容を出して、本番が
> 変わらないことを確かめる」検証デプロイを想定しているが、`main` には既に
> 録音アプリと LP の両方が入っているため、**その検証デプロイの時点で両方が出る。**
> 「本番が変わらないことを確かめる」という前提はもう成立しない。
> LP は `noindex` かつどこからもリンクしていないため実害は小さいが、
> 手順4のチェック項目（`/production-app/voice-recorder/` がまだ 404 のはず）は
> 期待値が変わっている点に注意すること。

---

## 5. 判定できなかったこと

無し。結論①②はいずれも実測に基づいて確定している。

---

## 6. オーナーが画面で確認すべきこと

コマンドラインからは確認できず、判断がオーナー側にある項目。

- [ ] **GitHub → Settings → Pages** … Pages を今も使う意図があるか。
      使わないなら無効化する（ビルドは 2026-08-06 から失敗し続けている）。
      有効のまま放置すると、ビルド復旧時に `main` のルートが
      `haruka-muridae.github.io` で公開される
- [ ] **Cloudflare → Workers & Pages → `ts-corporate-renewal` → Settings → Builds**
      … Git 連携を今後入れるのか、手動デプロイのままにするのか
- [ ] **`feat/voice-recorder` のマージ時期** … これが `main` に入るまで、
      `main` からのデプロイはできない

---

関連: [docs/deployment-cloudflare.md](../../docs/deployment-cloudflare.md)（現行構成の正） /
[DEPLOYMENT.md](../../DEPLOYMENT.md)・[docs/repository-structure.md](../../docs/repository-structure.md)（Vercel 前提のまま・要更新）
