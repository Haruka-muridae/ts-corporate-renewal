/*
 * 保存先の自動プロビジョニング（仕様書 §9）。本改訂の中核。
 *
 * ==================================================================
 * 判断はここ、通信は gateway
 * ==================================================================
 * Drive / Sheets への実際の呼び出しは gateway 越しに行う。
 * §9.3 の6行と §9.4 は「どう判断するか」の仕様であって
 * 「どう通信するか」の仕様ではない。切り離しておけば、
 * 壊れた状態のテストを実通信なしで全行ぶん書ける（§16 フェーズ4）。
 * ==================================================================
 *
 * ------------------------------------------------------------------
 * 推測して書き込まない
 * ------------------------------------------------------------------
 * §9.3 の「列の改変」行が明示している。列がずれているシートに対し、
 * 位置を推測して書き込むと、利用者の過去データを静かに壊す。
 * 分からないときは writable=false にして止めるのが正しい。
 * ------------------------------------------------------------------
 */

import { DRIVE_NAMES } from './config.js';
import { AppError } from './errors.js';
import {
  INITIAL_STORE_MASTER,
  REVIEW_FILTER_VIEW_NAME,
  SCHEMA_VERSION,
  TABS,
  TAB_COLUMNS,
  isDataTabMissing,
  missingTabs,
  verifyHeader,
} from './schema.js';
import { clearLocations, readLocations, writeLocations } from './store.js';

/* プロビジョニングの結果（画面はこれを見て案内を出し分ける）。 */
export const PROVISION_STATUS = Object.freeze({
  READY: 'ready',
  CREATED: 'created',
  RECREATED: 'recreated',
  UPGRADED: 'upgraded',
  TABS_REPAIRED: 'tabs-repaired',
  BLOCKED: 'blocked',
});

/* 画面へ出す案内の種類。文言は app.js が持つ（このファイルは判断だけ）。 */
export const NOTICE = Object.freeze({
  /* §9.2 末尾：初回作成時の案内（データ帰属・復元不可・無料枠キー）。 */
  FIRST_RUN: 'first-run',
  /* §9.3「シート削除済み」：空から始まる・過去データは戻らない。 */
  NOT_RESTORED: 'not-restored',
  /* §9.3「2タブ同時初回起動」：古い方を使う・新しい方は使わない。 */
  DUPLICATE_STRUCTURE: 'duplicate-structure',
  /* §9.3「タブ削除」：欠損タブを作り直した。 */
  TABS_REPAIRED: 'tabs-repaired',
  /* §9.4：旧バージョンのシートへ不足列を足した。 */
  SCHEMA_UPGRADED: 'schema-upgraded',
  /* §9.3「列の改変」：書き込みを停止した。修復方法の案内を伴う。 */
  SCHEMA_ALTERED: 'schema-altered',
});

/*
 * フォルダ階層を用意する（§9.1）。
 *
 * マイドライブ/TSAM AI/領収書データ/原本/ まで掘り、各IDを返す。
 * 各段は「探してから作る」（§9.2-3 → §9.2-4）。
 */
async function ensureFolders(gateway, notices) {
  const root = await gateway.findOrCreateFolder(DRIVE_NAMES.root, null);
  const app = await gateway.findOrCreateFolder(DRIVE_NAMES.app, root.folder.id);
  const originals = await gateway.findOrCreateFolder(DRIVE_NAMES.originals, app.folder.id);

  /*
   * §9.3「2タブ同時初回起動」。
   * findOrCreateFolder は作成日時の昇順で返すため、先頭が最も古い。
   * 古い方へ寄せ、新しい方は使わない。**自動削除はしない。**
   */
  if (root.duplicates.length > 0 || app.duplicates.length > 0 || originals.duplicates.length > 0) {
    notices.add(NOTICE.DUPLICATE_STRUCTURE);
  }

  return {
    rootFolderId: root.folder.id,
    appFolderId: app.folder.id,
    originalsFolderId: originals.folder.id,
    createdAny: root.created || app.created || originals.created,
  };
}

