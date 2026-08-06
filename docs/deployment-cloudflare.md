# デプロイ手順（Cloudflare Workers + OpenNext）

制定: 2026年8月6日

**現行の本番配信はこの文書が正である。** [DEPLOYMENT.md](../DEPLOYMENT.md) と
[production-cutover.md](./production-cutover.md) は Vercel 前提のままで、内容が古い。

---

## ⚠️ 最初に：マージは公開ではない

**`main` へマージしても本番は変わらない。**

Vercel 時代は Git 連携による自動デプロイだったため「`main` へマージ＝公開」だった。
Cloudflare へ移行した現在、Git 連携も自動ビルドも設定されていない。

| | Vercel 時代 | 現在 |
| --- | --- | --- |
| 公開の起点 | `main` への push | **`npm run deploy` の手動実行のみ** |
| GitHub Actions | デプロイに不関与 | 同じく不関与（[test.yml](../.github/workflows/test.yml) はテストのみ） |
| 切り戻し | `git revert` して push | **Cloudflare 側の操作**（後述） |

裏を返すと、**マージしたまま誰もデプロイしなければ、本番は古いまま残る。**
リリースの完了は「マージした」ではなく「デプロイして確認した」で判定すること。

---

## 1. 現行構成

```
[ブラウザ] → Cloudflare（プロキシ・エッジキャッシュ）
                  ↓
            Worker: ts-corporate-renewal
              ├ Workers Assets … public/ 配下の静的ファイル（540ファイル）
              └ OpenNext ランタイム … Next.js（app/event/ のみ）
```

