/*
 * 不足フォルダの確認と作成。
 *
 * ------------------------------------------------------------------
 * 進め方
 * ------------------------------------------------------------------
 *  1. scanFolderStructure()  … 読み取り専用で目標構成を1階層ずつ確認する。
 *                              ここまでは書き込み権限を一切要求しない。
 *  2. 利用者が確認ダイアログで「作成する」を押す。
 *  3. createMissingFolders() … そのときだけ書き込み用トークンを取り、
 *                              欠けているフォルダを **上から順に** 作る。
 *                              作る直前に必ず再検索し、あれば再利用する。
 *  4. 終わったら書き込み用トークンを即座に捨てる。
 * ------------------------------------------------------------------
 *
 * 多重実行の防止:
 *   - 同一タブ           … モジュール内のフラグ
 *   - 複数タブ           … Web Locks API（同一オリジンで排他）
 *   - 同期中の作成       … isSyncing() を見て断る
 *   - 作成中の同期       … isCreatingFolders() を sync 側から見てもらう
 */

import { FOLDER_STRUCTURE, DRIVE_ROOT_LABEL, isFolderCreateModeAvailable, FOLDER_CREATE_SCOPE_MODE } from '../config.js';
import { findFoldersByName } from './drive-client.js';
import { createFolder } from './drive-writer.js';
import {
  buildFolderPlan, classifyPlan, summarizePlan, selectCreationTargets,
  NodeStatus, PlanStatus, formatNodePath,
} from './folder-plan.js';
import { requestWriteToken, discardWriteToken } from '../auth/google-auth.js';
import { AppError, ErrorCode, toAppError } from '../core/errors.js';
import { logger } from '../core/logger.js';

/* 複数タブでの同時実行を止めるためのロック名。 */
const LOCK_NAME = 'tsam-knowledge-folder-create';

let creating = false;

export function isCreatingFolders() {
  return creating;
}

/* ================================================================
 * 1. 確認（読み取り専用）
 * ================================================================ */

/*
 * 目標構成を1階層ずつ確認する。
 *
 * 親が未確定（不足・同名複数）の階層は探索しない。
 * 親IDを持たずに名前だけで検索すると、別階層の同名フォルダを拾うため。
 *
 * 戻り値は summarizePlan() の結果に parentIds / paths を足したもの。
 */
export async function scanFolderStructure({ structure = FOLDER_STRUCTURE, signal } = {}) {
  const nodes = buildFolderPlan(structure);
  const found = new Map();
  const idByKey = new Map();

  for (const node of nodes) {
    const parentId = node.parentKey ? idByKey.get(node.parentKey) : 'root';

    /* 親が決まっていない階層は、探索そのものを行わない。 */
    if (!parentId) {
      continue;
    }

    /* eslint-disable-next-line no-await-in-loop */
    const result = await findFoldersByName({ parentId, name: node.name, signal });
    const parentName = node.parentKey ? node.parentPath[node.parentPath.length - 1] : DRIVE_ROOT_LABEL;

    if (result.exact.length === 1) {
      const folder = result.exact[0];
      found.set(node.key, {
        status: 'found',
        folder: { id: folder.id, name: folder.name, webViewLink: folder.webViewLink ?? '' },
      });
      idByKey.set(node.key, folder.id);
      continue;
    }

    if (result.exact.length > 1) {
      found.set(node.key, {
        status: 'ambiguous',
        candidates: result.exact.map((folder) => ({ id: folder.id, name: folder.name, parentName })),
      });
      continue;
    }

    found.set(node.key, {
      status: 'not-found',
      candidates: result.loose.map((folder) => ({ id: folder.id, name: folder.name, parentName })),
    });
  }

  const entries = classifyPlan(nodes, found).map((entry) => ({
    ...entry,
    parentId: entry.node.parentKey ? (idByKey.get(entry.node.parentKey) ?? null) : 'root',
    path: formatNodePath(entry.node),
  }));

  const summary = summarizePlan(entries);

  logger.info('folder-structure:scanned', {
    existing: summary.existing.length,
    missing: summary.missing.length,
    ambiguous: summary.ambiguous.length,
  });

  return {
    ...summary,
    /* key → id。作成時の親IDの起点にする。 */
    idByKey,
    scannedAt: new Date().toISOString(),
  };
}

