/*
 * 名刺OCR フェーズ0 検証ページ（public/production-app/card-ocr/poc/）の検証。
 *
 * ------------------------------------------------------------------
 * 実APIへ通信しない
 * ------------------------------------------------------------------
 * Gemini も Google API も呼ばない。fetch はすべてスタブする。
 * keystore-spec-v1.md §7 と同じ方針で、要件定義書 §13.4 が要求している。
 *
 * ここで確かめるのは「キーの扱い」「送信先」「応答の解釈」であって、
 * Gemini の分類精度ではない。精度はフェーズ0の実測で見る
 * （docs/specs/card-ocr-phase0-plan.md §5-12）。
 * ------------------------------------------------------------------
 */

import { readFile } from 'node:fs/promises';
import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

const POC_DIR = new URL('../../public/production-app/card-ocr/poc/', import.meta.url);

try {
  const gemini = await import('../../public/production-app/card-ocr/poc/gemini.js');
  const prompt = await import('../../public/production-app/card-ocr/poc/prompt.js');
  const sanitize = await import('../../public/production-app/card-ocr/poc/sanitize.js');

  /* ---------------------------------------------------------------- */
  section('数式インジェクション対策（要件定義書 FR-18）');

  const escapeCases = [
    ['=1+1', "'=1+1"],
    ['=HYPERLINK("http://evil.example","x")', '\'=HYPERLINK("http://evil.example","x")'],
    ['+81312345678', "'+81312345678"],
    ['-5', "'-5"],
    ['@example.com', "'@example.com"],
    ['株式会社サンプル商事', '株式会社サンプル商事'],
    ['taro@example.com', 'taro@example.com'],
    ['', ''],
  ];

  for (const [input, expected] of escapeCases) {
    check(
      `escapeCellText(${JSON.stringify(input).slice(0, 30)})`,
      sanitize.escapeCellText(input) === expected,
      sanitize.escapeCellText(input),
    );
  }

  check('null でも壊れない', sanitize.escapeCellText(null) === '');
  check('undefined でも壊れない', sanitize.escapeCellText(undefined) === '');

  const long = 'あ'.repeat(sanitize.SHORT_CELL_MAX_LENGTH + 100);
  check(
    '上限を超えたら切り詰める',
    sanitize.escapeCellText(long).length === sanitize.SHORT_CELL_MAX_LENGTH,
    String(sanitize.escapeCellText(long).length),
  );

  check(
    'OCR本文は上限が広い',
    sanitize.escapeOcrText('あ'.repeat(2000)).length === 2000,
  );

  /* ---------------------------------------------------------------- */
  section('プロンプトと構造化出力の定義（FR-12 / FR-13）');

  check('プロンプトにバージョンが付いている', prompt.PROMPT_VERSION !== '');
  check(
    '推測を禁じる指示が入っている',
    prompt.SYSTEM_INSTRUCTION.includes('補わない') && prompt.SYSTEM_INSTRUCTION.includes('推測しない'),
  );
  check(
    '行順が原稿と一致しない前提が入っている',
    prompt.SYSTEM_INSTRUCTION.includes('行の順序は原稿と一致しない'),
  );

  check(
    'confidence を持たせていない',
    !('confidence' in prompt.CARD_SCHEMA.properties),
  );
  check(
    'uncertainFields を持っている',
    prompt.CARD_SCHEMA.properties.uncertainFields?.type === 'array',
  );

  for (const field of ['companyName', 'fullName', 'email', 'phone', 'uncertainFields']) {
    check(`必須項目に ${field} がある`, prompt.CARD_SCHEMA.required.includes(field));
  }

  const request = prompt.buildGeminiRequest('テスト');
  check('履歴を持たせない（1リクエスト1名刺）', request.contents.length === 1);
  check('JSON で返させる', request.generationConfig.responseMimeType === 'application/json');
  check('スキーマを渡している', request.generationConfig.responseSchema === prompt.CARD_SCHEMA);
  check('出力上限の既定は400トークン', request.generationConfig.maxOutputTokens === 400);
  check('温度は0（分類であって創作ではない）', request.generationConfig.temperature === 0);

  check(
    'サンプルは行順違いで同じ行を持つ',
    prompt.SAMPLE_ORDERED.split('\n').sort().join('|')
      === prompt.SAMPLE_SHUFFLED.split('\n').sort().join('|'),
  );
  check(
    'サンプルの行順は入れ替わっている',
    prompt.SAMPLE_ORDERED !== prompt.SAMPLE_SHUFFLED,
  );
  check(
    'サンプルは example.com など架空のドメインだけを使う',
    /@example\.com/.test(prompt.SAMPLE_ORDERED) && !/@(?!example\.com)[a-z0-9.-]+\.[a-z]{2,}/i.test(prompt.SAMPLE_ORDERED),
  );

  /* ---------------------------------------------------------------- */
  section('Gemini 呼び出し（キーの扱いと送信先）');

  const okBody = {
    candidates: [{
      content: {
        parts: [{
          text: JSON.stringify({
            companyName: '株式会社サンプル商事',
            fullName: '見本 太郎',
            email: 'taro.mihon@example.com',
            phone: '03-1234-5678',
            uncertainFields: [],
          }),
        }],
      },
    }],
  };

  /* 呼び出しを記録するスタブ。実通信はしない。 */
  function makeStub(response) {
    const calls = [];

    const impl = async (url, options) => {
      calls.push({ url: String(url), options });
      return response;
    };

    return { impl, calls };
  }

  function jsonResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }

  const KEY = 'AIzaTESTKEY_not_a_real_key_0000000000';

  {
    const stub = makeStub(jsonResponse(okBody));
    const result = await gemini.classifyCardText('テキスト', { apiKey: KEY, fetchImpl: stub.impl });

    check('分類結果を返す', result.fullName === '見本 太郎');
    check('1回だけ呼ぶ', stub.calls.length === 1);

    const call = stub.calls[0];

    check(
      '送信先は generativelanguage.googleapis.com のみ',
      new URL(call.url).host === gemini.GEMINI_HOST,
      call.url,
    );
    check(
      '要件定義書 §12 の3系統以外へ出ていない',
      ['generativelanguage.googleapis.com', 'www.googleapis.com', 'sheets.googleapis.com']
        .includes(new URL(call.url).host),
    );

    /* キーの扱い。ここが崩れると keystore-spec-v1.md §2 に反する。 */
    check('キーは x-goog-api-key ヘッダーで送る', call.options.headers['x-goog-api-key'] === KEY);
    check('キーが URL に出ていない', !call.url.includes(KEY));
    check('キーが本文に出ていない', !String(call.options.body).includes(KEY));
    check('当社ドメインへは送っていない', !call.url.includes('tsam-ai.com'));
    check('画像を送っていない', !String(call.options.body).includes('inlineData'));
    check('POST で送る', call.options.method === 'POST');
  }

  {
    const stub = makeStub(jsonResponse(okBody));
    await gemini.classifyCardText('テキスト', { apiKey: `  ${KEY}  `, fetchImpl: stub.impl });
    check('キーの前後の空白を落として送る', stub.calls[0].options.headers['x-goog-api-key'] === KEY);
  }

  /* ---------------------------------------------------------------- */
  section('Gemini のエラー処理（§15 のコードへの対応）');

  const errorCases = [
    [0, gemini.GeminiErrorCode.KEY_MISSING, 'KEY-001', ''],
    [401, gemini.GeminiErrorCode.KEY_REJECTED, 'KEY-002', KEY],
    [403, gemini.GeminiErrorCode.KEY_REJECTED, 'KEY-002', KEY],
    [429, gemini.GeminiErrorCode.RATE_LIMITED, 'AI-002', KEY],
  ];

  for (const [status, expectedCode, expectedErrorCode, key] of errorCases) {
    const stub = makeStub(jsonResponse({}, status));
    let caught = null;

    try {
      await gemini.classifyCardText('テキスト', {
        apiKey: key,
        fetchImpl: stub.impl,
        /* 404 以外はフォールバックしないことを確かめるため既定のまま。 */
      });
    } catch (error) {
      caught = error;
    }

    check(`status ${status} → ${expectedCode}`, caught?.code === expectedCode, caught?.code);
    check(
      `status ${status} の画面表示は ${expectedErrorCode}`,
      gemini.describeGeminiError(caught).errorCode === expectedErrorCode,
    );
    check(`status ${status} の例外にキーが含まれない`, !String(caught?.message ?? '').includes(KEY));
  }

  {
    /* 404 のときだけフォールバックモデルで1回試す。 */
    const calls = [];
    const impl = async (url) => {
      calls.push(String(url));
      return calls.length === 1 ? jsonResponse({}, 404) : jsonResponse(okBody);
    };

    const result = await gemini.classifyCardText('テキスト', { apiKey: KEY, fetchImpl: impl });

    check('404 でフォールバックモデルを1回試す', calls.length === 2);
    check('1回目は主モデル', calls[0].includes(gemini.DEFAULT_MODEL));
    check('2回目はフォールバックモデル', calls[1].includes(gemini.FALLBACK_MODEL));
    check('フォールバックで結果が返る', result.fullName === '見本 太郎');
  }

  {
    /* 429 では再試行しない。無料枠のクォータを削るだけになる。 */
    const calls = [];
    const impl = async () => { calls.push(1); return jsonResponse({}, 429); };

    try {
      await gemini.classifyCardText('テキスト', { apiKey: KEY, fetchImpl: impl });
    } catch { /* 期待どおり */ }

    check('429 では再試行しない', calls.length === 1);
  }

  {
    const stub = makeStub(jsonResponse({ candidates: [{ content: { parts: [{ text: '{壊れた' }] } }] }));
    let caught = null;

    try {
      await gemini.classifyCardText('テキスト', { apiKey: KEY, fetchImpl: stub.impl });
    } catch (error) { caught = error; }

    check('壊れたJSONは AI-003', gemini.describeGeminiError(caught).errorCode === 'AI-003');
  }

  {
    const partial = { candidates: [{ content: { parts: [{ text: JSON.stringify({ companyName: 'x' }) }] } }] };
    const stub = makeStub(jsonResponse(partial));
    let caught = null;

    try {
      await gemini.classifyCardText('テキスト', { apiKey: KEY, fetchImpl: stub.impl });
    } catch (error) { caught = error; }

    check('必須項目が欠けたら AI-004', gemini.describeGeminiError(caught).errorCode === 'AI-004');
  }

  {
    const impl = async () => { throw new Error('offline'); };
    let caught = null;

    try {
      await gemini.classifyCardText('テキスト', { apiKey: KEY, fetchImpl: impl });
    } catch (error) { caught = error; }

    check('通信失敗は AI-001', gemini.describeGeminiError(caught).errorCode === 'AI-001');
    check('通信失敗の例外にキーが含まれない', !String(caught?.message ?? '').includes(KEY));
  }

  /* ---------------------------------------------------------------- */
  section('ページ本体のソース検査（守るべき制約）');

  const pocSource = await readFile(new URL('poc.js', POC_DIR), 'utf8');
  const htmlSource = await readFile(new URL('index.html', POC_DIR), 'utf8');
  const sources = [pocSource, await readFile(new URL('gemini.js', POC_DIR), 'utf8'),
    await readFile(new URL('prompt.js', POC_DIR), 'utf8'),
    await readFile(new URL('sanitize.js', POC_DIR), 'utf8')];

  check(
    'guardPage() を通している',
    pocSource.includes('guardPage'),
  );
  check(
    'setScreenDepth(3) を設定している（3階層下）',
    pocSource.includes('setScreenDepth(3)'),
  );
  check(
    'KeyStore を経由してキーを取る',
    pocSource.includes("KeyStore.get(PROVIDERS.gemini)"),
  );

  /*
   * 「使っていない」の検査は、実際の呼び出し形にだけ一致させる。
   * 語そのものを禁じると、禁止理由を説明したコメントまで引っかかり、
   * 説明を書けなくなる。
   */
  for (const source of sources) {
    check(
      'localStorage を直接触っていない（keystore-spec §2-1）',
      !/localStorage\s*[.[]/.test(source),
    );
    check(
      'テスト環境（apps/）から import していない',
      !/from\s+['"][^'"]*\/apps\//.test(source),
    );
    check(
      'キーを console へ出していない',
      !/console\.(log|error|warn|info)/.test(source),
    );
  }

  check(
    'innerHTML を使っていない（§14.3）',
    !/\.innerHTML/.test(pocSource),
  );
  check(
    '検索避けを入れている（検証ページのため）',
    /name="robots"\s+content="noindex/.test(htmlSource),
  );
  check(
    '撤去予定であることを画面に出している',
    htmlSource.includes('検証用のページです') && htmlSource.includes('撤去'),
  );

  /* 許可された外部ホスト以外がソースに現れないこと。 */
  const allowedHosts = [
    'generativelanguage.googleapis.com',
    'www.googleapis.com',
    'sheets.googleapis.com',
  ];

  for (const source of sources) {
    const hosts = [...source.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
    const unexpected = hosts.filter((host) => !allowedHosts.includes(host) && !host.endsWith('example.com'));

    check(
      '許可されていない外部ホストがソースに無い',
      unexpected.length === 0,
      unexpected.join(', '),
    );
  }

  finish();
} catch (error) {
  fatal(error);
}
