# receipt-ocr への指摘（2026年8月4日）

名刺OCR（`card-ocr`）のフェーズ0で見つけて直した内容のうち、
**領収書OCR（`receipt-ocr`）に未反映のもの**をまとめる。

## この文書の位置づけ

- **`receipt-ocr` のコードは変更していない。** 別の作業ラインのものなので、
  指摘として残すに留める。直すかどうかは `receipt-ocr` 側で判断する
- 見つかった経緯は、`card-ocr` を実装するにあたって
  [repository-structure.md](./repository-structure.md) §4-1 の「共通層を作らず
  複製する」方針を決めるため、両アプリの全ファイルを突き合わせたこと
- 同 §4-3 のとおり、**`card-ocr` へ複製するときは直したうえで写す。**
  したがって `receipt-ocr` を直さないままでも `card-ocr` に不具合は入らない。
  ただし2つのアプリの挙動が食い違ったままになる
- 行番号は 2026年8月4日時点（`main` の `295ce09`）のもの。
  変わりうるので、探すときは関数名で当たること

## 一覧

| # | 現象 | 場所 | 重さ |
| --- | --- | --- | --- |
| 1 | GIS の読み込みに一度失敗すると、再読み込みまで Google 連携できない | `oauth.js` `loadGis` | **高** |
| 2 | Drive のレート制限（403）で、有効なトークンを捨てて再連携を促す | `errors.js` `mapGoogleError` → `app.js` | **高** |
| 3 | Gemini の 400 を「APIキーの問題」と案内する | `gemini-client.js` `mapGeminiError` | 中 |
| 4 | 同意画面でスコープのチェックを外されても先へ進む | `oauth.js` `requestAccess` | 中 |
| 5 | 429 と 5xx が 400 と一緒くたになり、無関係な文言が出る | `errors.js` `mapGoogleError` | 中 |
| 6 | 消し損ねた一時ドキュメントを回収する経路が無い | `ocr-drive.js`（該当コードなし） | 中 |
| 7 | multipart の boundary が内容から決まる | `ocr-drive.js` `uploadForOcr` | 低 |

あわせて、**不具合ではないが書いたものが使われていない箇所**を2件（#8・#9）。

---

## 1. GIS の読み込みに一度失敗すると、再読み込みまで Google 連携できない

**重さ: 高**

### 現象

[oauth.js](../public/production-app/receipt-ocr/oauth.js) の `loadGis` は、
`gisPromise` に読み込みの Promise を保持して2回目以降を省く。
`script` の `error` で reject するが、**reject した Promise が
`gisPromise` に残り続ける。**

```js
let gisPromise = null;

function loadGis() {
  if (gisPromise) {
    return gisPromise;        // ← 失敗した Promise もここで返る
  }
  gisPromise = new Promise((resolve, reject) => {
    ...
    script.addEventListener('error', () => reject(new AppError('OAUTH-001', ...)));
  });
  return gisPromise;
}
```

### 影響

一時的な通信の失敗や、広告ブロッカーが一瞬効いただけでも、
**そのページを開いているあいだ Google 連携が二度と成功しない。**
利用者から見ると「連携ボタンを何度押しても同じエラーが出る」状態で、
ページを再読み込みするしか復旧手段が無い。案内文（`OAUTH-001`）は
「もう一度お試しください」なので、**案内どおりにしても直らない。**

加えて `<script>` の読み込みに時間制限が無いため、応答が返らない場合は
`error` も `load` も発火せず、待ち続ける。

### card-ocr での直し方

[gis-loader.js](../public/production-app/card-ocr/poc/gis-loader.js) を参照。

- 失敗したら `gisPromise` を `null` に戻す（`loadGis` の `catch`）
- 10秒のタイムアウトを置く（`GIS_LOAD_TIMEOUT_MS`）
- すでに読み込み済みかを `isGisLoaded()` で判定する
- テストのために `resetGisLoader()` を用意する

---

## 2. Drive のレート制限（403）で、有効なトークンを捨てて再連携を促す

**重さ: 高**

### 現象

