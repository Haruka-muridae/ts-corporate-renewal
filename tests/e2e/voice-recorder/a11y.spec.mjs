/*
 * 見た目とアクセシビリティ（AGENTS.md の基準 / 要件書 §7）。
 *
 * ------------------------------------------------------------------
 * 目視の代わりにはならない
 * ------------------------------------------------------------------
 * ここで見るのは「機械が判定できること」だけ:
 *   横スクロールが出ない / キーボードで到達できる / 状態が文言でも伝わる /
 *   prefers-reduced-motion で動きが止まる / ラベルが付いている
 *
 * 配色のコントラストや「見て分かるか」は MANUAL_CHECKS.md に残す。
 * ------------------------------------------------------------------
 */

import { expect, test } from '@playwright/test';

import { gotoRecorder } from './fixtures.mjs';

/* AGENTS.md が指定する確認幅。 */
const WIDTHS = [320, 375, 768, 1024, 1440];

test.describe('レスポンシブ', () => {
  for (const width of WIDTHS) {
    test(`${width}px で横スクロールが出ない`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await gotoRecorder(page);

      /* 録音後の画面（保存パネルまで出た状態）でも確認する。 */
      await page.locator('#vr-start').click();
      await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');
      await page.waitForTimeout(3000);
      await page.locator('#vr-stop').click();
      await expect(page.locator('#vr-save-panel')).toBeVisible();

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));

      expect(
        overflow.scrollWidth,
        `body が ${overflow.scrollWidth}px で、表示幅 ${overflow.clientWidth}px を超えている`,
      ).toBeLessThanOrEqual(overflow.clientWidth);
    });
  }
});

test.describe('アクセシビリティ', () => {
  test('録音状態を色だけでなく文言でも示す（§7）', async ({ page }) => {
    await gotoRecorder(page);

    await expect(page.locator('#vr-indicator-label')).toHaveText('待機中');

    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator-label')).toHaveText('録音中');

    /* 表示は data-state（色）と文言の両方が変わる。 */
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');
  });

  test('prefers-reduced-motion で点滅を止める（AGENTS.md）', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoRecorder(page);

    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');

    const animation = await page.evaluate(() => {
      const dot = document.querySelector('#vr-indicator .vr-indicator__dot');
      return getComputedStyle(dot).animationName;
    });

    expect(animation).toBe('none');

    /* 動きは止めても、状態は文言と色で分かること。 */
    await expect(page.locator('#vr-indicator-label')).toHaveText('録音中');
  });

  test('動きを止めない設定では点滅する（対になる確認）', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await gotoRecorder(page);

    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');

    const animation = await page.evaluate(() => {
      const dot = document.querySelector('#vr-indicator .vr-indicator__dot');
      return getComputedStyle(dot).animationName;
    });

    expect(animation).toBe('vr-blink');
  });

  test('キーボードだけで録音の開始・停止・保存まで到達できる', async ({ page }) => {
    await gotoRecorder(page);

    /* 開始ボタンまで Tab で到達できること。 */
    const reachedStart = await page.evaluate(() => {
      const focusable = [...document.querySelectorAll(
        'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
      )];
      return focusable.some((n) => n.id === 'vr-start');
    });
    expect(reachedStart).toBe(true);

    /* Enter で押せること（button 要素なのでネイティブに効く）。 */
    await page.locator('#vr-start').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');

    await page.waitForTimeout(3000);
    await page.locator('#vr-stop').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#vr-save-panel')).toBeVisible();

    /*
     * 保存パネルの操作子もフォーカスできること。
     *
     * vr-save はここでは対象外。未連携のあいだは disabled であり、
     * disabled のボタンはフォーカスを受けない（それが正しい挙動）。
     * 連携後に押せるようになることは drive.spec.mjs が見ている。
     */
    const reachable = await page.evaluate(() => ['vr-name', 'vr-discard'].filter((id) => {
      const node = document.getElementById(id);
      node.focus();
      return document.activeElement === node;
    }));
    expect(reachable).toEqual(['vr-name', 'vr-discard']);

    /* 押せないボタンをタブ順に置き去りにしていないことも確認する。 */
    await expect(page.locator('#vr-save')).toBeDisabled();
  });

  test('入力欄にラベルと説明が結び付いている', async ({ page }) => {
    await gotoRecorder(page);
    await page.locator('#vr-start').click();
    await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');
    await page.waitForTimeout(3000);
    await page.locator('#vr-stop').click();
    await expect(page.locator('#vr-save-panel')).toBeVisible();

    const info = await page.evaluate(() => {
      const input = document.getElementById('vr-name');
      const describedBy = input.getAttribute('aria-describedby');
      return {
        labelled: input.closest('label') !== null,
        describedBy,
        describedByExists: describedBy === null
          ? false
          : describedBy.split(/\s+/).every((id) => document.getElementById(id) !== null),
      };
    });

    expect(info.labelled).toBe(true);
    expect(info.describedByExists).toBe(true);
  });

  test('状態とエラーが読み上げに乗る（aria-live / role）', async ({ page }) => {
    await gotoRecorder(page);

    const roles = await page.evaluate(() => ({
      message: document.getElementById('vr-message').getAttribute('role'),
      messageLive: document.getElementById('vr-message').getAttribute('aria-live'),
      error: document.getElementById('vr-error').getAttribute('role'),
      progress: document.getElementById('vr-progress').getAttribute('role'),
      progressLabel: document.getElementById('vr-progress').getAttribute('aria-labelledby'),
    }));

    expect(roles.message).toBe('status');
    expect(roles.messageLive).toBe('polite');
    /* エラーは割り込んで伝える。 */
    expect(roles.error).toBe('alert');
    expect(roles.progress).toBe('progressbar');
    expect(roles.progressLabel).toBe('vr-progress-title');
  });

  test('保護対象は認証が済むまで描画しない（§FR-01）', async ({ page }) => {
    /* 認証の応答を遅らせ、その間の描画状態を見る。 */
    await page.route('**/macros/s/**/exec*', async (route) => {
      await new Promise((resolve) => { setTimeout(resolve, 1500); });
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ success: true, data: { user: { email: 'e2e@example.com' } } }),
      });
    });
    await page.addInitScript(() => window.localStorage.setItem('tsam-auth-session', 'e2e'));

    await page.goto('/production-app/voice-recorder/');

    /* 応答前は中身が出ていない。 */
    await expect(page.locator('#vr-main')).toBeHidden();
    await expect(page.locator('#vr-main')).toBeVisible({ timeout: 10_000 });
  });
});
