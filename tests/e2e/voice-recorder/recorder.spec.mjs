/*
 * ブラウザ録音アプリの E2E。
 * 要件: docs/requirements/mvp-requirements.md（§FR-01〜§FR-08 / §7 / §8.2）
 *
 * 実ブラウザに合成音を録音させ、OPFS への書き出しと後片付けまでを確認する。
 * マイクは Chromium の偽デバイス（playwright.config.mjs の起動フラグ）。
 *
 * 上限90分・予告85分は、そのまま確認すると1件に90分かかる。
 * config.js のテスト用上書き（localhost 限定・§B-4）で秒数を縮めて確認する。
 */

import { expect, test } from '@playwright/test';

import {
  APP_PATH,
  gotoRecorder,
  listRecordings,
  parseBytes,
  parseDuration,
} from './fixtures.mjs';

test.describe('ブラウザ録音アプリ', () => {
  test('未認証で直接開くとログイン画面へ誘導される（§FR-01）', async ({ page }) => {
    await gotoRecorder(page, { authenticated: false });

    await page.waitForURL(/\/login\//);
    expect(page.url()).toContain('/login/');
    expect(page.url()).toContain('next=portal');

    /* 保護対象は描画されていないこと（hidden のまま遷移する）。 */
    await expect(page.locator('#vr-main')).toHaveCount(0);
  });

  test('準備パネルに認証・保存先・上限が出る（§FR-03 / §7）', async ({ page }) => {
    await gotoRecorder(page);

    await expect(page.locator('#vr-state-auth')).toHaveText('ログイン済み');
    await expect(page.locator('#vr-state-folder'))
      .toHaveText('マイドライブ ＞ TSAM AI ＞ Voice Recorder');
    await expect(page.locator('#vr-state-device')).toHaveText('利用できます');

    /* 上書きを渡していないので既定の90分が出る。 */
    await expect(page.locator('#vr-limit')).toHaveText('上限 01:30:00');
    await expect(page.locator('#vr-start')).toBeEnabled();
  });

  test('手順1: 録音開始から2秒以内に録音中になり、経過時間が進む（§FR-04 / §8.2）', async ({ page }) => {
    await gotoRecorder(page);

    const startedAt = Date.now();
    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');
    const latencyMs = Date.now() - startedAt;

    await expect(page.locator('#vr-indicator-label')).toHaveText('録音中');
    await expect(page.locator('#vr-start')).toBeHidden();
    await expect(page.locator('#vr-stop')).toBeVisible();

    /* §8.2「録音開始操作から2秒以内に録音状態へ移行する」。 */
    expect(latencyMs, `録音状態への移行に ${latencyMs}ms かかった`).toBeLessThanOrEqual(2000);

    await expect
      .poll(async () => parseDuration(await page.locator('#vr-time').textContent()), { timeout: 8000 })
      .toBeGreaterThanOrEqual(3);
  });

  test('手順2: 推定ファイルサイズが増える（§7）', async ({ page }) => {
    await gotoRecorder(page);
    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');

    await expect
      .poll(async () => parseBytes(await page.locator('#vr-size').textContent()), { timeout: 10_000 })
      .toBeGreaterThan(0);

    /* 128kbps = 16,000 B/秒。5秒で 80,000 B 前後になるはず。 */
    await page.waitForTimeout(5000);
    const bytes = parseBytes(await page.locator('#vr-size').textContent());
    expect(bytes).toBeGreaterThan(40_000);
  });

  test('手順3: 停止するとプレビューと録音情報が出る（§FR-05）', async ({ page }) => {
    await gotoRecorder(page);
    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');
    await page.waitForTimeout(5000);
    await page.locator('#vr-stop').click();

    await expect(page.locator('#vr-save-panel')).toBeVisible();
    await expect(page.locator('#vr-player')).toHaveAttribute('src', /^blob:/);
    await expect(page.locator('#vr-recorded-meta')).toContainText('録音時間');
    await expect(page.locator('#vr-recorded-meta')).toContainText('サイズ');

    /* 実際に MP3 が書けていること（0バイトのファイルを掴んでいない）。 */
    const files = await listRecordings(page);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.mp3\.part$/);

    const duration = await page.evaluate(() => new Promise((resolve) => {
      const audio = document.getElementById('vr-player');
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        resolve(audio.duration);
        return;
      }
      audio.addEventListener('loadedmetadata', () => resolve(audio.duration), { once: true });
      setTimeout(() => resolve(audio.duration), 5000);
    }));

    /* デコードできる MP3 になっていれば長さが読める。 */
    expect(Number.isFinite(duration) ? duration : 0).toBeGreaterThan(0);
  });

  test('手順4: ファイル名の初期値が YYYYMMDD_HHmmss_録音.mp3（§FR-07）', async ({ page }) => {
    await gotoRecorder(page);

    /*
     * 開始ボタンを押す直前の時刻を控える。
     * 押した「あと」に控えると、録音状態になるまでの待ちぶんだけ後ろへずれ、
     * 秒が1つ違うだけで落ちるテストになる。
     */
    const clickedClock = await page.evaluate(() => Date.now());
    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');

    const recordingSeconds = 6;
    await page.waitForTimeout(recordingSeconds * 1000);
    await page.locator('#vr-stop').click();
    await expect(page.locator('#vr-save-panel')).toBeVisible();

    const value = await page.locator('#vr-name').inputValue();
    expect(value).toMatch(/^\d{8}_\d{6}_録音\.mp3$/);

    /* 名前に入った時刻を、ブラウザのローカル時刻として読み戻す。 */
    const namedClock = await page.evaluate((name) => {
      const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/.exec(name);
      return new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4]), Number(m[5]), Number(m[6]),
      ).getTime();
    }, value);

    /*
     * §FR-07 は「録音開始時刻」を基準と定めている。
     * 開始の近くにあり、かつ停止時刻からは離れていることを見る
     * （停止時刻を使っていれば、ここは 6 秒ずれる）。
     */
    const offsetFromStart = Math.abs(namedClock - clickedClock) / 1000;
    expect(offsetFromStart, `開始時刻から ${offsetFromStart} 秒ずれている`).toBeLessThanOrEqual(2);
    expect(offsetFromStart).toBeLessThan(recordingSeconds - 2);
  });

  test('手順5: 破棄すると画面が初期化され一時ファイルも消える（§FR-05）', async ({ page }) => {
    await gotoRecorder(page);
    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');
    await page.waitForTimeout(5000);
    await page.locator('#vr-stop').click();
    await expect(page.locator('#vr-save-panel')).toBeVisible();

    expect(await listRecordings(page)).toHaveLength(1);

    await page.locator('#vr-discard').click();

    await expect(page.locator('#vr-save-panel')).toBeHidden();
    await expect(page.locator('#vr-time')).toHaveText('00:00:00');
    await expect(page.locator('#vr-start')).toBeVisible();
    await expect(page.locator('#vr-message')).toContainText('録音を破棄しました');

    await expect.poll(async () => (await listRecordings(page)).length, { timeout: 10_000 })
      .toBe(0);
  });

  test('手順7: 画面が非表示になると警告を出す（§FR-04・ハンドラのみ）', async ({ page }) => {
    await gotoRecorder(page);
    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');

    /*
     * 実際のタブ切り替えは Playwright から起こせないため、
     * document.hidden を真にして visibilitychange を投げ、ハンドラだけを確認する。
     * 「本当にタブを裏へ回したときに録音が続くか」は人手確認に残す。
     */
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(page.locator('#vr-message')).toContainText('非表示');
    /* 警告であって停止ではない。 */
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');
  });

  test('手順8: 異常終了で残った一時ファイルを次回起動時に削除する（§FR-08 / §10-14）', async ({ page }) => {
    await gotoRecorder(page);
    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');
    await page.waitForTimeout(5000);

    /* 停止も破棄もせずに再読み込み＝異常終了に相当する。 */
    expect(await listRecordings(page)).toHaveLength(1);

    const messages = [];
    page.on('console', (msg) => messages.push(msg.text()));

    await page.reload();
    await page.locator('#vr-main').waitFor({ state: 'visible' });

    await expect.poll(async () => (await listRecordings(page)).length, { timeout: 10_000 })
      .toBe(0);

    expect(messages.some((m) => m.includes('前回の一時ファイルを'))).toBe(true);
  });

  test('上限で自動停止し、その前に残り時間を予告する（§FR-04 / §10-5）', async ({ page }) => {
    /*
     * 上限12秒・予告6秒に縮めて確認する。
     * この上書きは localhost でのみ効き、本番オリジンでは既定（90分/85分）になる。
     */
    await gotoRecorder(page, { query: { testMaxSeconds: '12', testWarningSeconds: '6' } });

    await expect(page.locator('#vr-limit')).toHaveText('上限 00:00:12');

    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');

    /* 予告（残り時間の告知）。 */
    await expect(page.locator('#vr-message')).toContainText('まもなく上限です', { timeout: 12_000 });

    /* 上限到達で自動停止し、理由が出る。 */
    await expect(page.locator('#vr-save-panel')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#vr-message')).toContainText('上限の 00:00:12 に達したため');
    await expect(page.locator('#vr-indicator')).not.toHaveAttribute('data-state', 'recording');
  });

  /*
   * 離脱警告はダイアログでページを閉じるため、最後に単独で行う。
   * 同じテスト内で他の確認を続けられない（ページが閉じる）。
   */
  test('手順6: 未保存のまま閉じようとすると離脱警告が出る（§7）', async ({ page }) => {
    await gotoRecorder(page);
    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');
    await page.waitForTimeout(2000);

    let sawDialog = false;
    page.on('dialog', async (dialog) => {
      sawDialog = dialog.type() === 'beforeunload';
      await dialog.dismiss();
    });

    await page.close({ runBeforeUnload: true });
    await new Promise((resolve) => { setTimeout(resolve, 2000); });

    expect(sawDialog).toBe(true);
  });
});

test.describe('配信のかたち', () => {
  test('アプリのパスが Portal のレジストリと一致する', async ({ request }) => {
    /* app-registry.js の href が 'production-app/voice-recorder/' であること。 */
    const registry = await request.get('/portal/app-registry.js');
    expect(registry.ok()).toBe(true);

    const source = await registry.text();
    expect(source).toContain("href: 'production-app/voice-recorder/'");

    /* その URL が実際に引けること。 */
    const app = await request.get(APP_PATH);
    expect(app.ok()).toBe(true);
  });
});
