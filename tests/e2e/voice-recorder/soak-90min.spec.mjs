/*
 * 90分の通し確認（@soak90）。受入条件 §11-11 の「90分」に対応する。
 *
 * ------------------------------------------------------------------
 * 30分ソークとの違い
 * ------------------------------------------------------------------
 * 30分ソーク（soak.spec.mjs）が見るのは「メモリが伸びないこと」。
 * こちらが見るのは **上限そのものに達したときの振る舞い** で、
 *   - 90分で自動停止する（§FR-04 / §10-5）
 *   - 残り5分で予告が出る（同上）
 *   - 出来上がりが約86MB になる（§10-6）
 *   - その大きさが分割送信を通る（§FR-08 / §8.2）
 * を通しで確認する。上限値の注入は使わない（本物の90分を録る）。
 * ------------------------------------------------------------------
 *
 * Drive は差し替える。実 OAuth は自動化できないためで、
 * **本物の Drive への90分保存は人手確認（MANUAL_CHECKS.md §7）に残る。**
 * ここで確かめられるのは「86MB がチャンクに分かれて送られること」まで。
 *
 * 実行: npm run test:e2e:soak90（90分以上かかる）
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { gotoRecorder, listRecordings, parseDuration } from './fixtures.mjs';

const MB = 1024 * 1024;
const LIMIT_SECONDS = 90 * 60;
const CHUNK_BYTES = 8 * MB;

/* GIS と Drive の差し替え（drive.spec.mjs と同じ考え方）。 */
async function stubGoogle(page, state) {
  await page.addInitScript(() => {
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (config) => ({
            requestAccessToken: () => config.callback({ access_token: 't', expires_in: 3600 }),
          }),
        },
      },
    };
  });

  await page.route('https://www.googleapis.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200, headers = {}) => route.fulfill({
      status, contentType: 'application/json; charset=utf-8', headers, body: JSON.stringify(body),
    });

    if (url.pathname.endsWith('/drive/v3/about')) {
      await json({ user: { emailAddress: 'soak@example.com' } });
      return;
    }

    if (url.pathname.endsWith('/upload/drive/v3/files') && request.method() === 'POST') {
      state.name = JSON.parse(request.postData() ?? '{}').name ?? null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: {
          location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=soak',
          'access-control-expose-headers': 'location, range',
        },
        body: '{}',
      });
      return;
    }

    if (url.searchParams.get('upload_id') === 'soak' && request.method() === 'PUT') {
      state.chunks += 1;

      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(request.headers()['content-range'] ?? '');
      const end = m ? Number(m[2]) + 1 : 0;
      const total = m ? Number(m[3]) : 0;
      state.totalBytes = total;

      if (end < total) {
        await route.fulfill({ status: 308, body: '' });
        return;
      }

      await json({
        id: 'soak-file',
        name: state.name,
        webViewLink: 'https://drive.google.com/file/d/soak-file/view',
      });
      return;
    }

    if (url.pathname.endsWith('/drive/v3/files') && request.method() === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      if (q.includes("name='TSAM AI'")) { await json({ files: [{ id: 'root-f', name: 'TSAM AI' }] }); return; }
      if (q.includes("name='Voice Recorder'")) { await json({ files: [{ id: 'app-f', name: 'Voice Recorder' }] }); return; }
      await json({ files: [] });
      return;
    }

    await json({ error: { message: 'unexpected' } }, 500);
  });
}

