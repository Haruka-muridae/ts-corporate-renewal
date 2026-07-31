/*
 * 01_ナレッジ を **新規作成したときだけ** 置く、動作確認用ファイルの作成。
 *
 * ------------------------------------------------------------------
 * 守ること
 * ------------------------------------------------------------------
 *  - 01_ナレッジ が既にあった場合は実行しない（呼び出し側で判定する）。
 *  - 作る前に必ずフォルダ内を一覧し、**同名ファイルがあれば作らない**。
 *  - 上書き・更新は行わない。そもそも更新用のAPIを実装していない。
 *  - 1度作ったら記録し、2度目は実行しない。
 * ------------------------------------------------------------------
 */

import { SAMPLE_FILES } from '../config.js';
import { listFilesInFolder } from './drive-client.js';
import { createTextFile } from './drive-writer.js';
import { AppError, ErrorCode, toAppError } from '../core/errors.js';
import { logger } from '../core/logger.js';

export const SampleStatus = Object.freeze({
  MISSING: 'missing',   // 無いので作る
  EXISTING: 'existing', // 既にあるので作らない
});

/*
 * フォルダ内の既存ファイル名から、作るべきものを決める。
 *
 * 名前の比較は完全一致（前後の空白も含む）。
 * ゴミ箱のファイルは呼び出し側の一覧が除外している。
 */
export function planSampleFiles(existingNames = [], samples = SAMPLE_FILES) {
  const taken = new Set(existingNames.map((name) => String(name)));

  return samples.map((sample) => ({
    name: sample.name,
    mimeType: sample.mimeType,
    description: sample.description,
    status: taken.has(sample.name) ? SampleStatus.EXISTING : SampleStatus.MISSING,
  }));
}

/* 作成対象だけを、定義順に返す。 */
export function selectSampleTargets(plan) {
  return plan.filter((entry) => entry.status === SampleStatus.MISSING);
}

/*
 * サンプルファイルを作る。
 *
 * 戻り値: { ok, created[], skipped[], failed[], plan, error }
 * 例外は投げない（部分的な成功を必ず返し、再実行で続きから進められるようにする）。
 */
export async function createSampleFiles({ folderId, signal, onProgress } = {}) {
  if (!folderId) {
    return failure(new AppError(ErrorCode.SETUP_STEP_BLOCKED, 'no_folder'));
  }

  /* 1. 既存ファイルを確認する（読み取り専用）。 */
  let existingNames;

  try {
    existingNames = await listAllNames(folderId, signal);
  } catch (error) {
    return failure(toAppError(error, ErrorCode.DRIVE_API_ERROR));
  }

  const plan = planSampleFiles(existingNames);
  const targets = selectSampleTargets(plan);
  const skipped = plan.filter((entry) => entry.status === SampleStatus.EXISTING);

  if (targets.length === 0) {
    logger.info('sample-files:nothing-to-do', { existing: skipped.length });
    return {
      ok: true, created: [], skipped, failed: [], plan, error: null,
    };
  }

  const created = [];
  const failed = [];

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];

    if (signal?.aborted) {
      failed.push({ ...target, error: new AppError(ErrorCode.CANCELLED, 'aborted') });
      continue;
    }

    report(onProgress, {
      phase: 'creating', done: index, total: targets.length, currentName: target.name,
    });

    const definition = SAMPLE_FILES.find((sample) => sample.name === target.name);

    try {
      /* eslint-disable-next-line no-await-in-loop */
      const file = await createTextFile({
        name: definition.name,
        parentId: folderId,
        mimeType: definition.mimeType,
        content: definition.content,
        signal,
      });

      created.push({ ...target, file });
    } catch (error) {
      failed.push({ ...target, error: toAppError(error, ErrorCode.SAMPLE_CREATE_FAILED) });
    }
  }

  report(onProgress, {
    phase: 'creating', done: targets.length, total: targets.length, currentName: '',
  });

  const ok = failed.length === 0;

  logger.info('sample-files:done', {
    created: created.length, skipped: skipped.length, failed: failed.length,
  });

  return {
    ok,
    created,
    skipped,
    failed,
    plan,
    error: ok ? null : new AppError(ErrorCode.SAMPLE_CREATE_FAILED, 'partial'),
  };
}

/* フォルダ直下のファイル名を全ページ集める（フォルダ自身は除く）。 */
async function listAllNames(folderId, signal) {
  const names = [];
  let pageToken;

  do {
    /* eslint-disable-next-line no-await-in-loop */
    const page = await listFilesInFolder({ folderId, pageToken, pageSize: 100, signal });
    page.files.forEach((file) => names.push(String(file.name)));
    pageToken = page.nextPageToken;
  } while (pageToken);

  return names;
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

function failure(error) {
  return {
    ok: false, created: [], skipped: [], failed: [], plan: [], error,
  };
}
