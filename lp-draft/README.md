# コーポレートサイト リニューアル版LP（未公開・退避中）

Next.js（App Router）で作成したリニューアル版LPのルートです。
`https://tsam-ai.com/` は現行の静的サイト（`public/index.html`）を配信するため、
これらのルートをそのまま `app/` に置くとパスが衝突します。

| このディレクトリのファイル | 衝突していた公開パス | 現在そのパスを配信しているもの |
| --- | --- | --- |
| `page.tsx` | `/` | `public/index.html` |
| `about/`, `faq/`, `thanks/` | `/about`, `/faq`, `/thanks` | （現行サイトにはトップ内のアンカーとして存在） |
| `legal/` | `/legal` | `public/legal/`（特商法・利用規約・プライバシー） |
| `privacy/` | `/privacy` | `public/legal/privacy/` |
| `robots.ts`, `sitemap.ts` | `/robots.txt`, `/sitemap.xml` | LP用の内容のため未公開 |

**削除はしていません。** リニューアル版を公開する判断がなされた時点で、
このディレクトリの中身を `app/` へ戻し、現行の静的サイト側と重複するファイルの
扱いを決めてください。

`components/`、`content/`、`lib/`、`types/` はこれらのページが参照しているため、
そのまま残しています。
