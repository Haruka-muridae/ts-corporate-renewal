/*
 * テスト用フィクスチャの生成。
 *
 * バイナリ（PDF / DOCX / Shift_JIS）をリポジトリへ置かず、毎回組み立てる。
 * 改行変換（core.autocrlf）でバイナリが壊れる事故を避けるため。
 *
 * 実行: npm run test:fixtures（各テストの前に自動実行される）
 * 出力先: tests/fixtures/generated/（Git管理外）
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'generated');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const write = (name, data) => writeFile(resolve(outDir, name), data);

/* ---------- Shift_JIS エンコーダ ---------- */

/*
 * Node には Shift_JIS のエンコーダが無い（デコーダはある）。
 * 2バイト表を総当たりでデコードして逆引き表を作る。外部依存を増やさないため。
 */
function buildSjisEncoder() {
  const decoder = new TextDecoder('shift_jis');
  const map = new Map();

  for (let hi = 0x81; hi <= 0xef; hi += 1) {
    for (let lo = 0x40; lo <= 0xfc; lo += 1) {
      if (lo === 0x7f) {
        continue;
      }
      const char = decoder.decode(new Uint8Array([hi, lo]));
      if (char.length === 1 && char !== '�' && !map.has(char)) {
        map.set(char, [hi, lo]);
      }
    }
  }

  return map;
}

const sjisMap = buildSjisEncoder();

function encodeSjis(text) {
  const bytes = [];

  for (const char of text) {
    const code = char.codePointAt(0);

    if (code < 0x80) {
      bytes.push(code);
      continue;
    }

    const pair = sjisMap.get(char);

    if (!pair) {
      throw new Error(`Shift_JIS へ変換できない文字: ${char}`);
    }

    bytes.push(pair[0], pair[1]);
  }

  return Buffer.from(bytes);
}

/* ---------- ZIP（無圧縮 STORE）---------- */

function crc32(buffer) {
  let crc = 0xffffffff;

  for (let i = 0; i < buffer.length; i += 1) {
    let c = (crc ^ buffer[i]) & 0xff;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    crc = (crc >>> 8) ^ c;
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const localBlock = Buffer.concat([local, name, data]);
    locals.push(localBlock);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    centrals.push(Buffer.concat([central, name]));
    offset += localBlock.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

function docx(paragraphs) {
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';

  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';

  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
    .join('');

  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body}</w:body></w:document>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: document },
  ]);
}

/* ---------- PDF ---------- */