test.describe('90分の通し確認 @soak90', () => {
  test('90分で自動停止し、約86MB が分割送信される（§11-11）', async ({ page }) => {
    const drive = { name: null, chunks: 0, totalBytes: 0 };

    await stubGoogle(page, drive);
    await gotoRecorder(page);

    /* 上限は既定の90分。注入しない。 */
    await expect(page.locator('#vr-limit')).toHaveText('上限 01:30:00');

    await page.locator('#vr-connect').click();
    await expect(page.locator('#vr-state-oauth')).toHaveText('soak@example.com');

    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');

    const startedAt = Date.now();
    let warnedAtSeconds = null;

    /*
     * 予告（残り5分＝85分時点）を捕まえるため、30秒ごとに文言を見る。
     * 予告は一度しか出ないので、見逃すと後から確認できない。
     */
    while (Date.now() - startedAt < (LIMIT_SECONDS + 120) * 1000) {
      await page.waitForTimeout(30_000);

      if (warnedAtSeconds === null) {
        const message = await page.locator('#vr-message').textContent();
        if (String(message).includes('まもなく上限です')) {
          warnedAtSeconds = parseDuration(await page.locator('#vr-time').textContent());
        }
      }

      const state = await page.locator('#vr-indicator').getAttribute('data-state');
      if (state !== 'recording') {
        break;
      }
    }

    /* 上限で自動停止していること。 */
    await expect(page.locator('#vr-save-panel')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('#vr-message')).toContainText('上限の 01:30:00 に達したため');

    /* 予告が上限の5分前に出ていること（±90秒。確認間隔30秒ぶんの幅を見る）。 */
    expect(warnedAtSeconds, '残り5分の予告が出なかった').not.toBeNull();
    expect(Math.abs(warnedAtSeconds - (LIMIT_SECONDS - 300))).toBeLessThanOrEqual(90);

    /* 出来上がりの大きさ（§10-6 の「約86MB」）。 */
    const files = await listRecordings(page);
    expect(files).toHaveLength(1);

    const sizeBytes = await page.evaluate(async (fileName) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('recordings', { create: false });
      const handle = await dir.getFileHandle(fileName, { create: false });
      return (await handle.getFile()).size;
    }, files[0]);

    const sizeMB = sizeBytes / MB;

    /* 128kbps×90分＝約82.4MiB。可変ビットレートの揺れを見込んで幅を取る。 */
    expect(sizeMB, `出来上がりが ${sizeMB.toFixed(1)}MB`).toBeGreaterThan(70);
    expect(sizeMB).toBeLessThan(95);

    /* プレビューが再生できる長さになっていること。 */
    const duration = await page.evaluate(() => new Promise((resolve) => {
      const audio = document.getElementById('vr-player');
      if (Number.isFinite(audio.duration) && audio.duration > 0) { resolve(audio.duration); return; }
      audio.addEventListener('loadedmetadata', () => resolve(audio.duration), { once: true });
      setTimeout(() => resolve(audio.duration), 15_000);
    }));
    expect(Math.abs(duration - LIMIT_SECONDS)).toBeLessThan(120);

    /*
     * ------------------------------------------------------------------
     * ここで必ず連携しなおす
     * ------------------------------------------------------------------
     * アクセストークンの寿命は約1時間で、90分の録音より短い。
     * 停止した時点では必ず切れているため、保存ボタンは押せない状態になっている。
     *
     * これは実装の不具合ではなく仕様（§FR-02「期限切れ時は再認証を促し、
     * 再認証後に保存操作をやり直せる」）。**その状態になっていること自体を確認**
     * してから、連携しなおして保存へ進む。
     * ------------------------------------------------------------------
     */
    await expect(page.locator('#vr-state-oauth')).toHaveText('認証の期限切れ');
    await expect(page.locator('#vr-save')).toBeDisabled();
    await expect(page.locator('#vr-save-hint')).toContainText('有効期限が切れました');

    /* 実際にこの経路を通ったことを、あとから読める形で残す。 */
    const expiry = {
      oauthStateAtStop: (await page.locator('#vr-state-oauth').textContent()).trim(),
      saveHintAtStop: (await page.locator('#vr-save-hint').textContent()).trim(),
      saveDisabledAtStop: await page.locator('#vr-save').isDisabled(),
      elapsedAtStop: await page.locator('#vr-time').textContent(),
    };
    console.log('[soak90] 期限切れの時点:', JSON.stringify(expiry, null, 2));

    await page.evaluate(() => {
      window.google.accounts.oauth2.initTokenClient = (config) => ({
        requestAccessToken: () => config.callback({ access_token: 'renewed', expires_in: 3600 }),
      });
    });
    await page.locator('#vr-connect').click();
    await expect(page.locator('#vr-save')).toBeEnabled({ timeout: 30_000 });

    expiry.oauthStateAfterReconnect = (await page.locator('#vr-state-oauth').textContent()).trim();
    expiry.saveEnabledAfterReconnect = !(await page.locator('#vr-save').isDisabled());
    console.log('[soak90] 連携しなおした後:', JSON.stringify(expiry, null, 2));

    /* 保存。86MB が8MBずつに分かれて送られること（§FR-08 / §8.2）。 */
    await page.locator('#vr-save').click();
    await expect(page.locator('#vr-result-panel')).toBeVisible({ timeout: 10 * 60_000 });

    const expectedChunks = Math.ceil(sizeBytes / CHUNK_BYTES);
    expect(drive.chunks, `チャンク数 ${drive.chunks}（期待 ${expectedChunks}）`).toBe(expectedChunks);
    expect(drive.chunks).toBeGreaterThan(1);
    expect(drive.totalBytes).toBe(sizeBytes);

    /* 保存後に端末内の一時データが消えていること（§FR-08）。 */
    await expect.poll(async () => (await listRecordings(page)).length, { timeout: 30_000 }).toBe(0);

    const summary = {
      recordedSeconds: LIMIT_SECONDS,
      warnedAtSeconds,
      sizeMB: Number(sizeMB.toFixed(2)),
      sizeBytes,
      previewDurationSeconds: Number(duration.toFixed(1)),
      chunkCount: drive.chunks,
      expectedChunks,
      chunkBytes: CHUNK_BYTES,
      uploadedName: drive.name,
      /* 期限切れ→連携しなおす、を実際に通ったことの記録。 */
      tokenExpiry: expiry,
    };

    mkdirSync('tests/e2e/.artifacts', { recursive: true });
    writeFileSync('tests/e2e/.artifacts/soak90-summary.json', JSON.stringify(summary, null, 2), 'utf8');
    console.log('[soak90] 集計:', JSON.stringify(summary, null, 2));
  });
});
