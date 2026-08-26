/*
 * 実 D1（Miniflare のローカル SQLite）に対して Cron の 1 周（runTick）を回す検証スクリプト。
 *
 *   node workers/push-assistant/scripts/verify-tick-local.mjs   （リポジトリのルートで。node_modules が要る）
 *
 * ------------------------------------------------------------------
 * なぜ単体テストと別に置くか
 * ------------------------------------------------------------------
 * tests/unit/push-assistant.mjs はインメモリの偽 store で判定・再試行・
 * 二重通知防止を検証しているが、**store.mjs の SQL そのものは実行していない**。
 * ここでは migrations/0001_init.sql を実 SQLite に流し、Google と Push
 * サービスだけを偽 fetch に差し替えて、SQL・インデックス・UNIQUE 制約が
 * 実物で機能することを確かめる（2026-08-26 に本番投入前の確認として実施）。
 *
 * 秘密は一切要らない。鍵はこの場で使い捨てを作る。外へは何も送らない。
 * ------------------------------------------------------------------
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { createD1Store } from '../src/store.mjs';
import { runTick } from '../src/tick.mjs';
import { importEncryptionKey, encryptString } from '../src/crypto-util.mjs';
import { importVapidPrivateKey } from '../src/vapid.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');

/* 使い捨ての鍵一式。 */
const vapidPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const vapid = {
  privateKey: await importVapidPrivateKey(JSON.stringify(await crypto.subtle.exportKey('jwk', vapidPair.privateKey))),
  publicKey: b64u(await crypto.subtle.exportKey('raw', vapidPair.publicKey)),
  subject: 'https://tsam-ai.com/push-assistant/',
};
const encryptionKey = await importEncryptionKey(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));

/* 実 D1。マイグレーションをそのまま流す（行末コメントは落とす）。 */
const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response(""); } }',
  d1Databases: { DB: 'push_assistant' },
});
const db = await mf.getD1Database('DB');
const migration = readFileSync(resolve(here, '../migrations/0001_init.sql'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ''))
  .join(' ');
await db.exec(migration.split(';').map((s) => s.trim()).filter(Boolean).join(';\n') + ';');

const store = createD1Store(db);
const nowMs = Date.parse('2026-08-26T12:00:00Z');
const nowIso = new Date(nowMs).toISOString();

/* 受信者（ブラウザ）側の鍵を本物で作り、購読を登録する。 */
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
await store.upsertUser({ id: 'u1', email: 'u1@example.com', nowIso });
await store.saveTokens('u1', { refreshTokenEnc: await encryptString(encryptionKey, 'rt-1'), accessTokenEnc: null, accessTokenExpiresAt: null, scope: 'x' }, nowIso);
await store.upsertSubscription({
  userId: 'u1',
  endpoint: 'https://push.example.test/sub/1',
  p256dh: b64u(await crypto.subtle.exportKey('raw', ua.publicKey)),
  auth: b64u(crypto.getRandomValues(new Uint8Array(16))),
  userAgent: 'verify-tick-local',
  nowIso,
});

const calls = [];
let pushStatus = 503;

const fetchImpl = async (url, init) => {
  const text = String(url);

  calls.push(`${init?.method ?? 'GET'} ${text}`);

  if (text.includes('oauth2.googleapis.com/token')) {
    return Response.json({ access_token: 'at-1', expires_in: 3600, token_type: 'Bearer' });
  }

  if (text.includes('calendar/v3')) {
    return Response.json({
      items: [
        {
          id: 'ev1', status: 'confirmed', summary: '10分前テスト',
          start: { dateTime: '2026-08-26T12:09:30+00:00' }, end: { dateTime: '2026-08-26T13:00:00+00:00' },
          hangoutLink: 'https://meet.google.com/abc-defg-hij', htmlLink: 'https://calendar.google.com/x',
        },
        { id: 'ev2', status: 'confirmed', summary: '終日', start: { date: '2026-08-26' }, end: { date: '2026-08-27' } },
      ],
    });
  }

  if (text.startsWith('https://push.example.test/')) {
    return new Response('', { status: pushStatus });
  }

  return new Response('unexpected', { status: 500 });
};

const log = (level, code, detail) => console.log(`  [${level}] ${code} ${detail ?? ''}`);
const base = { store, vapid, encryptionKey, clientId: 'cid', clientSecret: 'sec', appUrl: 'https://tsam-ai.com/push-assistant/', fetchImpl, log, maxUsers: 20 };

console.log('tick1: push が 503 → pending のまま再試行へ');
console.log(await runTick({ ...base, nowMs }));
pushStatus = 201;
console.log('tick2: push が 201 → sent');
console.log(await runTick({ ...base, nowMs: nowMs + 60_000 }));
console.log('tick3: 同じ予定は再送しない');
console.log(await runTick({ ...base, nowMs: nowMs + 120_000 }));

const rows = (await db.prepare('SELECT event_id, lead_minutes, status, attempts, open_url, url_source FROM notifications').all()).results;
const pushCalls = calls.filter((c) => c.includes('push.example')).length;
const tokenCalls = calls.filter((c) => c.includes('/token')).length;

console.log('notifications:', JSON.stringify(rows));
console.log(`push calls=${pushCalls} token calls=${tokenCalls}`);

const okResult = rows.length === 1 && rows[0].status === 'sent' && rows[0].attempts === 2
  && rows[0].url_source === 'conference' && pushCalls === 2 && tokenCalls === 1;

console.log(okResult ? '\n実 D1 での確認: OK' : '\n実 D1 での確認: NG');
await mf.dispose();
process.exitCode = okResult ? 0 : 1;
