# 宿題リスト（スコープ外へ送った作業）

制定: 2026年8月9日

**「気づいたが、その場では直さないと決めたもの」を残す場所。**
作業中に見つけた課題を口頭やコミットメッセージに置くと、次の作業者へ届かない。
ここに書いておけば、着手の判断材料になる。

書き方の決まり:

- **なぜ今やらないのか**を必ず書く。理由の無い先送りは、ただの放置と区別がつかない。
- 着手条件（何が起きたら手を付けるか）を書く。
- 済んだ項目は消さず、「済」へ移して日付と対応先を残す。

---

## 未対応

### B-01. `gas-notifier/*.gs` の構文検査を CI に追加する

**内容**: [gas-notifier/](../gas-notifier/) の `.gs` は、いまテストから
[tests/helpers/gas-notifier-harness.mjs](../tests/helpers/gas-notifier-harness.mjs)
経由で `vm` に読み込まれている。読み込みに失敗すれば
`voice-recorder-notifier` スイートが異常終了するため、**構文エラーは実質的に
検出される**。ただしそれは副作用であって、意図した検査ではない。

- 検査対象は harness が読む範囲に限られる（`lib_jsrsasign.gs` に本体を貼った状態は見ない）
- 失敗したとき「構文エラー」ではなく「スイートが落ちた」としか出ない
- `SidebarSetup.html` 内の JS はどこからも検査されていない

**やること**: `.gs` を V8 相当で構文検査する小さなスクリプトを足し、
[.github/workflows/test.yml](../.github/workflows/test.yml) から実行する。
`gas-auth/*.gs` も同じ扱いにできる。

**なぜ今やらないか**: カレンダー通知の実装とは独立しており、
CI の構成（現在は `npm test` のみ）へ手を入れる話になるため。

**着手条件**: `.gs` の構文エラーを本番へ持ち込んだ時点、
または CI に別の検査を足す機会があったとき。

---

### B-02. ログイン仕様書 §6「将来拡張」1・2 の実施

**内容**: [docs/specs/login-page-detailed-spec-v3.md](./specs/login-page-detailed-spec-v3.md) §6 に、
発動条件つきの将来拡張が3つ書かれている。2026-08-09 に 3（画面ごとの許可パラメータ）だけを
実施し、1 と 2 は残してある。

1. `ALLOWED_NEXT` を `SCREENS`（[public/auth/config.js](../public/auth/config.js)）から導出し、
   画面追加時の多重修正（page / session / config）を解消する
2. 画面名ベースの元画面復帰（`?next=<画面名>` を `guardPage()` が自動設定）を導入する

**発動条件はすでに満たされている。** 「保護対象画面が3つを超えた時点で」と書かれており、
現在は portal / card-ocr（+help, +measure）/ receipt-ocr / short-script（+help）/
voice-recorder の6アプリ・9画面がある。

**なぜ今やらないか**: 2 を入れると**全アプリのログイン後の遷移先が変わる**。
現在はどのアプリも `guardPage({ next: 'portal' })` で Portal へ戻る挙動になっており
（録音アプリだけ 2026-08-09 に自分の画面へ戻すよう変えた）、これを一斉に変えるなら
各アプリの導線を1つずつ確認する必要がある。カレンダー通知の不具合修正に
巻き込む変更ではない。

**やること**: 別ブランチで、各アプリの `guardPage({ next: ... })` を一斉に見直す。
[tests/unit/frontend.mjs](../tests/unit/frontend.mjs) の「遷移先の検証」と
「ログイン画面への往復」を先に拡張してから実装に入ること。

**着手条件**: 保護対象アプリをもう1つ足すとき（多重修正が3か所に増える）。

---

### B-03. Vercel 前提の古い記述を Cloudflare Workers + OpenNext へ揃える

**内容**: 2026-08 に Vercel から Cloudflare Workers（OpenNext）へ切り替えたが、
切替前に書かれた文書がそのまま残っている。**現行の正は
[docs/deployment-cloudflare.md](./deployment-cloudflare.md)** であり、
その冒頭にも「DEPLOYMENT.md と production-cutover.md は古い」と書いてある。

読んだ人が誤解しうる主なもの:

| 文書 | 古い前提 |
| --- | --- |
| [DEPLOYMENT.md](../DEPLOYMENT.md) | Vercel の Git 連携で `main` へのマージが公開になる |
| [MANUAL_SETUP_CHECKLIST.md](../MANUAL_SETUP_CHECKLIST.md) | Vercel 側の手動設定手順 |
| [docs/production-cutover.md](./production-cutover.md) | Vercel への切替手順（歴史的記録） |
| [docs/vercel-migration.md](./vercel-migration.md) | 同上 |
| [docs/specs/README.md](./specs/README.md) 末尾 | GitHub Pages がルートを配信しており `docs/` も公開される |

**いちばん危ないのは「マージ＝公開」という誤解**である。現在は
`npm run deploy` の手動実行だけが公開の起点で、マージしても本番は変わらない。

**なぜ今やらないか**: 対象が広く、どれを「歴史的記録として残す」・どれを
「現行に合わせて書き換える」かの仕分けから要る。切替の経緯そのものは
記録として価値があるため、単純な一括置換にはできない。

**やること**: 各文書の冒頭に現行構成への案内を足すか、
「これは移行前の記録である」と明記する。`docs/specs/README.md` の
「`docs/` も公開される」は**事実と異なる**（現在は公開URLから404）ため、
これだけは先に直すのが望ましい。ただし「秘密情報を書かない」という結論自体は、
リポジトリが GitHub にある以上そのまま有効なので消さないこと。

**着手条件**: 新しい担当者がデプロイ手順を読む前。または上記のどれかを
別件で編集するとき（ついでに直す）。

---

## 済

（まだありません）
