/*
 * Google Picker API によるフォルダ選択。
 *
 * Picker には **APIキー** が必要で、静的サイトではキーが公開される。
 * そのため Google Cloud Console 側で必ず
 *   - アプリケーションの制限: HTTPリファラー（https://tsam-ai.com/* など）
 *   - APIの制限: Google Picker API のみ
 * を設定すること。設定手順は apps/KNOWLEDGE_SETUP.md を参照。
 *
 * APIキーが未設定の場合はこのモジュールを呼ばず、
 * Drive API によるフォルダ一覧（ui/folder-browser.js）へフォールバックする。
 */

import { AUTH_CONFIG, isPickerConfigured, SCOPE_MODE } from '../config.js';
import { loadGapiModule } from '../auth/script-loader.js';
import { ensureAccessToken } from '../auth/google-auth.js';
import { AppError, ErrorCode } from '../core/errors.js';
import { logger } from '../core/logger.js';

export function isPickerAvailable() {
  return isPickerConfigured();
}

/*
 * フォルダ選択ダイアログを開く。
 * 解決値: { id, name } / 利用者が閉じた場合は null。
 *
 * 利用者の操作から呼ぶこと（トークン取得のポップアップを伴うため）。
 */
export async function pickFolder() {
  if (!isPickerConfigured()) {
    throw new AppError(ErrorCode.PICKER_KEY_MISSING, 'api_key_missing');
  }

  const token = await ensureAccessToken();
  await loadGapiModule('picker');

  const picker = globalThis.google?.picker;

  if (!picker?.PickerBuilder) {
    throw new AppError(ErrorCode.GIS_LOAD_FAILED, 'picker_namespace_missing');
  }

  return new Promise((resolve, reject) => {
    let instance = null;

    const handle = (data) => {
      const action = data?.[picker.Response.ACTION];

      if (action === picker.Action.PICKED) {
        const doc = data[picker.Response.DOCUMENTS]?.[0];

        instance?.dispose();

        if (!doc?.id) {
          resolve(null);
          return;
        }

        logger.info('picker:folder-selected', { hasName: Boolean(doc.name) });
        resolve({ id: String(doc.id), name: String(doc.name ?? '') });
        return;
      }

      if (action === picker.Action.CANCEL) {
        instance?.dispose();
        resolve(null);
      }
    };

    try {
      const view = new picker.DocsView(picker.ViewId.FOLDERS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes('application/vnd.google-apps.folder');

      const builder = new picker.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(AUTH_CONFIG.pickerApiKey)
        .setTitle('ナレッジ対象のフォルダを選択')
        .setLocale('ja')
        .addView(view)
        .setCallback(handle);

      /*
       * drive.file スコープでは、Picker で選んだフォルダへの権限付与に
       * appId（Cloud プロジェクト番号）が必要になる。
       */
      if (SCOPE_MODE === 'file' && AUTH_CONFIG.pickerAppId) {
        builder.setAppId(String(AUTH_CONFIG.pickerAppId));
      }

      instance = builder.build();
      instance.setVisible(true);
    } catch (error) {
      logger.error('picker:open-failed', error);
      reject(new AppError(ErrorCode.GIS_LOAD_FAILED, error?.message ?? 'picker_build_failed', error));
    }
  });
}
