/*
 * 端末から選ばれたFileを、Driveへ安全に追加できる計画へ変換する。
 *
 * このモジュールは純粋関数だけを持つ。DOM・認証・通信は扱わないため、
 * ファイル名、上限、相対パス、重複名を単体テストできる。
 */

import { KNOWLEDGE_UPLOAD_LIMITS, KNOWLEDGE_UPLOAD_TYPES } from '../config.js';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b\u202a-\u202e\u2066-\u2069]/g;
const PATH_SEPARATORS = /[\\/:*?"<>|]/g;

export const UploadSupport = Object.freeze({
  PARSEABLE: 'parseable',
  STORE_ONLY: 'store-only',
  REJECTED: 'rejected',
});

export const UploadRejectReason = Object.freeze({
  EMPTY: 'empty',
  UNSUPPORTED: 'unsupported',
  FILE_TOO_LARGE: 'file-too-large',
  TOO_MANY_FILES: 'too-many-files',
  TOTAL_TOO_LARGE: 'total-too-large',
  PATH_TOO_DEEP: 'path-too-deep',
  INVALID_NAME: 'invalid-name',
});

function extensionOf(name) {
  const value = String(name ?? '');
  const dot = value.lastIndexOf('.');
  return dot > 0 ? value.slice(dot).toLowerCase() : '';
}

function truncateCodePoints(value, max) {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join('');
}

/*
 * DriveではWindowsの予約名も保存できるが、後から同期クライアントへ落とすと
 * 問題になるため先頭へ「_」を付ける。空名・"."・".." は採用しない。
 */
export function sanitizePathSegment(value, { maxCodePoints = KNOWLEDGE_UPLOAD_LIMITS.maxNameCodePoints } = {}) {
  let name = String(value ?? '')
    .normalize('NFC')
    .replace(CONTROL_OR_BIDI, '')
    .replace(PATH_SEPARATORS, '_')
    .trim()
    .replace(/[. ]+$/g, '');

  if (name === '' || name === '.' || name === '..') {
    return '';
  }

  if (WINDOWS_RESERVED.test(name)) {
    name = `_${name}`;
  }

  if (Array.from(name).length <= maxCodePoints) {
    return name;
  }

  const ext = extensionOf(name);
  const extPoints = Array.from(ext);
  const base = ext ? name.slice(0, -ext.length) : name;
  const room = Math.max(1, maxCodePoints - extPoints.length);

  return `${truncateCodePoints(base, room)}${truncateCodePoints(ext, maxCodePoints - room)}`;
}

export function classifyUploadFile(file) {
  const ext = extensionOf(file?.name);
  const type = KNOWLEDGE_UPLOAD_TYPES[ext] ?? null;

  if (!type) {
    return {
      support: UploadSupport.REJECTED,
      extension: ext,
      label: ext ? ext.slice(1).toUpperCase() : '不明',
      mimeType: String(file?.type ?? 'application/octet-stream'),
      reason: UploadRejectReason.UNSUPPORTED,
    };
  }

  return {
    support: type.parseable ? UploadSupport.PARSEABLE : UploadSupport.STORE_ONLY,
    extension: ext,
    label: type.label,
    mimeType: type.mimeType,
    reason: type.parseable ? '' : 'Driveへ保存できますが、現在の版では解析・検索できません。',
  };
}

/*
 * webkitRelativePath はブラウザ由来でも信用せず、各階層を個別に正規化する。
 * 相対パスが無い通常選択は、ファイル名1要素だけになる。
 */
export function safeRelativeParts(file) {
  const raw = String(file?.webkitRelativePath || file?.name || '');
  const rawParts = raw.split(/[\\/]+/).filter(Boolean);
  const parts = rawParts.map((part) => sanitizePathSegment(part));

  if (parts.length === 0 || parts.some((part) => part === '')) {
    return [];
  }

  return parts;
}

export function buildUploadPlan(files, limits = KNOWLEDGE_UPLOAD_LIMITS) {
  const source = Array.from(files ?? []);
  const accepted = [];
  const rejected = [];
  let totalBytes = 0;

  source.forEach((file, index) => {
    const classification = classifyUploadFile(file);
    const size = Number(file?.size) || 0;
    const parts = safeRelativeParts(file);
    let rejectReason = '';

    if (index >= limits.maxFiles) {
      rejectReason = UploadRejectReason.TOO_MANY_FILES;
    } else if (size <= 0) {
      rejectReason = UploadRejectReason.EMPTY;
    } else if (size > limits.maxFileBytes) {
      rejectReason = UploadRejectReason.FILE_TOO_LARGE;
    } else if (parts.length === 0) {
      rejectReason = UploadRejectReason.INVALID_NAME;
    } else if (parts.length - 1 > limits.maxFolderDepth) {
      rejectReason = UploadRejectReason.PATH_TOO_DEEP;
    } else if (classification.support === UploadSupport.REJECTED) {
      rejectReason = classification.reason;
    } else if (totalBytes + size > limits.maxTotalBytes) {
      rejectReason = UploadRejectReason.TOTAL_TOO_LARGE;
    }

    const base = {
      id: `local-${index}`,
      file,
      sourceName: String(file?.name ?? ''),
      safeName: parts.at(-1) ?? '',
      folders: parts.slice(0, -1),
      relativePath: parts.join('/'),
      size,
      ...classification,
    };

    if (rejectReason) {
      rejected.push({ ...base, rejectReason });
      return;
    }

    totalBytes += size;
    accepted.push(base);
  });

  return {
    accepted,
    rejected,
    totalBytes,
    selectedCount: source.length,
    parseableCount: accepted.filter((item) => item.support === UploadSupport.PARSEABLE).length,
    storeOnlyCount: accepted.filter((item) => item.support === UploadSupport.STORE_ONLY).length,
  };
}

export function rejectReasonLabel(reason, limits = KNOWLEDGE_UPLOAD_LIMITS) {
  const labels = {
    [UploadRejectReason.EMPTY]: '0バイトのため追加できません。',
    [UploadRejectReason.UNSUPPORTED]: '対応していない形式です。',
    [UploadRejectReason.FILE_TOO_LARGE]: `1ファイル${Math.floor(limits.maxFileBytes / 1024 / 1024)}MBの上限を超えています。`,
    [UploadRejectReason.TOO_MANY_FILES]: `一度に追加できる${limits.maxFiles}件の上限を超えています。`,
    [UploadRejectReason.TOTAL_TOO_LARGE]: `合計${Math.floor(limits.maxTotalBytes / 1024 / 1024)}MBの上限を超えています。`,
    [UploadRejectReason.PATH_TOO_DEEP]: `フォルダ階層${limits.maxFolderDepth}段の上限を超えています。`,
    [UploadRejectReason.INVALID_NAME]: '安全に扱えないファイル名です。',
  };

  return labels[reason] ?? '追加できないファイルです。';
}

/* 同名を上書きせず「名前 (1).ext」のような別名を返す。 */
export function chooseAvailableName(name, occupied, { maxCodePoints = KNOWLEDGE_UPLOAD_LIMITS.maxNameCodePoints } = {}) {
  const used = occupied instanceof Set ? occupied : new Set(occupied ?? []);
  const safe = sanitizePathSegment(name, { maxCodePoints });

  if (!used.has(safe)) {
    return safe;
  }

  const ext = extensionOf(safe);
  const base = ext ? safe.slice(0, -ext.length) : safe;

  for (let index = 1; index <= 9999; index += 1) {
    const suffix = ` (${index})`;
    const room = Math.max(1, maxCodePoints - Array.from(ext).length - Array.from(suffix).length);
    const candidate = `${truncateCodePoints(base, room)}${suffix}${ext}`;

    if (!used.has(candidate)) {
      return candidate;
    }
  }

  return '';
}