/*
 * スプレッドシートを新規作成し、中身を整える（§9.2-4）。
 * ヘッダー行・初期店舗マスタ・スキーマバージョン・要確認一覧を書く。
 */
async function createSpreadsheet(gateway, appFolderId) {
  const created = await gateway.createSpreadsheet(DRIVE_NAMES.spreadsheet);

  await gateway.moveFile(created.spreadsheetId, appFolderId);
  await gateway.writeAllHeaders(created.spreadsheetId);
  /* 新規作成なので、設定の既定値もここで書く（v1.3 §16.6）。 */
  await gateway.writeSchemaVersion(created.spreadsheetId, SCHEMA_VERSION, { seedDefaults: true });
  await gateway.writeStoreMaster(created.spreadsheetId, INITIAL_STORE_MASTER);

  const dataTab = (created.sheets ?? []).find((sheet) => sheet.title === TABS.data);

  if (dataTab) {
    await gateway.createReviewViewAndProtection(created.spreadsheetId, dataTab.sheetId);
  }

  return created.spreadsheetId;
}

/*
 * 既存シートの健全性を見る（§9.3・§9.4）。
 *
 * 戻り値は { status, writable, notices } で、
 * 呼び出し側は writable を見てから書き込む。
 */
async function inspectSpreadsheet(gateway, spreadsheetId, notices) {
  const structure = await gateway.getStructure(spreadsheetId);
  const titles = structure.tabs.map((tab) => tab.title);

  /*
   * §9.3「タブ削除」。データタブが消えている場合は
   * 「シート削除」に準じる案内を出す（中身が失われているため）。
   */
  if (isDataTabMissing(titles)) {
    return { status: PROVISION_STATUS.BLOCKED, writable: false, recreate: true };
  }

  const lacking = missingTabs(titles);

  if (lacking.length > 0) {
    await gateway.addTabs(spreadsheetId, lacking);

    for (const title of lacking) {
      await gateway.writeHeaderFor(spreadsheetId, title, TAB_COLUMNS[title]);
    }

    notices.add(NOTICE.TABS_REPAIRED);
  }

  /* §9.4 ヘッダー検証は名前の完全一致で行う。 */
  const header = await gateway.readHeader(spreadsheetId, TABS.data);
  const verdict = verifyHeader(header, TAB_COLUMNS[TABS.data]);

  if (verdict.status === 'altered') {
    /* §9.3「列の改変」：書き込みを停止する。列位置を推測しない。 */
    notices.add(NOTICE.SCHEMA_ALTERED);
    return { status: PROVISION_STATUS.BLOCKED, writable: false, recreate: false };
  }

  if (verdict.status === 'empty') {
    await gateway.writeHeaderFor(spreadsheetId, TABS.data, TAB_COLUMNS[TABS.data]);
  } else if (verdict.status === 'upgrade') {
    /* §9.4：不足分を右端へ足して更新する。既存列には触れない。 */
    await gateway.appendMissingColumns(
      spreadsheetId,
      TABS.data,
      header.length,
      verdict.missing,
    );
    await gateway.writeSchemaVersion(spreadsheetId, SCHEMA_VERSION);
    notices.add(NOTICE.SCHEMA_UPGRADED);
  }

  /* 要確認一覧が消えていたら作り直す（§11・§15.2）。 */
  if (!structure.filterViews.includes(REVIEW_FILTER_VIEW_NAME)) {
    const dataTab = structure.tabs.find((tab) => tab.title === TABS.data);

    if (dataTab && dataTab.sheetId !== null) {
      await gateway.createReviewViewAndProtection(spreadsheetId, dataTab.sheetId);
    }
  }

  const status = notices.has(NOTICE.SCHEMA_UPGRADED)
    ? PROVISION_STATUS.UPGRADED
    : (notices.has(NOTICE.TABS_REPAIRED) ? PROVISION_STATUS.TABS_REPAIRED : PROVISION_STATUS.READY);

  return { status, writable: true, recreate: false };
}