[errors.js](../public/production-app/receipt-ocr/errors.js) の `mapGoogleError` は、
403 のうち容量不足だけを `DRV-003` にし、**それ以外の 403 をすべて
`OAUTH-001`（認可の問題）にしている。**

```js
if (status === 403) {
  return /storageQuotaExceeded|insufficientStorage|quotaExceeded/i.test(code)
    ? 'DRV-003'
    : 'OAUTH-001';
}
```

`OAUTH-001` は `GUIDE.REAUTH` を持つため、[app.js](../public/production-app/receipt-ocr/app.js)
が `forgetToken()` を呼んでトークンを破棄し、「未連携」に戻す。

### 影響

Drive API はレート制限を **403（`userRateLimitExceeded` / `rateLimitExceeded`）**
で返すことがある。このとき、**まだ有効なトークンを捨てて、利用者に
Google の同意画面をもう一度踏ませる。**

利用者から見ると「連携し直したのにまた失敗する」ことになり、
待てば直る問題を、待てば直らない問題に変えてしまう。

なお正規表現の `quotaExceeded` は `userRateLimitExceeded` に一致しない
（`quotaExceeded` という並びを含まないため）。

### card-ocr での直し方

[drive-api.js](../public/production-app/card-ocr/poc/drive-api.js) の
`mapDriveStatus` を参照。403 を `FORBIDDEN` として認可エラーと分け、
429 を `RATE_LIMITED` として独立させている。

**ただし `card-ocr` 側も 403 の内訳（容量不足とレート制限）を分けていない。**
`receipt-ocr` の `DRV-003`（容量不足）の判定は良いので、
統合するなら「容量不足 / レート制限 / 権限不足」の3つに分けるのが正しい。

---

## 3. Gemini の 400 を「APIキーの問題」と案内する

**重さ: 中**

### 現象

[gemini-client.js](../public/production-app/receipt-ocr/gemini-client.js) の
`mapGeminiError`:

```js
if (status === 400 || status === 401 || status === 403) {
  return 'KEY-002';
}
```

### 影響

400 は**リクエストの形が不正**という意味で、キーとは関係がない。
`responseSchema` の書き方、`generationConfig` の値、モデル名の指定など、
こちら側の作りが原因である。それを「APIキーを確認してください」と案内すると、
**利用者は自分のキーを疑い、作り直し、それでも直らない**ことになる。

`card-ocr` のフェーズ0で実際にこれが起きた。`responseSchema` の `type` を
小文字で送っていたために 400 が返り、キーの問題として表示されていた
（[specs/card-ocr-phase0-plan.md](./specs/card-ocr-phase0-plan.md) §7-5-2）。

### card-ocr での直し方

[gemini.js](../public/production-app/card-ocr/poc/gemini.js) の `mapStatus` を参照。

| ステータス | 分類 | 表示 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | `AI-003`。「送信内容に問題があります」。**キーを疑わせない** |
| 401 / 403 | `KEY_REJECTED` | `KEY-002` |
| 404 | `MODEL_NOT_FOUND` | フォールバックモデルへ1回 |
| 429 | `RATE_LIMITED` | `AI-002` |
| 500番台 | `SERVER_ERROR` | 503 は「混雑」として別文言 |

---

## 4. 同意画面でスコープのチェックを外されても先へ進む

**重さ: 中**

### 現象

[oauth.js](../public/production-app/receipt-ocr/oauth.js) の `requestAccess` の
`callback` は、`response.access_token` の有無しか見ていない。

Google の同意画面は、要求したスコープを利用者が**個別に外せる。**
外された場合でもトークン自体は発行されるため、この判定は通る。

### 影響

`drive.file` を外されたまま処理が始まり、**最初の Drive API 呼び出しで
初めて失敗する。** そのときのエラーは 403 なので、#2 と重なって
「トークンを捨てて再連携」になり、利用者は同じ画面で同じチェックを
外し続ける可能性がある。

失敗する場所も分かりにくい。保存先の作成（`provisioning`）まで進んでから
落ちるため、「連携はできたのに保存先が作れない」という見え方になる。

