/*
 * 30分ソークテスト（@soak）。要件 §8.2「メモリ使用量は録音時間に依存せず一定」。
 *
 * ------------------------------------------------------------------
 * 何を証明したいのか
 * ------------------------------------------------------------------
 * 128kbps では MP3 が 0.96MB/分 生成される。これをメモリに溜めていれば、
 * 30分で約29MB がヒープに現れる。逆に OPFS へ逐次書き出していれば、
 * **ヒープは平らなまま、OPFS の使用量だけが 0.96MB/分 で増える。**
 *
 * この2つは対で見る必要がある。ヒープが平らでも OPFS が増えていなければ
 * 「録音できていないだけ」かもしれないし、その逆もある。
 * ------------------------------------------------------------------
 *
 * 既定の実行からは外してある（playwright.config.mjs の grepInvert）。
 * 実行は `npm run test:e2e:soak` のみ。30分以上かかる。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { gotoRecorder, listRecordings } from './fixtures.mjs';

const SOAK_MINUTES = 30;
const SAMPLE_INTERVAL_MS = 30_000;
const MB = 1024 * 1024;

/* 128kbps モノラル = 16,000 B/秒 = 0.96 MB/分（要件書 §10-6）。 */
const EXPECTED_MB_PER_MINUTE = 0.96;

/*
 * ヒープの「下端」の伸びに許す上限。
 * MP3 をメモリに溜めていれば、前半と後半で約19MB（20分ぶん）の差が出る。
 * GC の揺れを吸収しつつ、その差とは区別できる値として 12MB を採る。
 */
const HEAP_GROWTH_LIMIT_MB = 12;

function minOf(samples, key) {
  return samples.reduce((min, s) => (s[key] < min ? s[key] : min), Infinity);
}

test.describe('30分ソーク @soak30', () => {
  test('30分録音してもヒープが伸びず、OPFS だけが増える（§8.2）', async ({ page }) => {
    await gotoRecorder(page);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');

    const readHeap = async () => {
      const { metrics } = await cdp.send('Performance.getMetrics');
      const found = metrics.find((m) => m.name === 'JSHeapUsedSize');
      return found ? found.value : Number.NaN;
    };

    /*
     * Worker 側のヒープ。performance.memory は Chrome の非標準APIで、
     * Worker スコープでは取れない場合がある。取れなければ null のまま報告する
     * （取れないことを「問題なし」と読み替えない）。
     */
    const readWorkerHeap = async () => {
      const workers = page.workers();

      for (const worker of workers) {
        if (!worker.url().includes('encoder-worker')) {
          continue;
        }

        try {
          return await worker.evaluate(() => (
            typeof performance !== 'undefined' && performance.memory
              ? performance.memory.usedJSHeapSize
              : null
          ));
        } catch {
          return null;
        }
      }

      return null;
    };

    const readUsage = () => page.evaluate(async () => {
      const estimate = await navigator.storage.estimate();
      return typeof estimate.usage === 'number' ? estimate.usage : 0;
    });

    const baselineUsage = await readUsage();

    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');

    const startedAt = Date.now();
    const samples = [];

    while (Date.now() - startedAt < SOAK_MINUTES * 60_000) {
      await page.waitForTimeout(SAMPLE_INTERVAL_MS);

      const elapsedMin = (Date.now() - startedAt) / 60_000;
      const [heapBytes, workerHeapBytes, usageBytes] = await Promise.all([
        readHeap(), readWorkerHeap(), readUsage(),
      ]);

      samples.push({
        elapsedMin: Number(elapsedMin.toFixed(2)),
        heapMB: Number((heapBytes / MB).toFixed(2)),
        workerHeapMB: workerHeapBytes === null ? null : Number((workerHeapBytes / MB).toFixed(2)),
        opfsMB: Number(((usageBytes - baselineUsage) / MB).toFixed(2)),
      });

      /* 途中で自動停止していたら、そこで打ち切って原因を残す。 */
      const state = await page.locator('#vr-indicator').getAttribute('data-state');
      if (state !== 'recording') {
        break;
      }
    }

    const recordedMinutes = (Date.now() - startedAt) / 60_000;

    await page.locator('#vr-stop').click();
    await expect(page.locator('#vr-save-panel')).toBeVisible({ timeout: 60_000 });

    const files = await listRecordings(page);
    const finalUsage = await readUsage();
    const finalMB = (finalUsage - baselineUsage) / MB;

    /* ---- 集計 ---- */

    const third = Math.max(1, Math.floor(samples.length / 3));
    const head = samples.slice(0, third);
    const tail = samples.slice(-third);

    const headMinHeap = minOf(head, 'heapMB');
    const tailMinHeap = minOf(tail, 'heapMB');
    const heapGrowthMB = Number((tailMinHeap - headMinHeap).toFixed(2));
    const opfsRate = Number((finalMB / recordedMinutes).toFixed(3));

    const summary = {
      recordedMinutes: Number(recordedMinutes.toFixed(2)),
      sampleCount: samples.length,
      heapMinFirstThirdMB: headMinHeap,
      heapMinLastThirdMB: tailMinHeap,
      heapGrowthMB,
      heapMaxMB: samples.reduce((max, s) => (s.heapMB > max ? s.heapMB : max), 0),
      workerHeapMeasured: samples.some((s) => s.workerHeapMB !== null),
      opfsFinalMB: Number(finalMB.toFixed(2)),
      opfsRateMBPerMin: opfsRate,
      expectedRateMBPerMin: EXPECTED_MB_PER_MINUTE,
    };

    mkdirSync('tests/e2e/.artifacts', { recursive: true });
    writeFileSync(
      'tests/e2e/.artifacts/soak-summary.json',
      JSON.stringify({ summary, samples }, null, 2),
      'utf8',
    );

    console.log('[soak] 集計:', JSON.stringify(summary, null, 2));

    /* ---- 判定 ---- */

    /* 30分回りきったか（途中で自動停止していないか）。 */
    expect(summary.recordedMinutes).toBeGreaterThanOrEqual(SOAK_MINUTES - 1);

    /* ヒープの下端が録音時間に比例して伸びていないこと。 */
    expect(
      heapGrowthMB,
      `ヒープ下端が ${heapGrowthMB}MB 伸びた（MP3 を溜めていれば約19MB伸びる）`,
    ).toBeLessThan(HEAP_GROWTH_LIMIT_MB);

    /* OPFS は 0.96MB/分 前後で増えていること（±30%）。 */
    expect(opfsRate).toBeGreaterThan(EXPECTED_MB_PER_MINUTE * 0.7);
    expect(opfsRate).toBeLessThan(EXPECTED_MB_PER_MINUTE * 1.3);

    /* 確定した一時ファイルが1件だけ残っていること。 */
    expect(files).toHaveLength(1);
  });
});
