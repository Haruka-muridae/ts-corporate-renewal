/*
 * Drive 保存の E2E（要件書 §FR-02 / §FR-03 / §FR-07 / §FR-08）。
 *
 * ------------------------------------------------------------------
 * 本物の Google は叩かない
 * ------------------------------------------------------------------
 * 実 OAuth の同意画面は自動化できないし、自動化すべきでもない。
 * テストで本物の Drive へ書き込むのも避ける。
 *
 * そこで2か所を差し替える。
 *   1. GIS … ページ読み込み前に window.google.accounts.oauth2 を置いておく。
 *            oauth.js の loadGis() は「既にあれば読み込まない」ので、
 *            accounts.google.com へは一切アクセスが飛ばない。
 *   2. Drive API … page.route で www.googleapis.com を捕まえる。
 *
 * 実物との差は「トークンの出どころ」と「Drive の中身」だけで、
 * アプリ側の分岐（フォルダ解決・連番・分割送信・後片付け）はすべて本物が動く。
 * ------------------------------------------------------------------
 */

import { expect, test } from '@playwright/test';

import { gotoRecorder, listRecordings } from './fixtures.mjs';

const FOLDER_ROOT_ID = 'folder-tsam-ai';
const FOLDER_APP_ID = 'folder-voice-recorder';
const UPLOAD_SESSION = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=e2e';

/*
 * GIS の差し替え。
 * behaviour:
 *   'grant'         … トークンを返す
 *   'popup_closed'  … 利用者が閉じた／オリジン未登録（区別できない）
 *   'popup_blocked' … ポップアップが開けなかった
 */
async function stubGis(page, behaviour = 'grant', { expiresIn = 3600 } = {}) {
  await page.addInitScript(([mode, lifetime]) => {
    window.__gisCalls = 0;
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (config) => ({
            requestAccessToken: () => {
              window.__gisCalls += 1;

              if (mode === 'grant') {
                config.callback({ access_token: 'e2e-access-token', expires_in: lifetime });
                return;
              }

              config.error_callback({
                type: mode === 'popup_blocked' ? 'popup_failed_to_open' : 'popup_closed',
              });
            },
          }),
        },
      },
    };
  }, [behaviour, expiresIn]);
}

/*
 * Drive API の差し替え。
 * existingNames には「保存先に既にあるファイル名」を渡す（連番の確認に使う）。
 */
async function stubDrive(page, { existingNames = [], uploadStatus = 200 } = {}) {
  const state = { uploadedName: null, chunkCount: 0, receivedBytes: 0 };

  await page.route('https://www.googleapis.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200, headers = {}) => route.fulfill({
      status,
      contentType: 'application/json; charset=utf-8',
      headers,
      body: JSON.stringify(body),
    });

    /* about.get（連携アカウントの表示） */
    if (url.pathname.endsWith('/drive/v3/about')) {
      await json({ user: { emailAddress: 'drive-user@example.com' } });
      return;
    }

    /*
     * アップロードセッションの開始。
     *
     * `access-control-expose-headers` を必ず付けること。
     * これが無いとブラウザは Location をスクリプトへ見せず、
     * drive.js がセッションURIを取れない（実際にこれで4件が落ちた）。
     * 本物の Google も同じヘッダーを返している。
     */
    if (url.pathname.endsWith('/upload/drive/v3/files') && request.method() === 'POST') {
      state.uploadedName = JSON.parse(request.postData() ?? '{}').name ?? null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: {
          location: UPLOAD_SESSION,
          'access-control-expose-headers': 'location, range',
        },
        body: '{}',
      });
      return;
    }

    /* チャンクの受信 */
    if (url.searchParams.get('upload_id') === 'e2e' && request.method() === 'PUT') {
      state.chunkCount += 1;

      const range = request.headers()['content-range'] ?? '';
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      const end = m ? Number(m[2]) + 1 : 0;
      const total = m ? Number(m[3]) : 0;
      state.receivedBytes = end;

      if (uploadStatus !== 200) {
        await json({ error: { message: 'boom' } }, uploadStatus);
        return;
      }

      if (end < total) {
        await route.fulfill({ status: 308, body: '' });
        return;
      }

      await json({
        id: 'file-e2e-1',
        name: state.uploadedName,
        webViewLink: 'https://drive.google.com/file/d/file-e2e-1/view',
      });
      return;
    }

    /* files.list（フォルダ検索・既存ファイル名の取得） */
    if (url.pathname.endsWith('/drive/v3/files') && request.method() === 'GET') {
      const q = url.searchParams.get('q') ?? '';

      if (q.includes("name='TSAM AI'")) {
        await json({ files: [{ id: FOLDER_ROOT_ID, name: 'TSAM AI' }] });
        return;
      }

      if (q.includes("name='Voice Recorder'")) {
        await json({ files: [{ id: FOLDER_APP_ID, name: 'Voice Recorder' }] });
        return;
      }

      /* 保存先の中身（連番の判定に使われる） */
      await json({ files: existingNames.map((name) => ({ name })) });
      return;
    }

    await json({ error: { message: `unexpected ${request.method()} ${url.pathname}` } }, 500);
  });

  return state;
}