### card-ocr での直し方

[drive-auth.js](../public/production-app/card-ocr/poc/drive-auth.js) の
`hasDriveScope()` を参照。`google.accounts.oauth2.hasGrantedAllScopes` で
付与を確認し、足りなければ `SCOPE_NOT_GRANTED` として
**その場で拒否する**（`ensureAccessToken` 内）。案内も
「Google ドライブへの権限が許可されていません」と具体的にできる。

あわせて `pendingRequest` でポップアップの二重起動も防いでいる。

---

## 5. 429 と 5xx が 400 と一緒くたになり、無関係な文言が出る

**重さ: 中**

### 現象

[errors.js](../public/production-app/receipt-ocr/errors.js) の `mapGoogleError` は、
401 / 403 / 404 以外を**すべて `SHEET-001` にしている**（最終行の `return`）。
`SHEET-001` の文言は「シートへの書き込みに失敗しました。もう一度お試しください。」

[google-api.js](../public/production-app/receipt-ocr/google-api.js) の
`callGoogle` は、ネットワーク自体の失敗も同じ経路へ流す。

### 影響

- **Drive への画像アップロードが 429 で失敗しても「シートへの書き込みに
  失敗しました」と表示される。** 利用者は何が起きたか分からない
- 5xx（Google 側の一時的な障害）も同じ文言になる。**待てば直るのかどうかが
  伝わらない**
- ネットワーク断も同じ。「通信できません」と言うべき場面で
  シートの話をしている

500番台を「未知」に落としてはいないが、**中身の違う失敗を1つの文言に
まとめている**という点では同じ問題である。`card-ocr` のフェーズ0では、
これが原因で 503（混雑）を SYS-999 として何時間も誤診した。

### card-ocr での直し方

[drive-api.js](../public/production-app/card-ocr/poc/drive-api.js) の
`mapDriveStatus` と、[gemini.js](../public/production-app/card-ocr/poc/gemini.js) の
`summarizeErrorBody()` を参照。

- 429 を `RATE_LIMITED` として独立させる
- **エラー応答の本文を読んで、原因の要約を画面へ出す。**
  読み捨てると、あとから切り分けられない
- 503 は「混雑しています。時間をおいてお試しください」と、
  待てば直ることが伝わる文言にする

> **`card-ocr` 側にも同種の弱点が1つ残っている。** `drive-api.js` は
> 500番台を `UNKNOWN` に落としている。フェーズ1で直す。

---

## 6. 消し損ねた一時ドキュメントを回収する経路が無い

**重さ: 中**

### 現象

[ocr-drive.js](../public/production-app/receipt-ocr/ocr-drive.js) の `recognize` は
`finally` で一時ドキュメントを消しており、**この点は正しい。**
問題は、その削除が失敗したときである。

`drive.js` の `deleteFile` は失敗を握って `false` を返すが、
`recognize` はその戻り値を見ていない。そして**残ったファイルを
あとから見つけて消す経路が、アプリのどこにも無い。**

### 影響

削除に失敗するのは、通信断・タブを閉じた・トークン失効といった場面で、
まれではあるが必ず起きる。回収する経路が無いと、**利用者のドライブに
`ocr-tmp-*` という名前のドキュメントが少しずつ溜まる。**

一時ドキュメントは OCR 結果のテキストを含むため、
**領収書の中身がドライブに残り続ける**ことになる。
「一時ファイルは即時に完全削除する」という設計方針が、
失敗経路で崩れている。

### card-ocr での直し方

[drive-ocr.js](../public/production-app/card-ocr/poc/drive-ocr.js) の
`collectOrphanTempDocs()` を参照。

- 一時ドキュメントの名前を **固定の接頭辞＋タイムスタンプ**にする
  （`receipt-ocr` は `ocr-tmp-${利用者のファイル名}` で、接頭辞はあるが
  利用者のファイル名が入るため検索条件が組みにくい）
- 起動時にその接頭辞で検索し、見つかったものを消す
- 結果を画面に出す（見つけた件数 / 消せた件数）

