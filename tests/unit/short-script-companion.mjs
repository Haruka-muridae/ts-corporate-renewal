/*
 * ショート動画 台本メーカーの補助サービス連携（エンジン状態の3状態化）の検証。
 *
 * ------------------------------------------------------------------
 * 実サービスへ通信しない
 * ------------------------------------------------------------------
 * ai-video-app はテスト環境に存在しない。fetch はすべてスタブし、
 * companion.js の判定（ヘッダの正規化・ステータスの伝搬・ポーリング）
 * だけを検証する（card-ocr.mjs と同じ方針）。
 * ------------------------------------------------------------------
 *
 * app.js / index.html は DOM 前提のため import せず、ソースの静的検証で
 * 「3状態の分岐・起動ボタン・文言」が存在することを確かめる。
 */

import { readFile } from 'node:fs/promises';
import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

const APP_DIR = new URL('../../public/production-app/short-script/', import.meta.url);

/* ---------------------------------------------------------------- */
/* fetch のスタブ。呼び出しを記録し、応答を1件ずつ返す。               */
/* ---------------------------------------------------------------- */

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[name] ?? null;
      },
    },
    json: async () => body,
  };
}

/*
 * 応答（または Error）を順に返す fetch を据える。
 * 戻り値は記録された呼び出しの配列 [{ url, options }]。
 */
function installFetchStub(responses) {
  const calls = [];
  let index = 0;

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });

    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;

    if (next instanceof Error) {
      throw next;
    }

    return next;
  };

  return calls;
}

const realFetch = globalThis.fetch;

function restoreFetch() {
  globalThis.fetch = realFetch;
}

