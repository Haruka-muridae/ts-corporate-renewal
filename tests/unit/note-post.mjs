/*
 * note 下書きアプリ（public/production-app/note-post/）のスイート。
 *
 * Threads 版（threads-post.mjs）との違いは2点で、そこを重点的に固定する。
 *   - intent が無く、作成画面の URL（note.com/notes/new）を開くだけなこと
 *   - 生成が「記事」（1500〜2000字目安・見出しつき）であること
 * 保存の骨格は Threads 版の複製なので、要点だけ通す。
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

const POST = '../../public/production-app/note-post/post.js';
const GEMINI = '../../public/production-app/note-post/gemini.js';
const CONFIG = '../../public/production-app/note-post/config.js';

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
  section('検証と作成画面の URL');

  {
    check('空は拒否', post.validatePostText('   ') !== null);
    check('上限内は通る', post.validatePostText('あ'.repeat(config.TEXT_LIMIT)) === null);
    check('上限超えは拒否', post.validatePostText('あ'.repeat(config.TEXT_LIMIT + 1)) !== null);

    check('作成画面の URL は固定（本文プリフィルは存在しない）',
      post.buildEditorUrl() === 'https://note.com/notes/new');
  }

  /* ================================================================ */
  section('端末内保存（Threads 版の複製・要点のみ）');

  {
    const storage = makeStorage();

    check('保存キーが他アプリと別', config.STORAGE_KEY === 'tsam-note-post-v1');

    const draft = post.saveDraft('記事の下書き', { storage, now: 1000 });
    check('保存と一覧', post.listDrafts({ storage })[0].id === draft.id);

    post.recordHistory('作成画面を開いた', '本文', { storage, now: 2000 });
    check('履歴の種別が note 向け', post.listHistory({ storage })[0].kind === '作成画面を開いた');

    storage.setItem(config.STORAGE_KEY, '{broken');
    check('壊れた保存データは読み捨てる', post.listDrafts({ storage }).length === 0);
  }

  {
    /* 調整プロンプトの保存（Threads 版の複製・要点のみ）。 */
    const storage = makeStorage();
    post.saveStylePrompt('専門用語には注釈を付ける', { storage });
    post.saveDraft('下書き', { storage });
    check('調整プロンプトが残る',
      post.loadStylePrompt({ storage }) === '専門用語には注釈を付ける');
  }

  /* ================================================================ */
  section('Gemini（記事向けプロンプトの差分のみ）');

  {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '## 見出し\n本文' }] } }] }),
      };
    };

    const text = await gemini.generatePost({
      apiKey: 'FAKE', theme: 'AI導入の始め方', stylePrompt: '結論を先に書く', fetchImpl,
    });
    check('生成できる', text === '## 見出し\n本文');

    const body = JSON.parse(calls[0].options.body);
    check('調整プロンプトが要求に載る',
      body.contents[0].parts[0].text.includes('# 書き方の調整（利用者設定）')
      && body.contents[0].parts[0].text.includes('結論を先に書く'));
    const prompt = body.contents[0].parts[0].text;
    check('note 記事向けのプロンプトになっている', prompt.includes('note に投稿する記事'));
    check('目安文字数が入る',
      prompt.includes(`${config.BODY_TARGET_MIN}〜${config.BODY_TARGET_MAX}`));
    check('見出しの指示が入る', prompt.includes('## 見出し'));
    check('創作の禁止が入る', prompt.includes('創作の禁止'));
    check('記事向けに出力トークン上限を広げてある',
      body.generationConfig.maxOutputTokens === 4096 && config.MAX_OUTPUT_TOKENS === 4096);
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