---

## 7. multipart の boundary が内容から決まる

**重さ: 低**

### 現象

[ocr-drive.js](../public/production-app/receipt-ocr/ocr-drive.js) の `uploadForOcr`:

```js
const boundary = `ocr-${blob.size}-${blob.type.length}`;
```

同じく `drive.js` の `uploadImage` は `Math.random()` を使っている。

### 影響

boundary の要件は「**その本文の中に同じ並びが現れないこと**」である。
`ocr-123456-10` のような短い ASCII 列が JPEG のバイナリに現れる確率は
低いが、**低いと言える根拠が無い**（画像の中身は利用者が決める）。
現れた場合、multipart の解釈が壊れてアップロードが失敗する。

再現しないので、起きたときに原因を突き止めるのが難しい種類の問題である。

### card-ocr での直し方

[drive-api.js](../public/production-app/card-ocr/poc/drive-api.js) の
`createBoundary()` を参照。`crypto.randomUUID()` →
`crypto.getRandomValues()` → 時刻の三段で落とす。

---

## 8. OCR が空だったことを画面へ伝えていない（不具合ではない）

[ocr.js](../public/production-app/receipt-ocr/ocr.js) の `recognize` は
`{ engine, text, empty }` を返すが、**`empty` を読む箇所が無い**
（[app.js](../public/production-app/receipt-ocr/app.js) の呼び出し）。

そのため、OCR が空文字を返しても抽出・検証へそのまま進み、
すべての項目が空の確認画面が出る。`errors.js` の `OCR-001`
（「文字を読み取れませんでした。要確認として保存するか選んでください」）へ
到達する経路が、実質的に存在しない。

`card-ocr` は空のとき最大3回まで読み直し（`drive-ocr.js` の `OCR_MAX_ATTEMPTS`）、
尽きたら `OCR-002` にしている。

## 9. 画像の縮小が実装されていない（不具合ではない）

[config.js](../public/production-app/receipt-ocr/config.js) に
`IMAGE_MAX_EDGE_PX = 2000` があるが、**リポジトリ全体で他に参照が無い。**
`app.js` は `selected.file` をそのまま `recognize` へ渡している。

高画素のスマートフォンで撮った写真がそのまま上がるため、
アップロードに時間がかかり、Drive の容量も余計に使う。

`card-ocr` は要件定義書 §8.2 で長辺1,600〜2,000px・1.5MB以下と定めており、
フェーズ2で `card-scanner/capture.js` の `shrinkToJpeg` を複製する予定。
共通化はしないが、**同じ問題を2回考えなくて済むよう、ここに書いておく。**

---

## 逆方向 — `receipt-ocr` にあって `card-ocr` に無いもの

指摘ではなく、**`card-ocr` が取り込む側**の記録。フェーズ1で反映する。

| 内容 | 場所 |
| --- | --- |
| **CSP を `index.html` の meta で宣言** | `index.html`。`next.config.ts` を触らずに掛けられる |
| 数式エスケープの対象がタブ・CR も含む（`/^[=+\-@\t\r]/`） | `sheets.js` の `escapeFormula` |
| `valueInputOption=RAW` による二重防御 | `sheets.js` |
| 既存シートの健全性検査（列が改変されていたら書き込みを止める） | `provisioning.js` の `inspectSpreadsheet` |
| `AbortSignal` が全層に貫通している | `google-api.js` ほか |
| 画像の SHA-256 と重複判定 | `hash.js` |
| 保存先IDの形式検証 | `store.js` の `isFileId` |
| `pagehide` でトークンとプレビューURLを破棄 | `app.js` |
| 同名フォルダが重複したとき**古いほうを採り、そのことを案内する** | `drive.js` / `provisioning.js` の `DUPLICATE_STRUCTURE` |

最後の1件は方針が正反対だった（`card-ocr` は新しいほうを黙って採る）。
**`receipt-ocr` が正しい。** 先に作られたほうが正本であり、
どちらを使ったかを黙っているべきではない。`card-ocr` 側を合わせる。