try {
  const config = await import('../../public/production-app/short-script/config.js');
  const companion = await import('../../public/production-app/short-script/companion.js');

  /* ================================================================ */
  section('設定（config.js）');

  check(
    'ポーリング間隔が定義されている（2秒）',
    config.ENGINE_START_POLL_INTERVAL_MS === 2000,
    String(config.ENGINE_START_POLL_INTERVAL_MS),
  );
  check(
    '**待ち時間の上限が実測（7.9秒）に対して十分な余裕を持つ**',
    config.ENGINE_START_TIMEOUT_MS >= 20000,
    String(config.ENGINE_START_TIMEOUT_MS),
  );
  check(
    '間隔が上限より短い（最低1回は再確認できる）',
    config.ENGINE_START_POLL_INTERVAL_MS < config.ENGINE_START_TIMEOUT_MS,
  );

  /* ================================================================ */
  section('話者取得と X-Engine-Status（fetchSpeakers）');

  {
    /* 到達不可（未起動・CORS拒否）。 */
    installFetchStub([new Error('connection refused')]);
    const result = await companion.fetchSpeakers();

    check('到達不可なら ok=false', result.ok === false);
    check('到達不可でも speakers は配列', Array.isArray(result.speakers) && result.speakers.length === 0);
    check('到達不可の engineStatus は null', result.engineStatus === null);
    restoreFetch();
  }

  {
    /* ヘッダ online。 */
    installFetchStub([
      jsonResponse([{ id: 3, label: 'ずんだもん（ノーマル）' }], {
        headers: { 'X-Engine-Status': 'online' },
      }),
    ]);
    const result = await companion.fetchSpeakers();

    check('online: ok=true', result.ok === true);
    check('online: 話者を返す', result.speakers.length === 1 && result.speakers[0].id === 3);
    check('online: engineStatus=online', result.engineStatus === 'online');
    restoreFetch();
  }

  {
    /* ヘッダ offline。本文は従来どおり配列（フォールバック一覧）。 */
    installFetchStub([
      jsonResponse([{ id: 3, label: 'ずんだもん（ノーマル）' }], {
        headers: { 'X-Engine-Status': 'offline' },
      }),
    ]);
    const result = await companion.fetchSpeakers();

    check('**offline でも ok=true（アプリ自体は応答している）**', result.ok === true);
    check('offline: engineStatus=offline', result.engineStatus === 'offline');
    check('offline でもフォールバックの話者は返す', result.speakers.length === 1);
    restoreFetch();
  }

  {
    /* ヘッダ mock。 */
    installFetchStub([jsonResponse([], { headers: { 'X-Engine-Status': 'mock' } })]);
    const result = await companion.fetchSpeakers();

    check('mock: engineStatus=mock（online に潰さない）', result.engineStatus === 'mock');
    restoreFetch();
  }

  {
    /* **ヘッダ無し＝旧版。** null を返し、online 扱いの判断は app.js に委ねる。 */
    installFetchStub([jsonResponse([{ id: 3, label: 'x' }])]);
    const result = await companion.fetchSpeakers();

    check('**ヘッダ欠落（旧版）は engineStatus=null**', result.engineStatus === null);
    check('ヘッダ欠落でも ok=true', result.ok === true);
    restoreFetch();
  }

  {
    /* 未知の値もヘッダ欠落と同じく null（将来値を誤解釈しない）。 */
    installFetchStub([jsonResponse([], { headers: { 'X-Engine-Status': 'starting' } })]);
    const result = await companion.fetchSpeakers();

    check('未知の値は null に正規化する', result.engineStatus === null);
    restoreFetch();
  }

  /* ================================================================ */
  section('エンジン状態（fetchEngineStatus）');

  {
    const calls = installFetchStub([jsonResponse({ installed: true, running: true, version: '0.25.2' })]);
    const result = await companion.fetchEngineStatus();

    check('/api/engine/status を GET する', calls[0].url.endsWith('/api/engine/status'));
    check('running=true を online にする', result.ok === true && result.online === true);
    restoreFetch();
  }

  {
    installFetchStub([jsonResponse({ installed: true, running: false })]);
    const result = await companion.fetchEngineStatus();

    check('running=false は ok=true / online=false', result.ok === true && result.online === false);
    restoreFetch();
  }

  {
    installFetchStub([new Error('connection refused')]);
    const result = await companion.fetchEngineStatus();

    check('**到達不可は ok=false（アプリ自体が落ちている）**', result.ok === false && result.online === false);
    restoreFetch();
  }

  /* ================================================================ */
  section('エンジン起動（startEngine）');

  {
    const calls = installFetchStub([jsonResponse({ ok: true, running: true, reason: 'started' })]);
    const result = await companion.startEngine();

    check('/api/engine/start へ送る', calls[0].url.endsWith('/api/engine/start'));
    check('POST で送る', calls[0].options.method === 'POST');
    check("credentials は omit（資格情報を使わない）", calls[0].options.credentials === 'omit');
    check('成功は ok=true / status=200', result.ok === true && result.status === 200);
    restoreFetch();
  }

  {
    /* 旧版（当該 API なし）は 404。呼び出し側の案内分岐に使う。 */
    installFetchStub([jsonResponse({}, { status: 404 })]);
    const result = await companion.startEngine();

    check('**404 を status で返す（旧版検出）**', result.ok === false && result.status === 404);
    restoreFetch();
  }

  {
    /* 409＝VOICEVOX 未インストール。ボディの reason / downloadUrl を透過する
       （呼び出し側が待たずに未インストールの案内＋公式サイトへの誘導を出すため）。 */
    installFetchStub([
      jsonResponse(
        { ok: false, reason: 'not_installed', downloadUrl: 'https://voicevox.hiroshiba.jp/' },
        { status: 409 },
      ),
    ]);
    const result = await companion.startEngine();

    check('**409 は ok=false / status=409（未インストール検出）**', result.ok === false && result.status === 409);
    check('**409 の reason を透過する**', result.reason === 'not_installed');
    check('**409 の downloadUrl を透過する**', result.downloadUrl === 'https://voicevox.hiroshiba.jp/');
    restoreFetch();
  }

  {
    /* エラー応答のボディが JSON でない場合。reason / downloadUrl は null に落とす。 */
    installFetchStub([
      {
        ok: false,
        status: 504,
        headers: { get: () => null },
        json: async () => {
          throw new Error('not json');
        },
      },
    ]);
    const result = await companion.startEngine();

    check('**JSON でないボディは reason=null / downloadUrl=null**', result.reason === null && result.downloadUrl === null);
    check('JSON でなくても status は返す', result.status === 504);
    restoreFetch();
  }

  {
    installFetchStub([new Error('connection refused')]);
    const result = await companion.startEngine();

    check('通信断は status=0', result.ok === false && result.status === 0);
    check('通信断も reason=null / downloadUrl=null', result.reason === null && result.downloadUrl === null);
    restoreFetch();
  }

  /* ================================================================ */
  section('online 待ち（waitForEngineOnline）');

  {
    /* offline → offline → online の系列。間隔0で回す（注入口の検証を兼ねる）。 */
    const calls = installFetchStub([
      jsonResponse({ running: false }),
      jsonResponse({ running: false }),
      jsonResponse({ running: true }),
    ]);

    let ticks = 0;
    const result = await companion.waitForEngineOnline({
      intervalMs: 0,
      timeoutMs: 5000,
      onTick: () => { ticks += 1; },
    });

    check('online になったら { online:true }', result.online === true);
    check('online まで確認を繰り返す', calls.length === 3, String(calls.length));
    check('offline のたびに onTick が呼ばれる', ticks === 2, String(ticks));
    restoreFetch();
  }

  {
    /* ずっと offline。期限超過で { online:false }。 */
    installFetchStub([jsonResponse({ running: false })]);
    const result = await companion.waitForEngineOnline({ intervalMs: 0, timeoutMs: 0 });

    check('**期限を超えたら { online:false } で返る（固まらない）**', result.online === false);
    restoreFetch();
  }

  {
    /* アプリ自体が落ちても（fetch 失敗）例外にせず期限まで待って false。 */
    installFetchStub([new Error('connection refused')]);
    const result = await companion.waitForEngineOnline({ intervalMs: 0, timeoutMs: 0 });

    check('到達不可でも例外にしない', result.online === false);
    restoreFetch();
  }

  {
    /* アプリ断が2回連続。期限（ここでは5秒）を待たずに unreachable で抜ける。 */
    const calls = installFetchStub([
      new Error('connection refused'),
      new Error('connection refused'),
    ]);
    const result = await companion.waitForEngineOnline({ intervalMs: 0, timeoutMs: 5000 });

    check(
      '**ok:false が2回連続したら unreachable で早期終了する**',
      result.online === false && result.unreachable === true,
    );
    check('2回目の失敗で打ち切る（期限まで待たない）', calls.length === 2, String(calls.length));
    restoreFetch();
  }

  {
    /* 1回だけの失敗（瞬断）→復帰。早期終了せず online まで待つ。 */
    const calls = installFetchStub([
      new Error('connection refused'),
      jsonResponse({ running: false }),
      jsonResponse({ running: true }),
    ]);
    const result = await companion.waitForEngineOnline({ intervalMs: 0, timeoutMs: 5000 });

    check('**1回だけの失敗では早期終了しない（復帰後に online へ到達する）**', result.online === true);
    check('瞬断を挟んでも確認を続ける', calls.length === 3, String(calls.length));
    check('復帰した場合 unreachable は付かない', result.unreachable !== true);
    restoreFetch();
  }

  /* ================================================================ */
  section('画面（index.html）');

  const htmlSource = await readFile(new URL('index.html', APP_DIR), 'utf8');

  check(
    '「エンジンを起動」ボタンがある',
    /<button id="ss-engine-start"/.test(htmlSource),
  );
  check(
    '**起動ボタンは既定 hidden（表示制御は app.js のみ）**',
    /id="ss-engine-start"[^>]*hidden/.test(htmlSource),
  );
  check(
    '起動ボタンは案内パネル（ss-companion-guidance）の中にある',
    htmlSource.indexOf('id="ss-engine-start"') > htmlSource.indexOf('id="ss-companion-guidance"')
      && htmlSource.indexOf('id="ss-engine-start"') < htmlSource.indexOf('id="ss-companion-retry"'),
  );
  check(
    '案内パネルは aria-live（進行文言が読み上げられる）',
    /id="ss-companion-guidance"[^>]*aria-live="polite"/.test(htmlSource),
  );
  check(
    'type="button"（フォーム送信を起こさない）',
    /id="ss-engine-start" type="button"/.test(htmlSource),
  );

  {
    /* CSP は変えない（起動APIも同じ 127.0.0.1:3000 なので追加は不要）。 */
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(htmlSource)?.[1] ?? '';
    const connect = /connect-src ([^;]+)/.exec(csp)?.[1] ?? '';
    const allowedConnect = [
      "'self'",
      'https://generativelanguage.googleapis.com',
      'https://script.google.com',
      'https://script.googleusercontent.com',
      'http://127.0.0.1:3000',
      'http://localhost:3000',
    ];

    check('CSP を宣言している', csp !== '');
    check(
      '**connect-src が従来の許可先のまま（新しい原点を足していない）**',
      connect.trim().split(/\s+/).every((host) => allowedConnect.includes(host)),
      connect,
    );
    check("script-src は 'self' のみ", csp.includes("script-src 'self';"));
    check('CSP に unsafe-inline / unsafe-eval が無い', !/unsafe-inline|unsafe-eval/.test(csp));
  }

  {
    /* ID の重複が無いこと（getElementById が別物を掴む事故の再発防止）。 */
    const ids = [...htmlSource.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);

    check('同じ id の要素が2つ無い', duplicated.length === 0, [...new Set(duplicated)].join(', '));
  }

  /* ================================================================ */
  section('3状態と起動ハンドラ（app.js）');

  const appSource = await readFile(new URL('app.js', APP_DIR), 'utf8');

  check(
    "**3状態を持つ（'engine-offline' が存在する）**",
    appSource.includes("'engine-offline'"),
  );
  check(
    'companionReady は companionState の導出値',
    /companionReady = state === 'online'/.test(appSource),
  );
  check(
    '**mock を online にしない（engine-offline へ倒す）**',
    /engineStatus === 'offline' \|\| engineStatus === 'mock'/.test(appSource),
  );
  check(
    '起動の多重実行を防いでいる（engineStarting）',
    /if \(engineStarting \|\|/.test(appSource),
  );
  check(
    'waitForEngineOnline で online を待つ',
    /waitForEngineOnline\(\)/.test(appSource),
  );
  check(
    '**成功時は refreshCompanion の呼び直しに集約する**',
    /if \(online\) \{\s*\n\s*await refreshCompanion\(\);/.test(appSource),
  );
  check(
    'finally でフラグ解除とボタン再有効化をする',
    /finally \{[\s\S]{0,200}engineStarting = false[\s\S]{0,200}disabled = false/.test(appSource),
  );
  check(
    /* コメント中の「innerHTML を使わない」に反応しないよう、実使用（.innerHTML）だけを見る。 */
    'innerHTML を使わない',
    !/\.innerHTML/.test(appSource),
  );

  {
    /* 文言の実在。案内が3状態それぞれで異なること。 */
    check(
      'offline の文言（ai-video-app の起動を促す）',
      appSource.includes('お使いのPCの動画生成サービス（ai-video-app）に接続できません。ai-video-app を起動してから「再確認する」を押してください。'),
    );
    check(
      'engine-offline の文言（画面から起動できることを伝える）',
      appSource.includes('動画生成サービス（ai-video-app）は起動していますが、音声エンジン（VOICEVOX）が停止しています。「エンジンを起動」を押すと、この画面から起動できます（30秒ほどかかることがあります）。'),
    );
    check(
      '**404（旧版）の文言（手動起動へ誘導する）**',
      appSource.includes('お使いの ai-video-app が古いため、この画面からは起動できません。VOICEVOX を手動で起動してから「再確認する」を押してください。'),
    );
    check(
      'タイムアウトの文言（インストール確認と手動起動へ誘導する）',
      appSource.includes('起動を確認できませんでした。VOICEVOX が正しくインストールされているかを確認のうえ、手動で起動してから「再確認する」を押してください。'),
    );
  }

  {
    /* 409（未インストール）とアプリ断（unreachable）の分岐・文言の実在。 */
    check(
      '**409 はポーリングせず即時に案内する分岐がある**',
      /if \(status === 409\)/.test(appSource),
    );
    check(
      '**409 の文言（インストールへ誘導する）**',
      appSource.includes('VOICEVOX がインストールされていません。公式サイトからインストールしてから「再確認する」を押してください。'),
    );
    check(
      'downloadUrl のリンクは rel=noopener を付ける（別タブで開くため）',
      appSource.includes("rel = 'noopener"),
    );
    check(
      'downloadUrl は http(s) 形式だけを href に入れる',
      appSource.includes('/^https?:\\/\\//.test(downloadUrl)'),
    );
    check(
      '**unreachable（ポーリング中のアプリ断）を offline 表示へ流す分岐がある**',
      /if \(unreachable\) \{[\s\S]{0,400}await refreshCompanion\(\);/.test(appSource),
    );
    check(
      '**アプリ断の文言（ai-video-app の起動し直しへ誘導する）**',
      appSource.includes('ai-video-app への接続が失われました。ai-video-app を起動し直してから「再確認する」を押してください。'),
    );
  }

  finish();
} catch (error) {
  restoreFetch();
  fatal(error);
}
