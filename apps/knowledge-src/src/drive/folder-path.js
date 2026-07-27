/*
 * 固定フォルダパスの階層探索。
 *
 * ------------------------------------------------------------------
 * 探索方法（重要）
 * ------------------------------------------------------------------
 * マイドライブ（root）から始めて、1階層ずつ
 *   「親フォルダID」＋「名前の完全一致」＋「フォルダ種別」＋「ゴミ箱除外」
 * で絞り込む。フォルダ名だけの全体検索は行わない。
 *
 *   root        --name='TSAM AI'-->    TSAM AI
 *   TSAM AI     --name='ローカルLLM'--> ローカルLLM
 *   ローカルLLM --name='01_ナレッジ'--> 01_ナレッジ
 *
 * 同名フォルダが複数見つかった場合は **自動選択しない**。
 * 候補を返し、利用者に選ばせる。
 *
 * 見つからない場合も **フォルダを作成しない**（読み取り専用のため）。
 * ------------------------------------------------------------------
 */

import { findFoldersByName } from './drive-client.js';
import { KNOWLEDGE_FOLDER_PATH, DRIVE_ROOT_LABEL, SCOPE_MODE } from '../config.js';
import { AppError, ErrorCode, toAppError } from '../core/errors.js';
import { logger } from '../core/logger.js';

export const PathResolveStatus = Object.freeze({
  RESOLVED: 'resolved',       // 末端まで一意に決まった
  NOT_FOUND: 'not-found',     // ある階層で見つからなかった
  AMBIGUOUS: 'ambiguous',     // ある階層で複数見つかった
  UNSUPPORTED: 'unsupported', // スコープの都合で探索できない
  ERROR: 'error',             // API エラー
});

/* 表示用のパス文字列。「マイドライブ / TSAM AI / ローカルLLM / 01_ナレッジ」 */
export function formatPath(segments = KNOWLEDGE_FOLDER_PATH) {
  return [DRIVE_ROOT_LABEL, ...segments].join(' / ');
}

/*
 * 固定パスを探索する。
 *
 * 戻り値:
 *   { status, folder, trail, missingAt, candidates, error }
 *     folder     … { id, name, path } 解決できた場合のみ
 *     trail      … 解決済みの各階層 [{ name, id }]
 *     missingAt  … 見つからなかった／複数あった階層名
 *     candidates … AMBIGUOUS のときの候補 [{ id, name, parentName }]
 */
export async function resolveKnowledgeFolder({ segments = KNOWLEDGE_FOLDER_PATH, signal } = {}) {
  /*
   * drive.file では「アプリが作成した、または利用者が明示的に選んだ」
   * ファイルしか見えない。未選択のフォルダを名前で探すことはできない。
   */
  if (SCOPE_MODE === 'file') {
    logger.info('folder-path:skipped', { reason: 'scope_is_drive_file' });

    return {
      status: PathResolveStatus.UNSUPPORTED,
      folder: null,
      trail: [],
      missingAt: segments[0] ?? null,
      candidates: [],
      error: null,
      message: 'drive.file スコープでは自動探索できません。フォルダ選択ダイアログから「01_ナレッジ」を選んでください。',
    };
  }

  const trail = [];
  let parentId = 'root';
  let parentName = DRIVE_ROOT_LABEL;

  for (const name of segments) {
    let result;

    try {
      /* eslint-disable-next-line no-await-in-loop */
      result = await findFoldersByName({ parentId, name, signal });
    } catch (error) {
      const appError = toAppError(error, ErrorCode.DRIVE_API_ERROR);
      logger.error('folder-path:lookup-failed', appError, { code: appError.code });

      return {
        status: PathResolveStatus.ERROR,
        folder: null,
        trail,
        missingAt: name,
        candidates: [],
        error: appError,
        message: `「${parentName}」の中で「${name}」を探しているときにエラーが発生しました。${appError.userMessage}`,
      };
    }

    if (result.exact.length === 0) {
      const hint = result.loose.length > 0
        ? `（名前が近いフォルダは ${result.loose.length} 件見つかりました）`
        : '';

      logger.warn('folder-path:not-found', { parentName, name, loose: result.loose.length });

      return {
        status: PathResolveStatus.NOT_FOUND,
        folder: null,
        trail,
        missingAt: name,
        candidates: result.loose.map((folder) => ({
          id: folder.id, name: folder.name, parentName,
        })),
        error: null,
        message: `「${parentName}」の直下に「${name}」フォルダが見つかりませんでした。${hint}`,
      };
    }

    if (result.exact.length > 1) {
      logger.warn('folder-path:ambiguous', { parentName, name, count: result.exact.length });

      return {
        status: PathResolveStatus.AMBIGUOUS,
        folder: null,
        trail,
        missingAt: name,
        candidates: result.exact.map((folder) => ({
          id: folder.id, name: folder.name, parentName,
        })),
        error: null,
        message: `「${parentName}」の直下に「${name}」フォルダが ${result.exact.length} 件あります。`
          + '自動では選べないため、使用するフォルダを選んでください。',
      };
    }

    const found = result.exact[0];
    trail.push({ name: found.name, id: found.id });
    parentId = found.id;
    parentName = found.name;
  }

  const path = formatPath(segments);
  logger.info('folder-path:resolved', { depth: trail.length });

  return {
    status: PathResolveStatus.RESOLVED,
    folder: { id: parentId, name: parentName, path },
    trail,
    missingAt: null,
    candidates: [],
    error: null,
    message: `${path} を確認しました。`,
  };
}

/* 探索結果を利用者向けの短い文へ変換する。 */
export function describeResolveResult(result) {
  if (!result) {
    return '';
  }

  return result.message ?? '';
}

export { AppError };
