/*
 * X 投稿アプリ（public/production-app/x-post/）のスイート。
 *
 * Threads 版（threads-post.mjs）との違いは2点で、そこを重点的に固定する。
 *   - 文字数ではなく280「ウェイト」（全角=2）で数えること
 *   - intent の向き先が x.com であること
 * 保存と Gemini の骨格は Threads 版の複製なので、要点だけ通す。
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

const POST = '../../public/production-app/x-post/post.js';
const GEMINI = '../../public/production-app/x-post/gemini.js';
const CONFIG = '../../public/production-app/x-post/config.js';

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
  };
}

try {
  const post = await import(POST);
  const gemini = await import(GEMINI);
  const config = await import(CONFIG);

  /* ================================================================ */
  section('280ウェイトの数え方（全角=2）');

  {
    check('半角英数は1', post.countWeight('abc123') === 6);
    check('日本語は2', post.countWeight('あいう') === 6);
    check('混在も正しく足す', post.countWeight('aあ') === 3);
    check('絵文字は2', post.countWeight('🎉') === 2);
    check('半角スペース・記号は1', post.countWeight(' #-') === 3);

    check('半角280は通る', post.validatePostText('a'.repeat(280)) === null);
    check('半角281は拒否', post.validatePostText('a'.repeat(281)) !== null);
    check('全角140は通る', post.validatePostText('あ'.repeat(140)) === null);
    check('全角141は拒否', post.validatePostText('あ'.repeat(141)) !== null);
    check('空は拒否', post.validatePostText('   ') !== null);
  }

  /* ================================================================ */
  section('intent リンク（x.com）');

  {
    const tricky = '改行\nあり # ハッシュ & アンパサンド 絵文字🎉';
    const url = post.buildIntentUrl(tricky);

    check('x.com の intent になる', url.startsWith('https://x.com/intent/post?text='));

    const encoded = url.slice('https://x.com/intent/post?text='.length);
    check('復号すると本文へ完全に戻る', decodeURIComponent(encoded) === tricky);
    check('URL を壊す文字が生で残らない', !/[\n #&=?]/.test(encoded));
    check('new URL でパースできる', new URL(url).searchParams.get('text') === tricky);
  }

  /* ================================================================ */
  section('端末内保存（Threads 版の複製・要点のみ）');

  {
    const storage = makeStorage();

    check('保存キーが Threads 版と別', config.STORAGE_KEY === 'tsam-x-post-v1');

    const draft = post.saveDraft('下書き', { storage, now: 1000 });
    check('保存と一覧', post.listDrafts({ storage })[0].id === draft.id);

    post.recordHistory('投稿画面を開いた', '本文', { storage, now: 2000 });
    check('履歴が残る', post.listHistory({ storage })[0].kind === '投稿画面を開いた');

    storage.setItem(config.STORAGE_KEY, '{broken');
    check('壊れた保存データは読み捨てる', post.listDrafts({ storage }).length === 0);
  }

  {
    /* 調整プロンプトの保存（Threads 版の複製・要点のみ）。 */
    const storage = makeStorage();
    post.saveStylePrompt('絵文字は使わない', { storage });
    post.saveDraft('下書き', { storage });
    check('調整プロンプトが残る', post.loadStylePrompt({ storage }) === '絵文字は使わない');
  }

  /* ================================================================ */
  section('Gemini（プロンプトの差分のみ）');

  {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '生成結果' }] } }] }),
      };
    };

    const text = await gemini.generatePost({
      apiKey: 'FAKE', theme: '新商品の告知', stylePrompt: 'ですます調で', fetchImpl,
    });
    check('生成できる', text === '生成結果');

    const body = JSON.parse(calls[0].options.body);
    check('調整プロンプトが要求に載る',
      body.contents[0].parts[0].text.includes('# 書き方の調整（利用者設定）')
      && body.contents[0].parts[0].text.includes('ですます調で'));
    const prompt = body.contents[0].parts[0].text;
    check('X 向けのプロンプトになっている', prompt.includes('X（旧 Twitter）'));
    check('140字制約（全角=2の説明つき）が入る',
      prompt.includes('140文字以内') && prompt.includes('全角1文字が2'));
    check('創作の禁止が入る', prompt.includes('創作の禁止'));
    check('キーはヘッダーで渡す', calls[0].options.headers['x-goog-api-key'] === 'FAKE');
  }

  {
    let error = null;
    try {
      await gemini.generatePost({ apiKey: '', theme: 'x' });
    } catch (caught) {
      error = caught;
    }
    check('キー未設定は KEY_MISSING', error?.code === gemini.GeminiErrorCode.KEY_MISSING);
  }
} catch (error) {
  fatal(error);
}

finish();