| 項目 | 値 |
| --- | --- |
| プラットフォーム | Cloudflare Workers |
| Worker 名 | `ts-corporate-renewal` |
| アカウントID | `4a71eb14d3889124d4afedd48c1458d8` |
| ドメイン | `tsam-ai.com` |
| Next.js の載せ方 | [OpenNext](https://opennext.js.org/cloudflare)（`@opennextjs/cloudflare`） |
| DNS | Cloudflare（**プロキシはオン**） |

### 判定の根拠（2026-08-06 実測）

```
$ curl -sI https://tsam-ai.com/
Server: cloudflare
CF-RAY: a26db0414dded5c2-NRT
CF-Cache-Status: HIT          ← プロキシを通っている

$ curl -sI https://tsam-ai.com/event/apply/
x-opennext: 1                 ← OpenNext。Vercel はこれを出さない
x-powered-by: Next.js
```

`x-vercel-id` / `x-vercel-cache` は静的パス・Next.js ルート・404 のいずれにも無い。
`x-opennext` が決め手で、OpenNext は Vercel 以外へ載せるときに使う仕組みである。

### ダッシュボードの実測

Cloudflare の Versions に `Manually deployed / Wrangler by architect` と記録されている。
**Git 連携も自動ビルドも設定されていない。**

### この設定は「後から起こした」ものである

移行時（2026-08-06）のデプロイは**別マシン**から行われ、そのときの `wrangler.jsonc` /
`open-next.config.ts` はリポジトリに入っていなかった。このPC上を調査したが、
設定ファイル・コマンド履歴・wrangler の痕跡は一切見つからなかった
（Node.js 自体、同日14:07に初めてインストールされている）。

いま入っている [wrangler.jsonc](../wrangler.jsonc) と [open-next.config.ts](../open-next.config.ts) は、
**稼働中の Worker の設定を推定して書き起こしたもの**である。一致している保証はない。
初回デプロイ前に §3 の突き合わせを必ず行うこと。

---

## 2. 新しいマシンでの再現手順

```powershell
# 1. 取得
git clone https://github.com/Haruka-muridae/ts-corporate-renewal.git
cd ts-corporate-renewal
npm ci

# 2. Cloudflare へログイン（ブラウザが開く。対話が必要）
npx wrangler login

# 3. 認証と対象アカウントの確認
npx wrangler whoami
#   → Account ID が 4a71eb14d3889124d4afedd48c1458d8 であること

# 4. ビルドだけ試す（デプロイはしない）
npm run build:cf
```

### ⚠️ Windows では警告が出る

`npm run build:cf` は Windows でも**通る**が、OpenNext 自身がこう警告する。

```
WARN OpenNext is not fully compatible with Windows.
WARN For optimal performance, it is recommended to use Windows Subsystem for Linux (WSL).
WARN While OpenNext may function on Windows, it could encounter unpredictable failures during runtime.
```

2026-08-06 時点では Windows 上でビルドが成功し、成果物（`worker.js` と assets 540ファイル）も
正しく生成されている。ただし**「実行時に予測できない失敗が起こりうる」と作者が言っている**以上、
本番デプロイは WSL か Linux/macOS から行うほうが安全である。

Windows から出す場合は、デプロイ後の確認（§5）を省略しないこと。

---

## 3. デプロイ前チェック

**初回は必ず全部消化すること。** 2回目以降は「毎回」の項だけでよい。

### 初回だけ（稼働中の Worker との突き合わせ）

- [ ] **トリガーの形式**。ダッシュボード → Workers & Pages → `ts-corporate-renewal` →
      Settings → Domains & Routes を見る。
      `tsam-ai.com` が **Custom Domain** か **Route** かを確認し、
      [wrangler.jsonc](../wrangler.jsonc) の `routes` を実態に合わせる。
      **形式が違うまま deploy すると、トリガーが二重に付くおそれがある。**
- [ ] **compatibility_date**。同じ画面か `npx wrangler versions list` で稼働中の値を見て、
      `wrangler.jsonc` を合わせる。**下げると挙動が変わりうる。**
- [ ] **バインディング**。稼働中の版が R2（増分キャッシュ）・サービスバインディング・
      画像最適化を使っていないか確認する。使っているなら `wrangler.jsonc` の
      該当箇所を有効化してから deploy する（コメントアウトしてある）。
- [ ] **環境変数・シークレット**。`npx wrangler secret list` で確認する。
      交流会申込アプリは Stripe・Supabase・Gmail のキーを使う。
      **設定漏れがあると、デプロイ後に決済とメールが止まる。**

### 毎回

- [ ] `git status` がクリーン（意図しない差分を巻き込まない）
- [ ] `npm ci`（lock と一致した依存で作る）
- [ ] `npm test` と `npm run typecheck` が通る
- [ ] `git log -1` の SHA を控える（**何をデプロイしたか**の記録。切り戻しに使う）
- [ ] `npx wrangler whoami` で対象アカウントを確認する

---

## 4. デプロイ

```powershell
# ビルド＋デプロイ（deploy スクリプトが両方を行う）
npm run deploy
```

デプロイ前にローカルで動きを見たい場合：

```powershell
npm run preview   # ビルドして workerd でローカル起動する
```

`preview` は**本番に影響しない。** ローカルの workerd で動かすだけである。

---

## 5. デプロイ後の確認

```powershell
# 1. 版が増えたことを確認
npx wrangler versions list
```

```bash
# 2. 配信の確認（新しく入れたはずのパスを直接引く）
curl -sI https://tsam-ai.com/                              # 200
curl -sI https://tsam-ai.com/production-app/voice-recorder/ # 200
curl -sI https://tsam-ai.com/event/apply/                   # 200 かつ x-opennext: 1
```

- [ ] 上の3つが期待どおり
- [ ] ポータル（`/portal/`）にカードが並ぶ
- [ ] 交流会の申込（`/event/apply/`）が開く ← **サーバー側が動いている証拠**
- [ ] ブラウザの devtools で、更新したはずのファイルが**新しい内容**になっている

### キャッシュが古い場合

`CF-Cache-Status: HIT` が返るとおり、エッジにキャッシュされる。
`Cache-Control: public, max-age=0, must-revalidate` なので通常は毎回再検証されるが、
古い内容が出続けるときは Cloudflare ダッシュボード →
**Caching → Configuration → Purge Everything** を実行する。

---

## 6. 切り戻し

**`git revert` では戻らない。** 公開が Git に紐づいていないためである。

### A. Versions からロールバック（最短・ビルド不要）

1. Cloudflare ダッシュボード → Workers & Pages → `ts-corporate-renewal`
2. **Deployments**（Versions）タブ
3. 戻したい版の「⋯」→ **Rollback**
4. 確認ダイアログで実行

CLI でも同じことができる。

```powershell
npx wrangler versions list          # 版の一覧とID
npx wrangler rollback [version-id]  # 指定した版へ戻す
```

**これが最も速い。障害時はまずこれを行う。**

### B. 旧コミットから再デプロイ（恒久的に直す）

```powershell
git switch --detach <戻したいコミットSHA>
npm ci
npm run deploy
```

そのうえで、問題のある変更を `main` からも取り除く（`git revert` 等）。
**A だけで終えると、次に誰かがデプロイした瞬間に問題が再発する。**

### C. キャッシュのパージ

A または B のあとも古い内容が出る場合のみ。§5 の手順で Purge Everything を実行する。

---

## 7. リポジトリと本番の対応関係

**リポジトリの状態と本番は自動で同期しない。** ずれは次の形で現れる。

| 状態 | 意味 |
| --- | --- |
| `main` にあるが本番に無い | マージ後にデプロイしていない |
| 本番にあるが `main` に無い | ブランチや作業ツリーから直接デプロイした（**避けること**） |

後者を防ぐため、デプロイは原則 `main` の内容から行い、`git log -1` の SHA を
デプロイの記録として残すこと。

---

関連: [production-cutover.md](./production-cutover.md)（GitHub Pages → Vercel の記録・現行構成ではない） /
[DEPLOYMENT.md](../DEPLOYMENT.md)（Vercel 前提のまま・要更新） /
[repository-structure.md](./repository-structure.md)（配信ルートは `public/`）