/* ================================================================
 * 2. 作成（利用者が明示的に押したときだけ）
 * ================================================================ */

/*
 * 欠けているフォルダを作る。
 *
 * options:
 *   onProgress … ({ phase, done, total, currentName }) => void
 *   signal     … AbortSignal
 *   isBusy     … () => boolean  同期中かどうかの判定（呼び出し側から渡す）
 *
 * 戻り値:
 *   { ok, created[], reused[], failed[], skipped[], error, plan }
 *
 * 例外は投げない。部分的に成功した分を必ず返す（再実行で続きから進めるため）。
 */
export async function createMissingFolders({
  structure = FOLDER_STRUCTURE,
  onProgress,
  signal,
  isBusy,
} = {}) {
  if (!isFolderCreateModeAvailable()) {
    return failure(new AppError(ErrorCode.FOLDER_CREATE_MODE_UNAVAILABLE, FOLDER_CREATE_SCOPE_MODE));
  }

  if (creating) {
    return failure(new AppError(ErrorCode.FOLDER_CREATE_IN_PROGRESS, 'same_tab'));
  }

  if (typeof isBusy === 'function' && isBusy()) {
    return failure(new AppError(ErrorCode.FOLDER_CREATE_BLOCKED_BY_SYNC, 'sync_running'));
  }

  creating = true;

  try {
    return await withCrossTabLock(() => run({ structure, onProgress, signal, isBusy }));
  } catch (error) {
    return failure(toAppError(error, ErrorCode.FOLDER_CREATE_FAILED));
  } finally {
    creating = false;
    /* 成功・失敗・中断のいずれでも、書き込み用トークンをアプリ内部から消す。 */
    discardWriteToken();
  }
}

/*
 * Web Locks で他タブと排他する。
 * 対応していないブラウザでは同一タブのフラグだけで守る（機能は止めない）。
 */
async function withCrossTabLock(task) {
  const locks = globalThis.navigator?.locks;

  if (!locks || typeof locks.request !== 'function') {
    return task();
  }

  const result = await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      /* 他のタブが実行中。待たずに断る。 */
      return failure(new AppError(ErrorCode.FOLDER_CREATE_IN_PROGRESS, 'other_tab'));
    }
    return task();
  });

  return result;
}