/*
 * §9.2 の検出→作成フロー。アプリ起動のたびに呼ぶ。
 *
 * 手順（順番を入れ替えないこと）:
 *   1. localStorage の ID を見る
 *   2. ID があれば実体を確認し、有効なら使う
 *   3. 無効・未記憶なら drive.file の範囲で名前検索する
 *   4. それでも無ければ作る
 *   5. 得た ID を覚える
 *
 * **3 を飛ばして 4 へ行かないこと。** localStorage が消えただけの利用者に
 * 空のシートをもう1つ作ってしまう（§15.2 の最終項が禁じている）。
 */
export async function provision(gateway, { locations = readLocations() } = {}) {
  const notices = new Set();

  const folders = await ensureFolders(gateway, notices);

  let spreadsheetId = null;
  let existed = false;

  /* 手順 1〜2：記憶している ID の実体を確認する。 */
  if (locations.spreadsheetId) {
    const meta = await gateway.getFileMeta(locations.spreadsheetId);

    if (meta) {
      spreadsheetId = meta.id;
      existed = true;
    } else {
      /* §9.3「シート削除済み」：ID 参照が 404。記憶を捨てて名前検索へ。 */
      clearLocations();
      notices.add(NOTICE.NOT_RESTORED);
    }
  }

  /* 手順 3：名前検索で再発見する（localStorage 消去後の復旧経路）。 */
  if (!spreadsheetId) {
    const found = await gateway.findSpreadsheets(DRIVE_NAMES.spreadsheet, folders.appFolderId);

    if (found.length > 0) {
      /* §9.3「2タブ同時初回起動」：作成日時が古い方へ寄せる。 */
      spreadsheetId = found[0].id;
      existed = true;

      if (found.length > 1) {
        notices.add(NOTICE.DUPLICATE_STRUCTURE);
      }

      /* 見つかったなら削除されていない。前段の案内は取り消す。 */
      notices.delete(NOTICE.NOT_RESTORED);
    }
  }

  /* 手順 4：本当に無いと分かってから作る。 */
  let created = false;

  if (!spreadsheetId) {
    spreadsheetId = await createSpreadsheet(gateway, folders.appFolderId);
    created = true;
  }

  const nextLocations = {
    rootFolderId: folders.rootFolderId,
    appFolderId: folders.appFolderId,
    originalsFolderId: folders.originalsFolderId,
    spreadsheetId,
  };

  /* 手順 5：覚える。書けなくても続行する（次回また名前検索で見つかる）。 */
  writeLocations(nextLocations);

  if (created) {
    /*
     * 初回作成なら §9.2 末尾の案内、
     * 削除後の再作成なら §9.3 の「復元されません」を添える。
     */
    notices.add(NOTICE.FIRST_RUN);

    return {
      status: notices.has(NOTICE.NOT_RESTORED)
        ? PROVISION_STATUS.RECREATED
        : PROVISION_STATUS.CREATED,
      writable: true,
      locations: nextLocations,
      notices: [...notices],
    };
  }

  const inspection = await inspectSpreadsheet(gateway, spreadsheetId, notices);

  /*
   * データタブごと消えていた場合は、作り直して「シート削除」に準じる案内を出す
   * （§9.3「タブ削除」行の括弧書き）。
   */
  if (inspection.recreate) {
    notices.add(NOTICE.NOT_RESTORED);
    const rebuiltId = await createSpreadsheet(gateway, folders.appFolderId);
    const rebuilt = { ...nextLocations, spreadsheetId: rebuiltId };

    writeLocations(rebuilt);

    return {
      status: PROVISION_STATUS.RECREATED,
      writable: true,
      locations: rebuilt,
      notices: [...notices],
    };
  }

  return {
    status: inspection.status,
    writable: inspection.writable,
    locations: nextLocations,
    /* 停止時は DRV-002 を添える（§12）。 */
    errorCode: inspection.writable ? null : 'DRV-002',
    notices: [...notices],
  };
}

/*
 * 書き込み前の確認。
 * provision() の結果を持ち回り、保存の直前にもう一度見る。
 * 停止中のシートへ書こうとしたら、ここで AppError を投げて止める。
 */
export function assertWritable(result) {
  if (!result?.writable) {
    throw new AppError(result?.errorCode ?? 'DRV-002');
  }

  return true;
}
