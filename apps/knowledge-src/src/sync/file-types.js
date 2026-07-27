/*
 * MIMEタイプ・拡張子から「ナレッジ対象かどうか」と「解析方法」を決める。
 *
 * 初期版の対象:
 *   Googleドキュメント / PDF / DOCX / TXT / Markdown
 * 対象外（理由を画面に表示する）:
 *   Googleスプレッドシート / Googleスライド / 画像 / その他
 */

import { MIME, MARKDOWN_EXTENSIONS, TEXT_EXTENSIONS } from '../config.js';

export const ParseKind = Object.freeze({
  GDOC: 'gdoc',
  PDF: 'pdf',
  DOCX: 'docx',
  TEXT: 'text',
  MARKDOWN: 'markdown',
});

function extensionOf(name) {
  const value = String(name ?? '');
  const dot = value.lastIndexOf('.');
  return dot === -1 ? '' : value.slice(dot).toLowerCase();
}

/*
 * 解析方法を返す。対象外なら null と理由。
 * 戻り値: { kind, transport } | { kind: null, reason }
 *   transport: 'export'（Googleドキュメント）| 'download'（バイナリ取得）
 */
export function classifyFile(file) {
  const mimeType = String(file?.mimeType ?? '');
  const ext = extensionOf(file?.name);

  if (mimeType === MIME.GOOGLE_DOC) {
    return { kind: ParseKind.GDOC, transport: 'export' };
  }

  if (mimeType === MIME.GOOGLE_SHEET) {
    return { kind: null, reason: 'Googleスプレッドシートは現在の版では対象外です。' };
  }

  if (mimeType === MIME.GOOGLE_SLIDE) {
    return { kind: null, reason: 'Googleスライドは現在の版では対象外です。' };
  }

  if (mimeType.startsWith('application/vnd.google-apps.')) {
    return { kind: null, reason: 'このGoogle形式は現在の版では対象外です。' };
  }

  if (mimeType === MIME.PDF || ext === '.pdf') {
    return { kind: ParseKind.PDF, transport: 'download' };
  }

  if (mimeType === MIME.DOCX || ext === '.docx') {
    return { kind: ParseKind.DOCX, transport: 'download' };
  }

  if (mimeType === MIME.DOC || ext === '.doc') {
    return { kind: null, reason: '旧形式のWord（.doc）は対象外です。DOCXへ変換してください。' };
  }

  if (mimeType === MIME.MARKDOWN || MARKDOWN_EXTENSIONS.includes(ext)) {
    return { kind: ParseKind.MARKDOWN, transport: 'download' };
  }

  if (mimeType === MIME.TXT || TEXT_EXTENSIONS.includes(ext)) {
    return { kind: ParseKind.TEXT, transport: 'download' };
  }

  if (mimeType.startsWith('image/')) {
    return { kind: null, reason: '画像のOCRは現在の版では対象外です。' };
  }

  return { kind: null, reason: 'この形式には対応していません。' };
}

/* 一覧表示用の短い形式名。 */
export function formatLabel(file) {
  const mimeType = String(file?.mimeType ?? '');
  const ext = extensionOf(file?.name);

  const table = {
    [MIME.GOOGLE_DOC]: 'Googleドキュメント',
    [MIME.GOOGLE_SHEET]: 'Googleスプレッドシート',
    [MIME.GOOGLE_SLIDE]: 'Googleスライド',
    [MIME.PDF]: 'PDF',
    [MIME.DOCX]: 'DOCX',
    [MIME.DOC]: 'DOC',
    [MIME.MARKDOWN]: 'Markdown',
    [MIME.TXT]: 'テキスト',
  };

  if (table[mimeType]) {
    return table[mimeType];
  }

  if (MARKDOWN_EXTENSIONS.includes(ext)) {
    return 'Markdown';
  }

  if (ext !== '') {
    return ext.slice(1).toUpperCase();
  }

  return mimeType || '不明';
}

export function isKnowledgeTarget(file) {
  return classifyFile(file).kind !== null;
}