async function run({ structure, onProgress, signal, isBusy }) {
  /* 押した瞬間の状態で判断せず、必ず取り直す（別タブで作られている場合がある）。 */
  const plan = await scanFolderStructure({ structure, signal });

  if (plan.status === PlanStatus.AMBIGUOUS) {
    return failure(new AppError(ErrorCode.FOLDER_CREATE_AMBIGUOUS, 'ambiguous_before_create'), plan);
  }

  const targets = selectCreationTargets(plan.entries);

  if (targets.length === 0) {
    logger.info('folder-create:nothing-to-do');
    return {
      ok: true, created: [], reused: [], failed: [], skipped: [], error: null, plan,
    };
  }

  /*
   * ここで初めて書き込み権限を要求する。
   * 利用者のクリックから同期的に呼ばれる経路にしてあるため、
   * ポップアップブロックの対象にならない。
   */
  report(onProgress, { phase: 'authorizing', done: 0, total: targets.length, currentName: '' });

  try {
    await requestWriteToken();
  } catch (error) {
    return failure(toAppError(error, ErrorCode.WRITE_SCOPE_NOT_GRANTED), plan);
  }

  const idByKey = new Map(plan.idByKey);
  const created = [];
  const reused = [];
  const failed = [];
  const skipped = [];

  for (let index = 0; index < targets.length; index += 1) {
    const node = targets[index];

    if (signal?.aborted) {
      skipped.push({ node, reason: ErrorCode.CANCELLED });
      continue;
    }

    /* 作成中に同期が始まっていたら止める（要件：作成中の同期を許さない）。 */
    if (typeof isBusy === 'function' && isBusy()) {
      skipped.push({ node, reason: ErrorCode.FOLDER_CREATE_BLOCKED_BY_SYNC });
      continue;
    }

    const parentId = node.parentKey ? idByKey.get(node.parentKey) : 'root';

    /* 親の作成に失敗している場合は、その子は作らない（宙に浮かせない）。 */
    if (!parentId) {
      skipped.push({ node, reason: ErrorCode.FOLDER_CREATE_FAILED });
      continue;
    }

    report(onProgress, {
      phase: 'creating', done: index, total: targets.length, currentName: node.name,
    });

    /*
     * 作る直前に必ず再検索する。
     *   - 前回の実行で作られていた
     *   - 別のタブ／別の端末で作られていた
     *   - 利用者が Drive 上で手で作った
     * いずれの場合も、二重に作らず既存を再利用する。
     */
    let existing;

    try {
      /* eslint-disable-next-line no-await-in-loop */
      existing = await findFoldersByName({ parentId, name: node.name, signal });
    } catch (error) {
      failed.push({ node, error: toAppError(error, ErrorCode.DRIVE_API_ERROR) });
      continue;
    }

    if (existing.exact.length > 1) {
      /* 直前に同名が増えた。自動では選ばない。 */
      failed.push({ node, error: new AppError(ErrorCode.FOLDER_CREATE_AMBIGUOUS, node.name) });
      continue;
    }

    if (existing.exact.length === 1) {
      const folder = existing.exact[0];
      idByKey.set(node.key, folder.id);
      reused.push({ node, folder: { id: folder.id, name: folder.name, webViewLink: folder.webViewLink ?? '' } });
      continue;
    }

    try {
      /* eslint-disable-next-line no-await-in-loop */
      const folder = await createFolder({ name: node.name, parentId, signal });
      idByKey.set(node.key, folder.id);
      created.push({ node, folder });
    } catch (error) {
      const appError = toAppError(error, ErrorCode.FOLDER_CREATE_FAILED);
      failed.push({ node, error: appError });

      /*
       * 認証・権限の問題は、続けても同じ結果になる。
       * 残りは「未実行」として明示し、無駄なリクエストを送らない。
       */
      if (isFatal(appError)) {
        for (let rest = index + 1; rest < targets.length; rest += 1) {
          skipped.push({ node: targets[rest], reason: appError.code });
        }
        break;
      }
    }
  }

  report(onProgress, {
    phase: 'creating', done: targets.length, total: targets.length, currentName: '',
  });

  const ok = failed.length === 0 && skipped.length === 0;

  logger.info('folder-create:done', {
    created: created.length, reused: reused.length, failed: failed.length, skipped: skipped.length,
  });

  return {
    ok,
    created,
    reused,
    failed,
    skipped,
    error: ok ? null : new AppError(ErrorCode.FOLDER_CREATE_FAILED, 'partial'),
    plan,
  };
}

/* 続行しても意味がないエラー。 */
function isFatal(error) {
  return error?.code === ErrorCode.AUTH_EXPIRED
    || error?.code === ErrorCode.WRITE_SCOPE_NOT_GRANTED
    || error?.code === ErrorCode.DRIVE_PERMISSION_DENIED
    || error?.code === ErrorCode.DRIVE_API_DISABLED
    || error?.code === ErrorCode.CANCELLED;
}

function report(onProgress, progress) {
  if (typeof onProgress === 'function') {
    try {
      onProgress(progress);
    } catch {
      /* 表示側の例外で作成処理を壊さない。 */
    }
  }
}

function failure(error, plan = null) {
  return {
    ok: false, created: [], reused: [], failed: [], skipped: [], error, plan,
  };
}

export { NodeStatus, PlanStatus };
