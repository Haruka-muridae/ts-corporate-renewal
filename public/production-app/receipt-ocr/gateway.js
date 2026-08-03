/*
 * provisioning.js が使う通信口の実装。
 *
 * provisioning.js は「判断」だけを持ち、Drive / Sheets の呼び出しは
 * この形の object 越しに行う。テストは同じ形の偽物を渡す（実通信なし）。
 *
 * ここには判断を書かないこと。分岐が要るなら provisioning.js 側へ置く。
 */

import * as drive from './drive.js';
import * as sheets from './sheets.js';
import { headersOf } from './schema.js';

export function createGateway({ accessToken, signal = undefined } = {}) {
  const auth = { accessToken, signal };

  return {
    getFileMeta: (fileId) => drive.getFileMeta(fileId, auth),

    findOrCreateFolder: (name, parentId) =>
      drive.findOrCreateFolder(name, { ...auth, parentId }),

    findSpreadsheets: (name, parentId) =>
      drive.findByName(name, { ...auth, parentId, mimeType: drive.SPREADSHEET_MIME }),

    moveFile: (fileId, parentId) => drive.moveFile(fileId, { ...auth, parentId }),

    createSpreadsheet: async (title) => {
      const created = await sheets.createSpreadsheet({ ...auth, title });

      return {
        spreadsheetId: created?.spreadsheetId ?? null,
        sheets: (created?.sheets ?? []).map((sheet) => ({
          sheetId: sheet?.properties?.sheetId ?? null,
          title: String(sheet?.properties?.title ?? ''),
        })),
      };
    },

    getStructure: (spreadsheetId) => sheets.getStructure(spreadsheetId, auth),

    readHeader: (spreadsheetId, tabTitle) => sheets.readHeader(spreadsheetId, tabTitle, auth),

    writeAllHeaders: (spreadsheetId) => sheets.writeAllHeaders(spreadsheetId, auth),

    writeHeaderFor: (spreadsheetId, tabTitle, columns) =>
      sheets.writeRange(spreadsheetId, `${tabTitle}!A1`, [headersOf(columns)], auth),

    appendMissingColumns: (spreadsheetId, tabTitle, existingCount, missing) =>
      sheets.appendMissingColumns(spreadsheetId, tabTitle, existingCount, missing, auth),

    addTabs: (spreadsheetId, titles) =>
      sheets.batchUpdate(
        spreadsheetId,
        titles.map((title) => ({ addSheet: { properties: { title } } })),
        auth,
      ),

    writeSchemaVersion: (spreadsheetId, version, { seedDefaults = false } = {}) =>
      sheets.writeSchemaVersion(spreadsheetId, { ...auth, version, seedDefaults }),

    readSettings: (spreadsheetId) => sheets.readSettings(spreadsheetId, auth),

    writeStoreMaster: (spreadsheetId, rows) => sheets.writeStoreMaster(spreadsheetId, rows, auth),

    createReviewViewAndProtection: (spreadsheetId, dataSheetId) =>
      sheets.createReviewViewAndProtection(spreadsheetId, dataSheetId, auth),
  };
}