/* 5秒録音して停止し、保存できる状態にする。 */
async function recordAndStop(page, seconds = 5) {
  await page.locator('#vr-start').click();
  await expect(page.locator('#vr-indicator')).toHaveAttribute('data-state', 'recording');
  await page.waitForTimeout(seconds * 1000);
  await page.locator('#vr-stop').click();
  await expect(page.locator('#vr-save-panel')).toBeVisible();
}

test.describe('Google Drive への保存', () => {
  test('連携するとアカウントが表示される（§FR-02）', async ({ page }) => {
    await stubGis(page, 'grant');
    await stubDrive(page);
    await gotoRecorder(page);

    await expect(page.locator('#vr-state-oauth')).toHaveText('未連携');

    await page.locator('#vr-connect').click();

    await expect(page.locator('#vr-state-oauth')).toHaveText('drive-user@example.com');
    await expect(page.locator('#vr-connect')).toHaveText('連携しなおす');
  });

  /*
   * 「連携しなおす」は #vr-connect にしかなく、それは「利用の準備」の中にある。
   * updatePrepPanel() が呼ばれるたびに open を書いていたころは、開き直しても
   * 次の録音停止・破棄（updateSaveButton 経由）が閉じてしまい、期限切れ
   * エラーが出ていない場面では**連携をやり直す手段が画面から消えていた**。
   */
  test('畳んだ準備パネルを開き直すと、その後の操作で閉じない（§7）', async ({ page }) => {
    await stubGis(page, 'grant');
    await stubDrive(page);
    await gotoRecorder(page);

    const prepOpen = () => page.locator('#vr-prep').evaluate((node) => node.open);

    /* 未連携の間は開いたまま（§7「1つでも問題があれば開いたまま」）。 */
    expect(await prepOpen()).toBe(true);

    await page.locator('#vr-connect').click();
    await expect(page.locator('#vr-state-oauth')).toHaveText('drive-user@example.com');

    /* 4項目すべて正常になった時点で畳む（§7）。 */
    await expect.poll(prepOpen).toBe(false);
    await expect(page.locator('#vr-prep-summary')).toHaveText('利用の準備 — 完了');

    /* 利用者が自分で開き直す。 */
    await page.locator('#vr-prep-summary').click();
    expect(await prepOpen()).toBe(true);

    await recordAndStop(page, 3);
    expect(await prepOpen()).toBe(true);
    await expect(page.locator('#vr-connect')).toBeVisible();

    await page.locator('#vr-discard').click();
    expect(await prepOpen()).toBe(true);
    await expect(page.locator('#vr-connect')).toBeVisible();
  });

  test('アプリを開いただけでは認可を要求しない（§FR-02）', async ({ page }) => {
    await stubGis(page, 'grant');
    await stubDrive(page);
    await gotoRecorder(page);
    await recordAndStop(page, 3);

    /* 連携ボタンを押すまで requestAccessToken は呼ばれない。 */
    expect(await page.evaluate(() => window.__gisCalls)).toBe(0);
  });

  test('保存すると連番なしの名前で送られ、結果とリンクが出る（§FR-07 / §FR-08）', async ({ page }) => {
    await stubGis(page, 'grant');
    const drive = await stubDrive(page, { existingNames: [] });
    await gotoRecorder(page);

    await page.locator('#vr-connect').click();
    await expect(page.locator('#vr-state-oauth')).toHaveText('drive-user@example.com');

    await recordAndStop(page, 5);
    const expectedName = await page.locator('#vr-name').inputValue();

    await expect(page.locator('#vr-save')).toBeEnabled();
    await page.locator('#vr-save').click();

    await expect(page.locator('#vr-result-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#vr-result-name')).toHaveText(expectedName);
    await expect(page.locator('#vr-result-folder'))
      .toHaveText('マイドライブ ＞ TSAM AI ＞ Voice Recorder');
    await expect(page.locator('#vr-result-link a'))
      .toHaveAttribute('href', 'https://drive.google.com/file/d/file-e2e-1/view');

    expect(drive.uploadedName).toBe(expectedName);

    /* 保存が済んだら端末内の一時データを消す（§FR-08）。 */
    await expect.poll(async () => (await listRecordings(page)).length, { timeout: 15_000 })
      .toBe(0);

    /* 保存済みなので離脱警告の対象から外れている。 */
    await expect(page.locator('#vr-save-panel')).toBeHidden();
  });

  test('同名が既にあると連番が付く（§FR-07）', async ({ page }) => {
    await stubGis(page, 'grant');
    await gotoRecorder(page);
    await page.locator('#vr-connect').click();
    await recordAndStop(page, 4);

    const baseName = await page.locator('#vr-name').inputValue();

    /* 「その名前は既にある」状態を作ってから保存する。 */
    const drive = await stubDrive(page, { existingNames: [baseName] });

    await page.locator('#vr-save').click();
    await expect(page.locator('#vr-result-panel')).toBeVisible({ timeout: 30_000 });

    const expected = baseName.replace(/\.mp3$/, '_2.mp3');
    expect(drive.uploadedName).toBe(expected);
    await expect(page.locator('#vr-result-name')).toHaveText(expected);
  });

  test('ファイル名を編集すると、その名前で保存される（§FR-07）', async ({ page }) => {
    await stubGis(page, 'grant');
    const drive = await stubDrive(page);
    await gotoRecorder(page);
    await page.locator('#vr-connect').click();
    await recordAndStop(page, 4);

    /* 拡張子なしで入力 → .mp3 が付くこと。 */
    await page.locator('#vr-name').fill('会議メモ');
    await page.locator('#vr-save').click();

    await expect(page.locator('#vr-result-panel')).toBeVisible({ timeout: 30_000 });
    expect(drive.uploadedName).toBe('会議メモ.mp3');
  });

  test('連携前は保存できず、案内が出る（§FR-02）', async ({ page }) => {
    await stubGis(page, 'grant');
    await stubDrive(page);
    await gotoRecorder(page);
    await recordAndStop(page, 3);

    await expect(page.locator('#vr-save')).toBeDisabled();
    /* 案内は専用欄に出す。共有の #vr-message を使うと停止理由を上書きしてしまう。 */
    await expect(page.locator('#vr-save-hint')).toContainText('先に「連携する」');
    await expect(page.locator('#vr-message')).not.toContainText('先に「連携する」');
  });

  test('連携に失敗すると、オリジン未登録の可能性を含めて案内する（§9）', async ({ page }) => {
    await stubGis(page, 'popup_closed');
    await stubDrive(page);
    await gotoRecorder(page);

    await page.locator('#vr-connect').click();

    await expect(page.locator('#vr-error')).toContainText('承認済みの JavaScript 生成元');
    /* 推測した固定値ではなく、実際に開いているオリジンを出す。 */
    await expect(page.locator('#vr-error')).toContainText('http://localhost:8123');
    await expect(page.locator('#vr-state-oauth')).toHaveText('未連携');
  });

  test('ポップアップが開けない場合は別の案内を出す（§9）', async ({ page }) => {
    await stubGis(page, 'popup_blocked');
    await stubDrive(page);
    await gotoRecorder(page);

    await page.locator('#vr-connect').click();

    await expect(page.locator('#vr-error')).toContainText('ポップアップブロック');
  });

  test('保存に失敗しても録音は残り、再試行できる（§FR-08）', async ({ page }) => {
    await stubGis(page, 'grant');
    await stubDrive(page, { uploadStatus: 500 });
    await gotoRecorder(page);
    await page.locator('#vr-connect').click();
    await recordAndStop(page, 4);

    await page.locator('#vr-save').click();

    await expect(page.locator('#vr-error')).toContainText('保存に失敗しました');
    await expect(page.locator('#vr-retry-actions')).toBeVisible();
    await expect(page.locator('#vr-retry-actions button')).toHaveText('保存をやり直す');

    /* 録音データは消していない。 */
    expect(await listRecordings(page)).toHaveLength(1);
    await expect(page.locator('#vr-save-panel')).toBeVisible();
  });

  test('認証切れは再連携の導線を出す（§FR-02 / §9）', async ({ page }) => {
    await stubGis(page, 'grant');
    await stubDrive(page, { uploadStatus: 401 });
    await gotoRecorder(page);
    await page.locator('#vr-connect').click();
    await recordAndStop(page, 4);

    await page.locator('#vr-save').click();

    await expect(page.locator('#vr-error')).toContainText('有効期限が切れました');
    await expect(page.locator('#vr-retry-actions button')).toHaveText('連携しなおす');
    /* 一度連携している以上「未連携」ではない。期限切れとして見せる。 */
    await expect(page.locator('#vr-state-oauth')).toHaveText('認証の期限切れ');
    expect(await listRecordings(page)).toHaveLength(1);
  });

  /*
   * ------------------------------------------------------------------
   * 録音中にトークンが切れる（90分録音で必ず起きる）
   * ------------------------------------------------------------------
   * アクセストークンの寿命は約1時間で、録音の上限（90分）より短い。
   * 先に連携して90分録音すると、停止した時点では必ず切れている。
   *
   * 90分の通し確認（soak90）で実際にこれを踏み、保存ボタンが押せないまま
   * テストが止まった。90分待たずに同じ筋を通せるよう、
   * トークンの寿命を短くして再現する。
   *
   * 65秒にしているのは、oauth.js が期限を60秒手前で切る（境目で401を踏まないため）
   * ことによる。60秒以下を渡すと**取得した瞬間から無効**になり、
   * 「録音中に切れる」ではなく「そもそも連携できない」を試すことになってしまう。
   * ------------------------------------------------------------------
   */
  test('録音中に認証が切れても、連携しなおせば保存できる（§FR-02）', async ({ page }) => {
    await stubGis(page, 'grant', { expiresIn: 65 });
    const drive = await stubDrive(page);
    await gotoRecorder(page);

    await page.locator('#vr-connect').click();
    await expect(page.locator('#vr-state-oauth')).toHaveText('drive-user@example.com');

    /* 録音のあいだに期限が切れる（有効5秒に対して10秒録る）。 */
    await recordAndStop(page, 10);

    /* 連携済みのまま見せない。何が起きたのかが分かる表示にする。 */
    await expect(page.locator('#vr-state-oauth')).toHaveText('認証の期限切れ');
    await expect(page.locator('#vr-save')).toBeDisabled();
    await expect(page.locator('#vr-save-hint')).toContainText('有効期限が切れました');
    await expect(page.locator('#vr-save-hint')).toContainText('連携しなおす');

    /* 録音は残っている。 */
    expect(await listRecordings(page)).toHaveLength(1);

    /*
     * 連携しなおせば、そのまま保存できる（録り直しは要らない）。
     * addInitScript は遷移時にしか効かないため、ここでは直接差し替える。
     */
    await page.evaluate(() => {
      window.google.accounts.oauth2.initTokenClient = (config) => ({
        requestAccessToken: () => config.callback({ access_token: 'renewed', expires_in: 3600 }),
      });
    });
    await page.locator('#vr-connect').click();
    await expect(page.locator('#vr-state-oauth')).toHaveText('drive-user@example.com');
    await expect(page.locator('#vr-save-hint')).toBeHidden();
    await expect(page.locator('#vr-save')).toBeEnabled();

    await page.locator('#vr-save').click();
    await expect(page.locator('#vr-result-panel')).toBeVisible({ timeout: 30_000 });
    expect(drive.uploadedName).not.toBeNull();
  });
});
