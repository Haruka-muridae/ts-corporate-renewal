/*
 * Googleカレンダー読み取り用リフレッシュトークンの取得スクリプト。
 *
 * docs/gmail-setup.md 手順5の「取得用のスクリプト」に相当するもの。
 * 交流会アプリのカレンダー連動（lib/event/calendar-sync.mjs）が使う
 * GOOGLE_CALENDAR_REFRESH_TOKEN（--write 時は GOOGLE_CALENDAR_WRITE_REFRESH_TOKEN）を
 * 発行するために、事業者が自分の
 * ターミナルで実行する。取得した値は画面に表示するだけで、
 * ファイルにもログにも書かない（保存先の判断は実行者に委ねる）。
 *
 * 使い方:
 *   node scripts/get-calendar-refresh-token.mjs            … 読み取り用（calendar.readonly）
 *   node scripts/get-calendar-refresh-token.mjs --write    … 書き込み用（calendar.events）
 *
 * - 既定のスコープは calendar.readonly の1つだけ。gmail.send は要求しない
 *   （読み取り専用のトークンに送信権限を持たせない。要件定義書 §9-1）。
 * - --write は、支払人数をカレンダー予定の説明欄へ書き戻す機能のためのトークン。
 *   読み取り用とは別のトークンとして発行・登録する（同期の読み取りに書き込み権限を
 *   持たせないため、既存の GOOGLE_CALENDAR_REFRESH_TOKEN は readonly のまま維持する）。
 * - OAuthクライアントは Gmail 用（デスクトップアプリ）を使い回す。
 *   デスクトップアプリ型は http://localhost の任意ポートへの
 *   リダイレクトが追加設定なしで許可されているため、この方式で完結する。
 * - 外部ライブラリは使わない（このリポジトリの方針に合わせる）。
 */

import http from "node:http";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const WRITE_MODE = process.argv.includes("--write");
const SCOPE = WRITE_MODE
  ? "https://www.googleapis.com/auth/calendar.events"
  : "https://www.googleapis.com/auth/calendar.readonly";
const ENV_NAME = WRITE_MODE
  ? "GOOGLE_CALENDAR_WRITE_REFRESH_TOKEN"
  : "GOOGLE_CALENDAR_REFRESH_TOKEN";
const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const rl = readline.createInterface({ input: stdin, output: stdout });
const clientId = (await rl.question("OAuth クライアント ID: ")).trim();
const clientSecret = (await rl.question("OAuth クライアントシークレット: ")).trim();
rl.close();

if (!clientId || !clientSecret) {
  console.error("クライアント ID とシークレットの両方が必要です。");
  process.exit(1);
}

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPE);
/* offline + consent の組み合わせでないと refresh_token が返らないことがある。 */
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

/* 認可コードをローカルのHTTPサーバーで受け取る。 */
const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }
    const error = url.searchParams.get("error");
    const received = url.searchParams.get("code");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      error
        ? "認可がキャンセルまたは失敗しました。ターミナルに戻ってください。"
        : "認可を受け取りました。このタブは閉じて、ターミナルに戻ってください。",
    );
    server.close();
    if (error || !received) {
      reject(new Error(`認可が完了しませんでした: ${error ?? "code なし"}`));
    } else {
      resolve(received);
    }
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log("\n次のURLをブラウザで開き、architect@potenitas.com で認可してください。");
    console.log("（「このアプリは Google で確認していません」と出たら「詳細」→「移動」で進む）\n");
    console.log(authUrl.toString());
    console.log("\nこのまま認可を待っています…（中断は Ctrl+C）");
  });
  server.on("error", (err) => {
    reject(new Error(`ポート ${PORT} でサーバーを起動できませんでした: ${err.code ?? err.message}`));
  });
});

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  }),
});

const token = await tokenRes.json().catch(() => ({}));

/* 失敗時は状態コードと error 名だけを出す。本文の丸ごと出力はしない。 */
if (!tokenRes.ok) {
  console.error(`\nトークン交換に失敗しました: HTTP ${tokenRes.status} ${token.error ?? ""}`);
  process.exit(1);
}

if (!token.refresh_token) {
  console.error(
    "\n応答に refresh_token が含まれていません。" +
      "同じクライアントで認可済みの場合に起きます。もう一度実行し、" +
      "認可画面が必ず表示されることを確認してください。",
  );
  process.exit(1);
}

if (token.scope !== SCOPE) {
  console.warn(`\n注意: 付与されたスコープが想定と異なります: ${token.scope}`);
}

console.log("\n==============================================================");
console.log(`${ENV_NAME}（下の1行が値。コピーして使う）`);
console.log("==============================================================\n");
console.log(token.refresh_token);
console.log("\nこの値は再表示できません。登録:");
console.log(`  本番:   npx wrangler secret put ${ENV_NAME}`);
console.log(`  ローカル: .env.local に ${ENV_NAME}=<値>（コミットしない）`);
