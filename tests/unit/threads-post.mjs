/*
 * Threads 投稿アプリ（public/production-app/threads-post/）のスイート。
 *
 * 画面（app.js）は DOM の付け外ししかしないため、ここでは
 * ロジック層（post.js / gemini.js）を直接読み込んで固定する。
 *   - 検証と intent リンク（500字・URL エンコード）
 *   - 端末内保存（下書き・履歴・上限・壊れたデータの読み捨て）
 *   - Gemini 呼び出し（キーはヘッダー・404 フォールバック・エラー分類）
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

const POST = '../../public/production-app/threads-post/post.js';
const GEMINI = '../../public/production-app/threads-post/gemini.js';
const CONFIG = '../../public/production-app/threads-post/config.js';

/* localStorage の偽物。post.js は storage を引数で受け取れる。 */
function makeStorage() {
  const map = new Map();

  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

try {
  const post = await import(POST);
  const gemini = await import(GEMINI);
  const config = await import(CONFIG);

  /* ================================================================ */
  section('検証と intent リンク');

  {
    check('空は拒否', post.validatePostText('   ') !== null);
    check('500字ちょうどは通る', post.validatePostText('あ'.repeat(500)) === null);
    check('501字は拒否', post.validatePostText('あ'.repeat(501)) !== null);
    check('コードポイントで数える（サロゲートペア）', post.countText('𠮷野家'.repeat(1)) === 3);

    const url = post.buildIntentUrl('こんにちは Threads\n2行目');
    check('intent の URL になる',
      url.startsWith('https://www.threads.net/intent/post?text='));
    check('本文が URL エンコードされる',
      url.includes(encodeURIComponent('こんにちは Threads\n2行目')));
  }

  /* ================================================================ */
  section('端末内保存（下書き）');

  {
    const storage = makeStorage();

    const draft = post.saveDraft('下書きの本文', { storage, now: 1000 });
    check('保存した1件が返る', draft.text === '下書きの本文' && draft.createdAt === 1000);

    post.saveDraft('2件目', { storage, now: 2000 });
    const drafts = post.listDrafts({ storage });
    check('新しい順で返る', drafts.length === 2 && drafts[0].text === '2件目');

    post.deleteDraft(draft.id, { storage });
    check('削除できる', post.listDrafts({ storage }).length === 1);

    let error = null;
    try {
      post.saveDraft('   ', { storage });
    } catch (caught) {
      error = caught;
    }
    check('空は保存できない', error !== null);
  }

  {
    /* 壊れた保存データは読み捨て、次の保存で作り直す。 */
    const storage = makeStorage();
    storage.setItem(config.STORAGE_KEY, '{broken json');

    check('壊れたデータでも一覧は空で返る', post.listDrafts({ storage }).length === 0);

    post.saveDraft('復旧後の1件', { storage });
    check('保存し直せる', post.listDrafts({ storage }).length === 1);
  }

  /* ================================================================ */
  section('端末内保存（履歴と上限）');

  {
    const storage = makeStorage();

    post.recordHistory('投稿画面を開いた', '本文A', { storage, now: 1000 });
    post.recordHistory('投稿画面を開いた', '本文B', { storage, now: 2000 });

    const history = post.listHistory({ storage });
    check('新しい順で返る', history.length === 2 && history[0].text === '本文B');
    check('種別が入る', history[0].kind === '投稿画面を開いた');

    for (let i = 0; i < config.HISTORY_LIMIT + 10; i += 1) {
      post.recordHistory('投稿画面を開いた', `本文${i}`, { storage, now: 3000 + i });
    }

    check('上限を超えた分は古い順に捨てる',
      post.listHistory({ storage }).length === config.HISTORY_LIMIT);
  }

  /* ================================================================ */
  section('Gemini 呼び出し');

  {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '```\n生成された投稿文\n```' }] } }],
        }),
      };
    };

    const text = await gemini.generatePost({ apiKey: 'FAKE-KEY', theme: '新サービスの告知', fetchImpl });
    check('コードフェンスを剥がして返す', text === '生成された投稿文');
    check('主モデルを1回だけ呼ぶ', calls.length === 1
      && calls[0].url.includes(`/models/${config.DEFAULT_MODEL}:generateContent`));
    check('キーはヘッダーで渡し URL に載せない',
      calls[0].options.headers['x-goog-api-key'] === 'FAKE-KEY'
      && !calls[0].url.includes('FAKE-KEY'));

    const body = JSON.parse(calls[0].options.body);
    check('テーマと制約がプロンプトに入る',
      body.contents[0].parts[0].text.includes('新サービスの告知')
      && body.contents[0].parts[0].text.includes('500文字以内')
      && body.contents[0].parts[0].text.includes('創作の禁止'));
    check('temperature 0.4', body.generationConfig.temperature === 0.4);
  }

  {
    /* キー未設定は fetch せず KEY_MISSING。 */
    const calls = [];
    let error = null;

    try {
      await gemini.generatePost({ apiKey: '', theme: 'x', fetchImpl: async () => { calls.push(1); } });
    } catch (caught) {
      error = caught;
    }

    check('キー未設定は KEY_MISSING', error?.code === gemini.GeminiErrorCode.KEY_MISSING);
    check('キー未設定では通信しない', calls.length === 0);
    check('画面向けの文言に「ポータル」を含む',
      gemini.describeGeminiError(error).text.includes('ポータル'));
  }

  {
    /* 404 のときだけフォールバックへ切り替える。 */
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);

      if (url.includes(config.DEFAULT_MODEL)) {
        return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '代替モデルの結果' }] } }] }),
      };
    };

    const text = await gemini.generatePost({ apiKey: 'FAKE', theme: 'x', fetchImpl });
    check('404 でフォールバックへ切り替える', text === '代替モデルの結果'
      && calls.length === 2 && calls[1].includes(config.FALLBACK_MODEL));
  }

  {
    /* 429 は再試行しない。分類も確かめる。 */
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) };
    };

    let error = null;
    try {
      await gemini.generatePost({ apiKey: 'FAKE', theme: 'x', fetchImpl });
    } catch (caught) {
      error = caught;
    }

    check('429 は RATE_LIMITED', error?.code === gemini.GeminiErrorCode.RATE_LIMITED);
    check('429 では再試行しない', calls.length === 1);
    check('401 は KEY_REJECTED', gemini.mapStatus(401) === gemini.GeminiErrorCode.KEY_REJECTED);
    check('400 はキーの問題にしない', gemini.mapStatus(400) === gemini.GeminiErrorCode.BAD_REQUEST);
    check('503 は SERVER_ERROR', gemini.mapStatus(503) === gemini.GeminiErrorCode.SERVER_ERROR);
  }

  {
    /* 空応答は EMPTY_TEXT。 */
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [] }),
    });

    let error = null;
    try {
      await gemini.generatePost({ apiKey: 'FAKE', theme: 'x', fetchImpl });
    } catch (caught) {
      error = caught;
    }

    check('空応答は EMPTY_TEXT', error?.code === gemini.GeminiErrorCode.EMPTY_TEXT);
  }
} catch (error) {
  fatal(error);
}

finish();