/* xref のオフセットを実測して埋める、最小構成のPDFを組み立てる。 */
function buildPdf(objects) {
  let out = '%PDF-1.4\n';
  const offsets = [];

  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj${body}endobj\n`;
  });

  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  out += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;

  return Buffer.from(out, 'latin1');
}

/* 標準フォント（Helvetica）で英数字を書いた1ページのPDF。 */
function asciiPdf(lines) {
  const stream = lines
    .map((line, index) => `BT /F1 ${index === 0 ? 20 : 12} Tf 72 ${720 - index * 30} Td (${line}) Tj ET`)
    .join('\n');

  return buildPdf([
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>stream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]);
}

/*
 * Adobe-Japan1 の CIDフォント + 定義済みCMap（90ms-RKSJ-H）を使う日本語PDF。
 * CMap を読み込めない実装では、テキスト抽出が空になるか文字化けする。
 */
function japanesePdf(text) {
  const hex = encodeSjis(text).toString('hex').toUpperCase();
  const stream = `BT /F1 18 Tf 72 700 Td <${hex}> Tj ET`;

  return buildPdf([
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>stream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type0/BaseFont/MS-Mincho/Encoding/90ms-RKSJ-H/DescendantFonts[6 0 R]>>',
    '<</Type/Font/Subtype/CIDFontType0/BaseFont/MS-Mincho/CIDSystemInfo<</Registry(Adobe)/Ordering(Japan1)/Supplement 2>>/FontDescriptor 7 0 R/DW 1000>>',
    '<</Type/FontDescriptor/FontName/MS-Mincho/Flags 4/FontBBox[0 -137 1000 859]/ItalicAngle 0/Ascent 859/Descent -140/CapHeight 769/StemV 78>>',
  ]);
}

/* 複数ページ（ページ順の確認用）。 */
function multiPagePdf(pageTexts) {
  const objects = [];
  const pageIds = [];
  let next = 3;

  pageTexts.forEach(() => {
    pageIds.push(next);
    next += 2;
  });

  objects.push('<</Type/Catalog/Pages 2 0 R>>');
  objects.push(`<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${pageTexts.length}>>`);

  const fontId = next;

  pageTexts.forEach((text, index) => {
    const contentId = pageIds[index] + 1;
    objects.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentId} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`);
    const stream = `BT /F1 16 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(`<</Length ${stream.length}>>stream\n${stream}\nendstream`);
  });

  objects.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');

  return buildPdf(objects);
}

/* ---------- 生成 ---------- */

const files = {
  /* テキスト系 */
  'sample.txt': Buffer.from('社内ナレッジのテキストです。\nテスト用キーワードあいうえお を含みます。\n有給休暇は入社6か月後に10日付与されます。\n', 'utf8'),
  'sample.md': Buffer.from('# 就業規則\n\n本文です。テスト用キーワードかきくけこ を含みます。\n\n## 第2章 有給休暇\n\n申請は3営業日前までに行ってください。\n\n```js\nconst x = 1; // コードブロック\n```\n', 'utf8'),
  'sample-sjis.txt': encodeSjis('シフトJISのテキストです。\r\nテスト用キーワードはひふへほ を含みます。\r\n'),
  'sample-bom.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM付きUTF-8です。テスト用キーワードまみむめも を含みます。\n', 'utf8')]),
  'sample-crlf.txt': Buffer.from('1行目です。\r\n2行目です。\r\n\r\n段落2です。テスト用キーワードやゆよ を含みます。\r\n', 'utf8'),
  'sample-nul.txt': Buffer.concat([Buffer.from('制御文字を含みます。', 'utf8'), Buffer.from([0x00, 0x01, 0x07]), Buffer.from('テスト用キーワードらりるれろ。\n', 'utf8')]),
  'empty.txt': Buffer.from('   \n\n  \n', 'utf8'),
  'zero.txt': Buffer.alloc(0),
  'huge-line.txt': Buffer.from(`${'あ'.repeat(60000)}テスト用キーワードわをん${'い'.repeat(60000)}\n`, 'utf8'),
  'urls.md': Buffer.from('# 連絡先\n\n問い合わせは https://example.com/path?a=1&b=2 または support@example.co.jp まで。\n\n2026年1月23日 に 1,234,567 円 を計上。全角ＡＢＣ１２３ はそのまま。\n', 'utf8'),

  /* PDF */
  'sample.pdf': asciiPdf(['PDFKEYWORD-SASISUSESO', 'Expense report manual for testing.']),
  'japanese.pdf': japanesePdf('日本語テスト'),
  'multipage.pdf': multiPagePdf(['PAGE-ONE-ALPHA', 'PAGE-TWO-BRAVO', 'PAGE-THREE-CHARLIE']),
  'broken.pdf': Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'latin1'),
    Buffer.from(Array.from({ length: 512 }, (unused, i) => (i * 37) % 251)),
  ]),
  'zero.pdf': Buffer.alloc(0),

  /* DOCX */
  'sample.docx': docx([
    '社内規程テスト文書',
    'この文書は自動テスト用です。テスト用キーワードたちつてと を含みます。',
    '経費精算の手続きについて説明します。領収書は必ず添付してください。',
  ]),
  'empty.docx': docx(['']),
  'broken.docx': Buffer.from('PK これはZIPとして壊れています', 'utf8'),
};

for (const [name, data] of Object.entries(files)) {
  await write(name, data);
}

console.log(`[fixtures] ${Object.keys(files).length} ファイルを生成しました: tests/fixtures/generated/`);
