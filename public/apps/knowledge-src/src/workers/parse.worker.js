/*
 * 解析ワーカー。
 *
 * ここで行うこと（すべてメインスレッド外）:
 *   - PDF のテキスト抽出（PDF.js）
 *   - DOCX のテキスト抽出（Mammoth.js）
 *   - TXT / Markdown のデコード（TextDecoder）
 *   - テキスト正規化
 *   - チャンク分割
 *   - 内容ハッシュの計算
 *
 * ネットワークアクセスは行わない。バイト列はメインスレッドから受け取る。
 * IndexedDB もここでは触らない（保存はメインスレッド側の責務）。
 */

import mammoth from 'mammoth/mammoth.browser.js';
/* URL文字列だけを取り込む（PDF.js本体はここでは読み込まない）。 */
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { serveWorker } from './worker-rpc.js';
import { normalizeText, normalizationStats } from '../text/normalize.js';
import { chunkText } from '../text/chunk.js';
import { sha256Hex } from '../text/hash.js';

/* Worker 内で AppError を import すると DOM 依存を巻き込むため、最小の型を持つ。 */
class WorkerError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail ?? null;
  }
}

/* ---------- PDF ---------- */

let pdfjsPromise = null;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist/build/pdf.mjs');

      /*
       * PDF.js は自前のWorkerを使う（＝Worker内Worker）。
       * Chrome は入れ子のWorkerに対応している。作れない環境では
       * PDF.js が同一スレッド実行へ自動でフォールバックする。
       */
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return pdfjs;
    })();
  }

  return pdfjsPromise;
}

async function extractPdf(buffer, { progress, assets } = {}) {
  const pdfjs = await getPdfjs();

  let doc;

  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      /*
       * 日本語PDFは定義済みCMap（90ms-RKSJ-H / UniJIS-UCS2-H など）を使う。
       * これを渡さないと CID → Unicode の対応が取れず、
       * テキスト抽出が空になるか文字化けする。
       * URL は同一オリジン（配信物の直下）。外部CDNは使わない。
       */
      cMapUrl: assets?.cMapUrl,
      cMapPacked: true,
      standardFontDataUrl: assets?.standardFontDataUrl,
      /* 画面へ描画しないためフォントの実体は登録しない。 */
      disableFontFace: true,
      /*
       * 補助アセットの取得は PDF.js 自身のWorkerに任せる（true）。
       *
       * false にすると「API側」で取得しようとするが、このコードは
       * すでに Worker の中で動いているため取得経路が成立せず、
       * CMap が読めないまま **日本語PDFの抽出結果が空になる**。
       * （英数字のみのPDFでは症状が出ないため気付きにくい。）
       * 取得先は同一オリジンの配信物のみで、外部CDNは使わない。
       */
      useWorkerFetch: true,
      /* 任意コード実行の面を残さない。 */
      isEvalSupported: false,
    }).promise;
  } catch (error) {
    if (error?.name === 'PasswordException') {
      throw new WorkerError('PDF_ENCRYPTED', error.name);
    }
    throw new WorkerError('PDF_PARSE_FAILED', error?.name ?? 'getDocument_failed');
  }

  const pages = [];

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      /* eslint-disable-next-line no-await-in-loop */
      const page = await doc.getPage(pageNumber);
      /* eslint-disable-next-line no-await-in-loop */
      const content = await page.getTextContent();

      let text = '';

      content.items.forEach((item) => {
        if (typeof item.str !== 'string') {
          return;
        }
        text += item.str;
        /* PDF.js は行末を hasEOL で示す。ここでのみ改行を足す。 */
        if (item.hasEOL) {
          text += '\n';
        }
      });

      pages.push(text);
      page.cleanup();

      progress?.({ phase: 'pdf', done: pageNumber, total: doc.numPages });
    }
  } catch (error) {
    throw new WorkerError('PDF_PARSE_FAILED', error?.name ?? 'page_failed');
  } finally {
    try {
      await doc.destroy();
    } catch {
      /* 破棄の失敗は無視する。 */
    }
  }

  /* ページ境界は段落境界として扱う。 */
  return { text: pages.join('\n\n'), pageCount: pages.length };
}

/* ---------- DOCX ---------- */

async function extractDocx(buffer) {
  try {
    /*
     * extractRawText を使う（convertToHtml は使わない）。
     * HTML を作らないため、文書由来のマークアップが画面へ入る経路が無い。
     */
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return { text: String(result?.value ?? ''), messages: (result?.messages ?? []).length };
  } catch (error) {
    throw new WorkerError('DOCX_PARSE_FAILED', error?.message?.slice(0, 200) ?? 'mammoth_failed');
  }
}

/* ---------- TXT / Markdown ---------- */

function extractPlainText(buffer) {
  const bytes = new Uint8Array(buffer);

  /* UTF-8 を基本とし、失敗した場合のみ Shift_JIS を試す（日本語の実運用対策）。 */
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    /* 続けて代替を試す。 */
  }

  try {
    return new TextDecoder('shift_jis').decode(bytes);
  } catch {
    /* 最後は置換文字つきUTF-8。ここで失敗することはほぼ無い。 */
  }

  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch (error) {
    throw new WorkerError('TEXT_DECODE_FAILED', error?.name ?? 'decode_failed');
  }
}

/* ---------- ハンドラ ---------- */

/*
 * payload:
 *   { fileId, fileName, kind, buffer?, text?, chunkOptions, updatedTime, driveUrl }
 * kind: 'pdf' | 'docx' | 'text' | 'markdown' | 'gdoc'
 */
async function handleParse(payload, { progress }) {
  const kind = payload?.kind;
  let raw = '';
  let extra = {};

  if (kind === 'pdf') {
    const result = await extractPdf(payload.buffer, { progress, assets: payload.pdfAssets });
    raw = result.text;
    extra = { pageCount: result.pageCount };
  } else if (kind === 'docx') {
    const result = await extractDocx(payload.buffer);
    raw = result.text;
    extra = { warnings: result.messages };
  } else if (kind === 'gdoc') {
    /* Googleドキュメントは Drive の export で既にプレーンテキスト。 */
    raw = String(payload.text ?? '');
  } else if (kind === 'text' || kind === 'markdown') {
    raw = typeof payload.text === 'string' ? payload.text : extractPlainText(payload.buffer);
  } else {
    throw new WorkerError('UNSUPPORTED_TYPE', String(kind));
  }

  progress?.({ phase: 'normalize' });

  const sourceType = kind === 'gdoc' ? 'text' : kind;
  const normalized = normalizeText(raw, { sourceType });

  if (normalized.trim() === '') {
    throw new WorkerError('EMPTY_TEXT', kind);
  }

  progress?.({ phase: 'chunk' });

  const chunks = chunkText(normalized, payload.chunkOptions ?? {});
  const contentHash = await sha256Hex(normalized);

  return {
    text: normalized,
    charCount: normalized.length,
    chunks,
    contentHash,
    stats: { ...normalizationStats(raw, normalized), ...extra, chunkCount: chunks.length },
  };
}

/* 保存済みテキストからチャンクだけ作り直す（チャンク設定を変えたとき用）。 */
async function handleRechunk(payload) {
  const text = String(payload?.text ?? '');

  if (text.trim() === '') {
    throw new WorkerError('EMPTY_TEXT', 'rechunk');
  }

  const chunks = chunkText(text, payload.chunkOptions ?? {});
  return { chunks, chunkCount: chunks.length };
}

serveWorker({
  parse: handleParse,
  rechunk: handleRechunk,
  ping: async () => ({ ok: true }),
});
