/*
 * スマホ完結版 体験試作(mobile-lab)の検証。
 * docs/specs/short-script-mobile-video-plan-v1.md §6。
 *
 * Node で検証できるものだけを対象にする(実ブラウザ・実機の確認は対象外。
 * §6「実機頼みのもの」)。
 *   1. subtitle.mjs(複製)の純関数
 *   2. 分割ローダーの純関数(マニフェスト解釈・結合・SHA-256不一致拒否)
 *   3. 経路選択・解像度ネゴシエーションの純関数
 *   4. タイムライン計算の純関数
 *   5. vendor-manifest.json と実ファイルのSHA-256整合(ベンダー整合)
 *   6. ソース静的検証(CSP・innerHTML不使用・WakeLock呼び出しの実在)
 */

import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

const APP_DIR = new URL('../../public/production-app/short-script/', import.meta.url);
const LAB_DIR = new URL('../../public/production-app/short-script/mobile-lab/', import.meta.url);
const VENDOR_DIR = new URL('../../public/production-app/short-script/vendor/', import.meta.url);

async function main() {
  const subtitle = await import(new URL('subtitle.mjs', LAB_DIR).href);
  const loader = await import(new URL('vendor-loader.mjs', LAB_DIR).href);
  const routeSelection = await import(new URL('route-selection.mjs', LAB_DIR).href);
  const timeline = await import(new URL('timeline.mjs', LAB_DIR).href);

  /* ---------------------------------------------------------------- */
  section('subtitle.mjs: chunkText(句読点優先分割)');
  /* ---------------------------------------------------------------- */
  {
    check(
      '短い文はそのまま1チャンク(空白は除去)',
      JSON.stringify(subtitle.chunkText('こんにちは 今日は')) === JSON.stringify(['こんにちは今日は'])
    );

    const punctText = 'あ'.repeat(10) + '。' + 'い'.repeat(10) + '。' + 'う'.repeat(10) + '。';
    const punctResult = subtitle.chunkText(punctText);
    check(
      '句読点優先: 26文字(13x2)に収まる文節までまとめる',
      JSON.stringify(punctResult) ===
        JSON.stringify(['ああああああああああ。いいいいいいいいいい。', 'うううううううううう。']),
      punctResult
    );
  }

  /* ---------------------------------------------------------------- */
  section('subtitle.mjs: chunkText(強制分割)');
  /* ---------------------------------------------------------------- */
  {
    const forced = subtitle.chunkText('あ'.repeat(40));
    check('句読点が無い場合は26文字ずつ強制分割する', JSON.stringify(forced.map((c) => c.length)) === JSON.stringify([26, 14]));
    check('強制分割した先頭チャンクの中身', forced[0] === 'あ'.repeat(26));
    check('強制分割した末尾チャンクの中身', forced[1] === 'あ'.repeat(14));
  }

  /* ---------------------------------------------------------------- */
  section('subtitle.mjs: wrapChunk(2行折り返し)');
  /* ---------------------------------------------------------------- */
  {
    check('13文字以下は折り返さない', subtitle.wrapChunk('あいうえお') === 'あいうえお');

    const nearPunct = 'あ'.repeat(9) + '、' + 'い'.repeat(10);
    check(
      '読点の直後で折り返す(中央付近の読点を優先)',
      subtitle.wrapChunk(nearPunct) === 'あああああああああ、\\Nいいいいいいいいいい'
    );

    const noPunct = 'あ'.repeat(20);
    check('句読点が無ければ中央で折り返す', subtitle.wrapChunk(noPunct) === 'あ'.repeat(10) + '\\N' + 'あ'.repeat(10));
  }

  /* ---------------------------------------------------------------- */
  section('subtitle.mjs: buildAss(時刻書式・比例配分)');
  /* ---------------------------------------------------------------- */
  {
    const single = subtitle.buildAss([{ text: 'あ', startSec: 0, durationSec: 2 }]);
    check(
      '単一チャンクの開始・終了時刻(h:mm:ss.cs)',
      single.includes('Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,あ')
    );
    check('スタイル行のフォント名は複製元のまま(JASSUB側で同梱フォントへ対応付ける)', single.includes('Noto Sans CJK JP'));

    const punctText = 'あ'.repeat(10) + '。' + 'い'.repeat(10) + '。' + 'う'.repeat(10) + '。';
    const proportional = subtitle.buildAss([{ text: punctText, startSec: 5, durationSec: 3.3 }]);
    const lines = proportional.split('\n').filter((l) => l.startsWith('Dialogue:'));
    check('比例配分: 2チャンクぶんのDialogueが生成される', lines.length === 2, lines);
    check(
      '比例配分: 1つ目は開始5.00秒・文字数比(22/33)ぶんの尺',
      lines[0] === 'Dialogue: 0,0:00:05.00,0:00:07.19,Default,,0,0,0,,ああああああああああ。\\Nいいいいいいいいいい。',
      lines[0]
    );
    check(
      '比例配分: 2つ目は1つ目の終了時刻から開始し、シーン終了時刻で終わる',
      lines[1] === 'Dialogue: 0,0:00:07.19,0:00:08.29,Default,,0,0,0,,うううううううううう。',
      lines[1]
    );
  }

  /* ---------------------------------------------------------------- */
  section('vendor-loader.mjs: マニフェスト解釈');
  /* ---------------------------------------------------------------- */
  {
    const manifestJson = {
      cacheName: 'test-cache-v1',
      assets: [
        { id: 'a', path: 'a.bin', bytes: 10, sha256: 'x', parts: [{ path: 'a.bin', bytes: 10, sha256: 'x' }] },
        { id: 'b', path: 'b.bin', unavailable: true, reason: '取得できなかった' },
      ],
    };
    const parsed = loader.parseManifest(manifestJson);
    check('parseManifest: 正しい形式はそのまま返る', parsed === manifestJson);
    check('findAsset: idで1件見つかる', loader.findAsset(parsed, 'a').path === 'a.bin');
    check('findAsset: 無いidはnull', loader.findAsset(parsed, 'zzz') === null);
    check('totalDownloadBytes: unavailableは合計から除外する', loader.totalDownloadBytes(parsed) === 10);
    check('unavailableAssets: unavailableのものだけ返す', loader.unavailableAssets(parsed).length === 1);

    let threwOnMissingAssets = false;
    try {
      loader.parseManifest({ cacheName: 'x' });
    } catch {
      threwOnMissingAssets = true;
    }
    check('parseManifest: assets配列が無ければ例外', threwOnMissingAssets);

    check('formatMegabytes: 小数第1位まで(100MB未満)', loader.formatMegabytes(9_500_000) === '9.1MB');
    check('formatMegabytes: 100MB以上は整数', loader.formatMegabytes(150 * 1024 * 1024) === '150MB');
  }

  /* ---------------------------------------------------------------- */
  section('vendor-loader.mjs: パート結合とSHA-256検証');
  /* ---------------------------------------------------------------- */
  {
    const part1 = new Uint8Array([1, 2, 3]);
    const part2 = new Uint8Array([4, 5]);
    const combined = loader.combineParts([part1, part2]);
    check('combineParts: 結合結果の長さ', combined.length === 5);
    check('combineParts: 結合結果の中身', JSON.stringify(Array.from(combined)) === JSON.stringify([1, 2, 3, 4, 5]));

    const expectedHash = createHash('sha256').update(Buffer.from(combined)).digest('hex');
    const hexResult = await loader.sha256Hex(combined);
    check('sha256Hex: node:crypto と同じ値になる', hexResult === expectedHash);

    const okAsset = { id: 'ok', bytes: 5, sha256: expectedHash };
    let verifyOk = false;
    try {
      verifyOk = await loader.verifyAsset(okAsset, combined);
    } catch {
      verifyOk = false;
    }
    check('verifyAsset: ハッシュが一致すれば例外を投げない', verifyOk === true);

    const badAsset = { id: 'bad', bytes: 5, sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' };
    let rejected = false;
    try {
      await loader.verifyAsset(badAsset, combined);
    } catch {
      rejected = true;
    }
    check('verifyAsset: SHA-256が不一致なら例外を投げる(壊れたアセットを使わない)', rejected);

    const sizeMismatchAsset = { id: 'size', bytes: 999, sha256: expectedHash };
    let sizeRejected = false;
    try {
      await loader.verifyAsset(sizeMismatchAsset, combined);
    } catch {
      sizeRejected = true;
    }
    check('verifyAsset: サイズが不一致でも例外を投げる', sizeRejected);
  }

  /* ---------------------------------------------------------------- */
  section('route-selection.mjs: 経路選択');
  /* ---------------------------------------------------------------- */
  {
    check(
      '高速経路: VideoEncoderあり かつ AAC対応',
      routeSelection.selectRoute({ hasVideoEncoder: true, aacEncodeSupported: true }) === routeSelection.ROUTE_FAST
    );
    check(
      'リアルタイム経路: VideoEncoderあり かつ AAC非対応',
      routeSelection.selectRoute({ hasVideoEncoder: true, aacEncodeSupported: false }) === routeSelection.ROUTE_REALTIME
    );
    check(
      '非対応: VideoEncoderなし(AAC対応可否によらない)',
      routeSelection.selectRoute({ hasVideoEncoder: false, aacEncodeSupported: true }) === routeSelection.ROUTE_UNSUPPORTED
    );
  }

  /* ---------------------------------------------------------------- */
  section('route-selection.mjs: 解像度ネゴシエーション');
  /* ---------------------------------------------------------------- */
  {
    const allSupported = await routeSelection.negotiateResolution(async () => true);
    check('全解像度対応なら1080x1920を選ぶ', allSupported.label === '1080x1920');

    const only720 = await routeSelection.negotiateResolution(async ({ width }) => width <= 720);
    check('1080が失敗すれば720x1280へ降格する', only720.label === '720x1280');

    const only540 = await routeSelection.negotiateResolution(async ({ width }) => width <= 540);
    check('1080・720が失敗すれば540x960へ降格する', only540.label === '540x960');

    const none = await routeSelection.negotiateResolution(async () => false);
    check('どれも対応しなければnull(非対応案内へ)', none === null);
  }

  /* ---------------------------------------------------------------- */
  section('timeline.mjs: シーン開始秒・Ken Burns');
  /* ---------------------------------------------------------------- */
  {
    const scenes = [{ durationSec: 3 }, { durationSec: 5 }, { durationSec: 2 }];
    const withStarts = timeline.computeSceneTimeline(scenes);
    check(
      '実測音声長を積み上げてstartSecを求める',
      JSON.stringify(withStarts) ===
        JSON.stringify([
          { startSec: 0, durationSec: 3 },
          { startSec: 3, durationSec: 5 },
          { startSec: 8, durationSec: 2 },
        ])
    );
    check('合計秒数', timeline.totalDurationSec(scenes) === 10);

    check('Ken Burns: 進行度0では開始倍率', timeline.kenBurnsScaleAt(0) === 1.0);
    check('Ken Burns: 進行度1では終了倍率', timeline.kenBurnsScaleAt(1) === 1.12);
    check('Ken Burns: 進行度0.5では中間', Math.abs(timeline.kenBurnsScaleAt(0.5) - 1.06) < 1e-9);
    check('Ken Burns: 範囲外は丸め込む(負の値)', timeline.kenBurnsScaleAt(-1) === 1.0);
    check('Ken Burns: 範囲外は丸め込む(1超)', timeline.kenBurnsScaleAt(2) === 1.12);

    check('frameCountForDuration: 30fpsで1秒=30フレーム', timeline.frameCountForDuration(1, 30) === 30);
    check('frameCountForDuration: 四捨五入する', timeline.frameCountForDuration(0.5, 30) === 15);

    check('kenBurnsScaleForFrame: 総フレーム1のときは終了倍率', timeline.kenBurnsScaleForFrame(0, 1) === 1.12);
    check(
      'kenBurnsScaleForFrame: 最終フレームは終了倍率に一致する',
      timeline.kenBurnsScaleForFrame(29, 30) === 1.12
    );
  }

  /* ---------------------------------------------------------------- */
  section('ベンダー整合: vendor-manifest.json と実ファイルのSHA-256');
  /* ---------------------------------------------------------------- */
  {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(new URL('vendor-manifest.json', VENDOR_DIR), 'utf8'));
    } catch (error) {
      fatal(new Error(`vendor-manifest.json を読み込めません: ${error.message}`));
      return;
    }

    check('vendor-manifest.json: cacheNameがある', typeof manifest.cacheName === 'string' && manifest.cacheName.length > 0);
    check(
      'vendor-manifest.json: maxAssetBytesが25MiB(26,214,400)',
      manifest.maxAssetBytes === 26214400
    );

    for (const asset of manifest.assets) {
      if (asset.unavailable) {
        check(`${asset.id}: unavailableには理由(reason)がある`, typeof asset.reason === 'string' && asset.reason.length > 0);
        continue;
      }

      check(`${asset.id}: 全パートが25MiB以下`, asset.parts.every((p) => p.bytes <= manifest.maxAssetBytes), asset.parts.map((p) => p.bytes));

      const buffers = [];
      for (const part of asset.parts) {
        const partUrl = new URL(part.path, VENDOR_DIR);
        const buf = await readFile(partUrl);
        const partHash = createHash('sha256').update(buf).digest('hex');
        check(`${asset.id}: パート ${part.path} のSHA-256が一致`, partHash === part.sha256);
        check(`${asset.id}: パート ${part.path} のバイト数が一致`, buf.length === part.bytes);
        buffers.push(buf);
      }
      const combined = Buffer.concat(buffers);
      const combinedHash = createHash('sha256').update(combined).digest('hex');
      check(`${asset.id}: 結合後のSHA-256が一致`, combinedHash === asset.sha256);
      check(`${asset.id}: 結合後のバイト数が一致`, combined.length === asset.bytes);
    }

    // 分割されたファイルの「元ファイル」が配信物として残っていないこと
    // (25MiB上限にそのまま抵触する実ファイルが残っていないか)。
    for (const asset of manifest.assets) {
      if (asset.unavailable || asset.parts.length <= 1) continue;
      const originalUrl = new URL(asset.path, VENDOR_DIR);
      let stillExists = true;
      try {
        await stat(originalUrl);
      } catch {
        stillExists = false;
      }
      check(`${asset.id}: 分割後は結合前の巨大ファイルを残していない`, !stillExists);
    }
  }

  /* ---------------------------------------------------------------- */
  section('ソース静的検証: mobile-lab/index.html の CSP');
  /* ---------------------------------------------------------------- */
  {
    const html = await readFile(new URL('index.html', LAB_DIR), 'utf8');
    const cspMatch = html.match(/Content-Security-Policy" content="([^"]+)"/);
    check('CSP meta タグが存在する', !!cspMatch);
    const csp = cspMatch ? cspMatch[1] : '';

    check("script-src に 'wasm-unsafe-eval' がある", /script-src[^;]*'wasm-unsafe-eval'/.test(csp));
    check("worker-src に 'self' と blob: がある", /worker-src[^;]*'self'[^;]*blob:/.test(csp));
    const connectSrcMatch = csp.match(/connect-src ([^;]+)/);
    const connectSrcOk =
      !!connectSrcMatch &&
      connectSrcMatch[1].includes("'self'") &&
      !connectSrcMatch[1].includes('generativelanguage.googleapis.com');
    check('connect-src は同一オリジン+認証系ドメインのみ(Geminiは含まない)', connectSrcOk, connectSrcMatch?.[1]);

    check('guardPage を呼んでいる(app.js経由の確認は下記)', html.includes('app.js'));
    check('robots noindex,nofollow がある(一時検証ページ)', html.includes('noindex, nofollow'));
  }

  /* ---------------------------------------------------------------- */
  section('ソース静的検証: 既存 short-script/index.html のCSPは不変');
  /* ---------------------------------------------------------------- */
  {
    const existingHtml = await readFile(new URL('index.html', APP_DIR), 'utf8');
    const cspMatch = existingHtml.match(/Content-Security-Policy" content="([^"]+)"/);
    check('既存ページにもCSP metaがある', !!cspMatch);
    const csp = cspMatch ? cspMatch[1] : '';
    check(
      '既存ページのCSPは script-src \'self\' のまま(wasm-unsafe-evalを足していない)',
      csp.includes("script-src 'self';") && !csp.includes('wasm-unsafe-eval')
    );
    check('既存ページのCSPに worker-src を足していない', !csp.includes('worker-src'));
  }

  /* ---------------------------------------------------------------- */
  section('ソース静的検証: innerHTML不使用・WakeLock呼び出し');
  /* ---------------------------------------------------------------- */
  {
    const appSource = await readFile(new URL('app.js', LAB_DIR), 'utf8');
    check('app.js は innerHTML を使わない', !/\.innerHTML\s*=/.test(appSource));
    check('app.js は Wake Lock を取得している(navigator.wakeLock.request)', appSource.includes('navigator.wakeLock.request'));
    check('app.js は Wake Lock を解放している(sentinel.release)', appSource.includes('.release()'));
    check('app.js は guardPage を呼んでいる', appSource.includes('guardPage()'));
    check('app.js は setScreenDepth(3) を呼んでいる(mobile-labの深さ)', appSource.includes('setScreenDepth(3)'));
    check(
      'app.js は video/mp4 が使えない場合にwebmへ倒さない(§3補足)',
      appSource.includes("video/mp4") && !/mimeType:\s*['"]video\/webm['"]/.test(appSource)
    );

    const subtitleSource = await readFile(new URL('subtitle.mjs', LAB_DIR), 'utf8');
    check('subtitle.mjs は innerHTML を使わない', !/\.innerHTML\s*=/.test(subtitleSource));
  }

  finish();
}

main().catch((error) => fatal(error));
