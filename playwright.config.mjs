/*
 * Playwright（ブラウザ録音アプリの E2E）。
 *
 * ------------------------------------------------------------------
 * 既存のテストランナーとは別系統
 * ------------------------------------------------------------------
 * このリポジトリには既に2つのランナーがある（tests/run.mjs と
 * public/apps/tests/run.mjs）。どちらも Node で直接スイートを実行する方式で、
 * 実ブラウザに録音させることはできない。
 *
 * マイク入力・AudioWorklet・OPFS・メモリ計測は実ブラウザでしか確認できないため、
 * ここだけ Playwright を使う。**既存の2つのランナーは変更していない。**
 * `npm test` の内容も従来どおりで、E2E は `npm run test:e2e` で明示的に走らせる。
 * ------------------------------------------------------------------
 *
 * 30分ソークテストは既定の実行から外してある（下の grepInvert）。
 * 実行は `npm run test:e2e:soak` のみ。
 */

import { defineConfig, devices } from '@playwright/test';

/* 手作業の確認（8000番）とぶつからないポートにする。 */
export const E2E_PORT = 8123;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.mjs',

  /*
   * OPFS は同一オリジンで共有される。並列に走らせると
   * 一方の起動時クリーンアップが他方の録音中ファイルを消してしまうため、直列にする。
   */
  workers: 1,
  fullyParallel: false,

  /* 実録音を含むため既定の30秒では足りない。 */
  timeout: 120_000,
  expect: { timeout: 15_000 },

  /* 落ちたときに原因が分かるように、失敗時だけ痕跡を残す。 */
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'tests/e2e/.report' }]],
  outputDir: 'tests/e2e/.artifacts',

  use: {
    baseURL: E2E_BASE_URL,

    /*
     * ------------------------------------------------------------------
     * channel: 'chromium' を外さないこと
     * ------------------------------------------------------------------
     * Playwright が既定で使う headless shell には**メディアデバイスが無い。**
     * 偽デバイスの起動フラグを渡しても getUserMedia が
     * `NotSupportedError: Not supported` で落ち、録音が一切始まらない
     * （実際にこれで9件が失敗した）。
     *
     * channel: 'chromium' はフルの Chromium を新しい headless モードで起動する。
     * こちらはメディアデバイスを持つため、偽デバイスが機能する。
     * ------------------------------------------------------------------
     */
    channel: 'chromium',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',

    /*
     * マイクの許可ダイアログを出さず、無音ではない既知の信号を入力する。
     *   --use-fake-ui-for-media-capture   … 許可ダイアログを自動で承認する
     *   --use-fake-device-for-media-capture … 実マイクの代わりに合成音（正弦波）を流す
     * この2つが無いと getUserMedia がダイアログで止まり、テストが進まない。
     */
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-capture',
        '--use-fake-device-for-media-capture',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
    permissions: ['microphone'],
  },

  projects: [
    {
      name: 'voice-recorder',
      use: { ...devices['Desktop Chrome'] },
      /* @soak を既定の実行から外す。ソークは専用スクリプトからのみ走らせる。 */
      grepInvert: /@soak/,
    },
    {
      name: 'voice-recorder-soak',
      use: { ...devices['Desktop Chrome'] },
      grep: /@soak30/,
      /* 30分の録音そのものに加え、確定と後片付けの余裕を持たせる。 */
      timeout: 45 * 60_000,
    },
    {
      /*
       * §11-11 の「90分の録音」。上限そのものに達するため、
       * 自動停止・約86MB・分割送信（8MBチャンク×11回前後）まで通しで見る。
       * 30分ソークとは別プロジェクトにして、片方だけ回せるようにしてある。
       */
      name: 'voice-recorder-soak90',
      use: { ...devices['Desktop Chrome'] },
      grep: /@soak90/,
      timeout: 120 * 60_000,
    },
  ],

  webServer: {
    command: `node tests/e2e/voice-recorder/static-server.mjs ${E2E_PORT}`,
    url: `${E2E_BASE_URL}/production-app/voice-recorder/`,
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
