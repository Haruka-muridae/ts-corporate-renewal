/**
 * 法務文書（/legal/）の生成と公開。
 *
 * ==================================================================
 * 役割分担
 * ==================================================================
 *   スプレッドシート「TSAM AI 法務文書」… 編集画面（条文の正本）
 *   このファイル                          … 静的HTMLの生成
 *   GitHub（main）                        … 版管理（公開のたびに1コミット）
 *   GitHub Pages                          … 配信
 *
 * 配信は従来どおり静的HTMLのまま。閲覧のたびに Apps Script を叩かないため、
 * GAS が落ちても法務ページは見られる。可用性を落とさないための構成。
 * ==================================================================
 *
 * ------------------------------------------------------------------
 * セル編集は即時反映しない（重要）
 * ------------------------------------------------------------------
 * onEdit トリガーは意図的に置かない。書きかけの条文がそのまま
 * 本番へ出るのを防ぐため、公開は publishLegalDocs() の手動実行だけとする。
 * 見た目の確認は previewLegalDocs() で行う。
 * ------------------------------------------------------------------
 *
 * 書式規約とシート構成の正式仕様は docs/specs/legal-cms-spec-v1.md。
 */

/* ================================================================
 * シートの読み取り
 * ================================================================ */

/** doc_id から LEGAL_DOCS の定義を引く。 */
function findLegalDoc_(docId) {
  var id = trimStr_(docId);

  for (var i = 0; i < LEGAL_DOCS.length; i++) {
    if (LEGAL_DOCS[i].docId === id) {
      return LEGAL_DOCS[i];
    }
  }

  throw new Error('未知の法務文書です: ' + id);
}

/**
 * meta シートから1文書分のヘッダ情報を読む。
 * 行が無い場合は空の値を返す（生成は止めない）。
 */
function readLegalMeta_(docId) {
  var id = trimStr_(docId);
  var rows = readRows_(SHEETS.LEGAL_META);

  for (var i = 0; i < rows.length; i++) {
    if (trimStr_(rows[i][LEGAL_META_COL.DOC_ID - 1]) !== id) {
      continue;
    }

    return {
      docId: id,
      title: trimStr_(rows[i][LEGAL_META_COL.TITLE - 1]),
      subtitle: trimStr_(rows[i][LEGAL_META_COL.SUBTITLE - 1]),
      establishedDate: trimStr_(rows[i][LEGAL_META_COL.ESTABLISHED_DATE - 1]),
      revisedDate: trimStr_(rows[i][LEGAL_META_COL.REVISED_DATE - 1]),
      version: trimStr_(rows[i][LEGAL_META_COL.VERSION - 1]),
      rowNumber: i + 2
    };
  }

  return {
    docId: id,
    title: '',
    subtitle: '',
    establishedDate: '',
    revisedDate: '',
    version: '',
    rowNumber: 0
  };
}

/** 条単位の文書（terms / privacy）の本文ブロックを読む。 */
function readLegalBlocks_(doc) {
  var rows = readRows_(doc.sheet);
  var out = [];

  for (var i = 0; i < rows.length; i++) {
    var values = rows[i];
    var blockId = trimStr_(values[LEGAL_BLOCK_COL.BLOCK_ID - 1]);

    if (blockId === '' || !parseBool_(values[LEGAL_BLOCK_COL.ENABLED - 1])) {
      continue;
    }

    out.push({
      blockId: blockId,
      heading: trimStr_(values[LEGAL_BLOCK_COL.HEADING - 1]),
      body: trimStr_(values[LEGAL_BLOCK_COL.BODY - 1]),
      sortOrder: parseCount_(values[LEGAL_BLOCK_COL.SORT_ORDER - 1])
    });
  }

  out.sort(function (a, b) { return a.sortOrder - b.sortOrder; });

  return out;
}

/**
 * 表の行単位の文書（tokusho）を読む。
 * item_label が空の行は、表の前に置く前文として扱う。
 */
function readLegalTableRows_(doc) {
  var rows = readRows_(doc.sheet);
  var out = [];

  for (var i = 0; i < rows.length; i++) {
    var values = rows[i];
    var rowId = trimStr_(values[LEGAL_TOKUSHO_COL.ROW_ID - 1]);

    if (rowId === '' || !parseBool_(values[LEGAL_TOKUSHO_COL.ENABLED - 1])) {
      continue;
    }

    out.push({
      rowId: rowId,
      itemLabel: trimStr_(values[LEGAL_TOKUSHO_COL.ITEM_LABEL - 1]),
      itemValue: trimStr_(values[LEGAL_TOKUSHO_COL.ITEM_VALUE - 1]),
      sortOrder: parseCount_(values[LEGAL_TOKUSHO_COL.SORT_ORDER - 1])
    });
  }

  out.sort(function (a, b) { return a.sortOrder - b.sortOrder; });

  return out;
}

/* ================================================================
 * 書式規約のパース
 * ================================================================ */

/**
 * HTML として意味を持つ文字を無害化する。
 *
 * 条文はスプレッドシートから来る。編集者がタグを書いても、
 * それは文字として表示されるだけで、構造にも挙動にも影響しない。
 * 差し込み記法（{email} など）の展開は **この後** に行う。
 */
function escapeHtml_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 1行分をHTMLへ変換する。
 * エスケープ済みの文字列に対してだけ差し込み記法を展開するため、
 * 展開結果のタグが編集者の入力で壊されることはない。
 */
function renderLegalInline_(text) {
  var html = escapeHtml_(text);

  html = html.split('{email}').join(
    '<a href="mailto:' + LEGAL_CONTACT_EMAIL + '">' + LEGAL_CONTACT_EMAIL + '</a>'
  );

  for (var i = 0; i < LEGAL_LINKS.length; i++) {
    var link = LEGAL_LINKS[i];
    html = html.split(link.token).join(
      '<a href="' + link.href + '">' + link.label + '</a>'
    );
  }

  return html;
}

/**
 * 1行を箇条書きの項目として読めるか判定する。
 *
 * 戻り値: { ordered, indented, text } または null。
 *   ordered  … 「1. 」で始まる番号付き
 *   indented … 半角スペース2つ以上、または全角スペースで字下げされている
 */
function matchLegalListItem_(line) {
  var indentMatch = /^([ 　]*)([\s\S]*)$/.exec(line);
  var indent = indentMatch[1];
  var rest = indentMatch[2];
  var indented = indent.indexOf('　') !== -1 || indent.length >= 2;

  var ordered = /^([0-9]+)\.[ 　]+([\s\S]*)$/.exec(rest);

  if (ordered) {
    return { ordered: true, indented: indented, text: trimStr_(ordered[2]) };
  }

  var bullet = /^(?:-[ 　]+|・[ 　]*)([\s\S]*)$/.exec(rest);

  if (bullet) {
    return { ordered: false, indented: indented, text: trimStr_(bullet[1]) };
  }

  return null;
}

/**
 * 本文を段落・箇条書きの並びへ分解する。
 *
 * 規約:
 *   空行            … 段落／リストの区切り
 *   段落内の単一改行… <br>（住所や連絡先を積み上げて書くため）
 *   「- 」「・」    … 箇条書き（ul）
 *   「1. 」         … 番号付きリスト（ol）
 *   字下げ          … 1段だけの入れ子
 *
 * 入れ子を1段に限るのは、条文の階層がそれ以上深くならないため。
 * 深い階層が必要になったら、条を分けるほうが読みやすい。
 */
function parseLegalBody_(text) {
  var normalized = String(text === null || text === undefined ? '' : text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  var lines = normalized.split('\n');
  var nodes = [];
  var current = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    if (trimStr_(line) === '') {
      current = null;
      continue;
    }

    var item = matchLegalListItem_(line);

    if (!item) {
      if (!current || current.type !== 'paragraph') {
        current = { type: 'paragraph', lines: [] };
        nodes.push(current);
      }

      current.lines.push(trimStr_(line));
      continue;
    }

    var listType = item.ordered ? 'ol' : 'ul';

    /* 字下げされた項目は、直前の項目のぶら下がりにする。 */
    if (item.indented && current && current.type === 'list' && current.items.length > 0) {
      var parent = current.items[current.items.length - 1];

      if (!parent.children) {
        parent.children = { type: 'list', listType: listType, items: [] };
      }

      parent.children.items.push({ text: item.text, children: null });
      continue;
    }

    if (!current || current.type !== 'list' || current.listType !== listType) {
      current = { type: 'list', listType: listType, items: [] };
      nodes.push(current);
    }

    current.items.push({ text: item.text, children: null });
  }

  return nodes;
}

/* ================================================================
 * HTML の組み立て
 * ================================================================ */

/** 指定した深さの字下げ。生成物を人が読める形に保つ。 */
function legalIndent_(depth) {
  var out = '';

  for (var i = 0; i < depth; i++) {
    out += '  ';
  }

  return out;
}

function renderLegalList_(list, depth) {
  var pad = legalIndent_(depth);
  var out = [pad + '<' + list.listType + '>'];

  for (var i = 0; i < list.items.length; i++) {
    var item = list.items[i];
    var text = renderLegalInline_(item.text);

    if (!item.children || item.children.items.length === 0) {
      out.push(pad + '  <li>' + text + '</li>');
      continue;
    }

    out.push(pad + '  <li>');
    out.push(pad + '    ' + text);
    out.push(renderLegalList_(item.children, depth + 2));
    out.push(pad + '  </li>');
  }

  out.push(pad + '</' + list.listType + '>');

  return out.join('\n');
}

function renderLegalParagraph_(node, depth) {
  var pad = legalIndent_(depth);
  var out = [pad + '<p>'];

  for (var i = 0; i < node.lines.length; i++) {
    var isLast = i === node.lines.length - 1;
    out.push(pad + '  ' + renderLegalInline_(node.lines[i]) + (isLast ? '' : '<br>'));
  }

  out.push(pad + '</p>');

  return out.join('\n');
}

/** 本文（段落・リストの並び）をHTMLにする。 */
function renderLegalBody_(text, depth) {
  var nodes = parseLegalBody_(text);
  var out = [];

  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].type === 'paragraph') {
      out.push(renderLegalParagraph_(nodes[i], depth));
    } else {
      out.push(renderLegalList_(nodes[i], depth));
    }
  }

  return out.join('\n');
}

/**
 * 表のセルの中身。
 * 1段落だけなら <p> で包まず、そのまま流し込む（セル内の余白を作らない）。
 */
function renderLegalCell_(text, depth) {
  var nodes = parseLegalBody_(text);

  if (nodes.length === 1 && nodes[0].type === 'paragraph') {
    var lines = [];

    for (var i = 0; i < nodes[0].lines.length; i++) {
      lines.push(renderLegalInline_(nodes[0].lines[i]));
    }

    return { inline: lines.join('<br>') };
  }

  return { block: renderLegalBody_(text, depth) };
}

/** 制定・改定・版の1行。改定日が空なら制定日だけを出す。 */
function renderLegalStamp_(meta) {
  var parts = [];

  if (meta.establishedDate !== '') {
    parts.push(meta.establishedDate + ' 制定');
  }

  if (meta.revisedDate !== '') {
    parts.push(meta.revisedDate + ' 改定');
  }

  if (meta.version !== '') {
    parts.push('Version ' + meta.version);
  }

  return parts.join(' ／ ');
}

/** ページ下部の相互リンク。自分以外の2文書と、料金プランへ。 */
function renderLegalNavLinks_(docId) {
  var out = [];

  for (var i = 0; i < LEGAL_DOCS.length; i++) {
    var doc = LEGAL_DOCS[i];

    if (doc.docId === docId) {
      continue;
    }

    out.push('          <li><a href="../' + doc.docId + '/">' + doc.pageTitle + '</a></li>');
  }

  out.push('          <li><a href="../../pricing/">料金プランの選択へ</a></li>');

  return out.join('\n');
}

/** 本文部分（auth-legal__body の中身）を組み立てる。 */
function buildLegalBodyHtml_(doc) {
  var out = [];

  if (doc.kind === 'table') {
    var rows = readLegalTableRows_(doc);
    var tableRows = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];

      /* 項目名の無い行は、表の前に置く前文。 */
      if (row.itemLabel === '') {
        out.push(renderLegalBody_(row.itemValue, 4));
        continue;
      }

      var cell = renderLegalCell_(row.itemValue, 7);

      tableRows.push('            <tr>');
      tableRows.push('              <th scope="row">' + renderLegalInline_(row.itemLabel) + '</th>');

      if (cell.inline !== undefined) {
        tableRows.push('              <td>' + cell.inline + '</td>');
      } else {
        tableRows.push('              <td>');
        tableRows.push(cell.block);
        tableRows.push('              </td>');
      }

      tableRows.push('            </tr>');
    }

    if (tableRows.length > 0) {
      out.push([
        '        <table class="auth-legal__table">',
        '          <tbody>',
        tableRows.join('\n'),
        '          </tbody>',
        '        </table>'
      ].join('\n'));
    }

    return out.join('\n\n');
  }

  var blocks = readLegalBlocks_(doc);

  for (var j = 0; j < blocks.length; j++) {
    var block = blocks[j];
    var chunk = [];

    if (block.heading !== '') {
      chunk.push('        <h2>' + renderLegalInline_(block.heading) + '</h2>');
    }

    var body = renderLegalBody_(block.body, 4);

    if (body !== '') {
      chunk.push(body);
    }

    if (chunk.length > 0) {
      out.push(chunk.join('\n'));
    }
  }

  return out.join('\n\n');
}

/**
 * 1文書分の静的HTMLを組み立てる。
 *
 * テンプレートは既存の /legal/ の見た目をそのまま踏襲する。
 * CSS は auth/auth.css を共有し、このファイルではスタイルを持たない。
 */
function buildLegalHtml_(docId) {
  var doc = findLegalDoc_(docId);
  var meta = readLegalMeta_(docId);

  var title = meta.title !== '' ? meta.title : doc.pageTitle;
  var stamp = renderLegalStamp_(meta);

  var metaLines = [];

  if (meta.subtitle !== '') {
    metaLines.push('        ' + escapeHtml_(meta.subtitle) + (stamp === '' ? '' : '<br>'));
  }

  if (stamp !== '') {
    metaLines.push('        ' + escapeHtml_(stamp));
  }

  var lines = [
    '<!doctype html>',
    LEGAL_GENERATED_MARK,
    '<html lang="ja">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>' + escapeHtml_(doc.pageTitle) + ' | TSAM AI</title>',
    '  <meta name="description" content="' + escapeHtml_(doc.description) + '">',
    '',
    '  <meta name="referrer" content="strict-origin-when-cross-origin">',
    '  <meta name="color-scheme" content="light">',
    '',
    '  <link rel="icon" href="../../favicon.ico" sizes="any">',
    '  <link rel="icon" type="image/png" sizes="32x32" href="../../favicon-32x32.png">',
    '  <link rel="icon" type="image/png" sizes="16x16" href="../../favicon-16x16.png">',
    '  <link rel="apple-touch-icon" sizes="180x180" href="../../apple-touch-icon.png">',
    '',
    '  <link rel="preconnect" href="https://fonts.googleapis.com">',
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&amp;family=Noto+Sans+JP:wght@400;500;700&amp;display=swap" rel="stylesheet">',
    '  <link rel="stylesheet" href="../../css/style.css">',
    '  <link rel="stylesheet" href="../../auth/auth.css">',
    '</head>',
    '<body class="auth-page">',
    '  <a class="skip-link" href="#main-content">本文へスキップ</a>',
    '',
    '  <main id="main-content" class="auth-main" tabindex="-1">',
    '    <div class="auth-legal">',
    '      <div class="auth-brand">',
    '        <a class="auth-brand__link" href="../../index.html">',
    '          <span class="auth-brand__name" lang="en">TSAM AI</span>',
    '        </a>',
    '        <p class="auth-brand__owner">TSアセットマネジメント合同会社</p>',
    '      </div>',
    '',
    '      <h1 class="auth-card__title">' + escapeHtml_(title) + '</h1>'
  ];

  if (metaLines.length > 0) {
    lines.push('      <p class="auth-legal__meta">');
    lines.push(metaLines.join('\n'));
    lines.push('      </p>');
  }

  lines.push('');
  lines.push('      <div class="auth-legal__body">');
  lines.push(buildLegalBodyHtml_(doc));
  lines.push('      </div>');
  lines.push('');
  lines.push('      <div class="auth-links">');
  lines.push('        <ul class="auth-links__list">');
  lines.push(renderLegalNavLinks_(doc.docId));
  lines.push('        </ul>');
  lines.push('      </div>');
  lines.push('    </div>');
  lines.push('  </main>');
  lines.push('');
  lines.push('  <footer class="auth-footer">');
  lines.push('    <p><a href="../../index.html">TSアセットマネジメント合同会社</a></p>');
  lines.push('    <p><small>Copyright &copy; TS Asset Management LLC. All Rights Reserved.</small></p>');
  lines.push('  </footer>');
  lines.push('</body>');
  lines.push('</html>');

  return lines.join('\n') + '\n';
}

/* ================================================================
 * 初期データの移行
 * ================================================================ */

/** シートが空（ヘッダーだけ）かどうか。 */
function isLegalSheetEmpty_(sheetName) {
  return getSheet_(sheetName).getLastRow() < 2;
}

/**
 * 制定時点の3文書をシートへ投入する。
 *
 * **シートが空のときだけ** 入れる。運用開始後に実行しても、
 * 編集した条文を種データで上書きすることはない。
 *
 * @return {Object} シートごとの投入行数
 */
function importLegalDocsFromCurrent_() {
  var plan = [
    { sheet: SHEETS.LEGAL_META, rows: LEGAL_SEED_META },
    { sheet: SHEETS.LEGAL_TERMS, rows: LEGAL_SEED_TERMS },
    { sheet: SHEETS.LEGAL_PRIVACY, rows: LEGAL_SEED_PRIVACY },
    { sheet: SHEETS.LEGAL_TOKUSHO, rows: LEGAL_SEED_TOKUSHO }
  ];

  var result = {};

  for (var i = 0; i < plan.length; i++) {
    var target = plan[i];

    if (!isLegalSheetEmpty_(target.sheet)) {
      result[target.sheet] = 0;
      continue;
    }

    var sheet = getSheet_(target.sheet);

    for (var r = 0; r < target.rows.length; r++) {
      sheet.appendRow(target.rows[r]);
    }

    result[target.sheet] = target.rows.length;
  }

  return result;
}

/* ================================================================
 * GitHub への書き込み
 * ================================================================ */

function getGithubRepo_() {
  return trimStr_(getSetting_('GITHUB_REPO'));
}

function getGithubBranch_() {
  return trimStr_(getSetting_('GITHUB_BRANCH')) || 'main';
}

/**
 * GitHub API の共通ヘッダー。
 * トークンはここでしか触らない。ログにもシートにも出さない。
 */
function githubHeaders_(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tsam-ai-legal-publisher'
  };
}

function githubContentsUrl_(path) {
  return 'https://api.github.com/repos/' + getGithubRepo_() + '/contents/' + path;
}

/**
 * 既存ファイルを取得する。
 * 見つからなければ null（新規作成として扱う）。
 */
function githubGetFile_(token, path) {
  var url = githubContentsUrl_(path) + '?ref=' + encodeURIComponent(getGithubBranch_());

  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: githubHeaders_(token),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();

  if (code === 404) {
    return null;
  }

  if (code !== 200) {
    throw new Error('GitHub からの取得に失敗しました（' + code + '） path=' + path);
  }

  var body = JSON.parse(response.getContentText());

  return {
    sha: trimStr_(body.sha),
    /* API の base64 は改行入りで返るため、比較の前に詰める。 */
    contentBase64: String(body.content || '').replace(/\s/g, '')
  };
}

/**
 * ファイルを1つコミットする。
 *
 * @return {string} コミットのURL
 */
function githubPutFile_(token, path, contentBase64, sha, message) {
  var payload = {
    message: message,
    content: contentBase64,
    branch: getGithubBranch_()
  };

  if (sha) {
    payload.sha = sha;
  }

  var response = UrlFetchApp.fetch(githubContentsUrl_(path), {
    method: 'put',
    contentType: 'application/json',
    headers: githubHeaders_(token),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();

  if (code !== 200 && code !== 201) {
    throw new Error('GitHub への書き込みに失敗しました（' + code + '） path=' + path);
  }

  var body = JSON.parse(response.getContentText());

  return trimStr_(body.commit && body.commit.html_url);
}

/* ================================================================
 * 公開
 * ================================================================ */

/**
 * トークン未設定のときに出す案内。手順書の場所まで示す。
 *
 * 定数ではなく関数にしてあるのは、ファイルをまたぐ初期化順に
 * 依存させないため（PROP は Config.gs 側で定義されている）。
 */
function legalTokenGuide_() {
  return [
    'GitHub のトークンが未設定のため、公開を中止しました。',
    '',
    '設定手順:',
    '  1. GitHub で Fine-grained personal access token を作成する',
    '     - Repository access: 対象リポジトリのみ',
    '     - Permissions: Contents を Read and write のみ',
    '  2. Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」で',
    '     ' + PROP.GITHUB_TOKEN + ' として保存する',
    '',
    '詳細は docs/instructions/2026-07-31-github-token.md を参照してください。'
  ].join('\n');
}

/** 日付を「2026年7月31日」の形にする（日本時間）。 */
function formatJpDate_(timeMs) {
  var jst = new Date(timeMs + (9 * 60 * 60 * 1000));

  return jst.getUTCFullYear() + '年'
    + (jst.getUTCMonth() + 1) + '月'
    + jst.getUTCDate() + '日';
}

/** meta シートの改定日を書き換える。 */
function updateLegalRevisedDate_(meta, dateText) {
  if (meta.rowNumber <= 0) {
    return;
  }

  updateCell_(SHEETS.LEGAL_META, meta.rowNumber, LEGAL_META_COL.REVISED_DATE, dateText);
}

/**
 * 3文書のHTMLを生成し、変更のあったものだけを GitHub へコミットする。
 *
 * Apps Script のエディタから手動で実行する。
 * Contents API は1ファイル＝1コミットのため、2文書が同時に変わった回は
 * 同じメッセージのコミットが2件並ぶ。
 */
function publishLegalDocs() {
  var token = getProperty_(PROP.GITHUB_TOKEN);

  if (token === '') {
    var guide = legalTokenGuide_();
    Logger.log(guide);
    return guide;
  }

  if (getGithubRepo_() === '') {
    var repoGuide = '公開先リポジトリが未設定です。認証設定シートの GITHUB_REPO に owner/repo を入れてください。';
    Logger.log(repoGuide);
    return repoGuide;
  }

  /* ---- 1. 生成して、変更の有無を調べる ---- */
  var targets = [];

  for (var i = 0; i < LEGAL_DOCS.length; i++) {
    var doc = LEGAL_DOCS[i];
    var meta = readLegalMeta_(doc.docId);
    var html = buildLegalHtml_(doc.docId);
    var encoded = Utilities.base64Encode(html, Utilities.Charset.UTF_8);
    var existing = githubGetFile_(token, doc.path);

    targets.push({
      doc: doc,
      meta: meta,
      encoded: encoded,
      sha: existing ? existing.sha : '',
      changed: !existing || existing.contentBase64 !== encoded
    });
  }

  var changed = [];
  var skipped = [];

  for (var j = 0; j < targets.length; j++) {
    if (targets[j].changed) {
      changed.push(targets[j]);
    } else {
      skipped.push(targets[j]);
    }
  }

  var lines = [];
  var publishedAt = nowIso_();

  if (changed.length === 0) {
    lines.push('変更のある文書はありませんでした。コミットは行っていません。');
    lines.push('スキップ: ' + skipped.map(function (t) { return t.doc.docId; }).join(', '));

    var noChange = lines.join('\n');
    Logger.log(noChange);
    return noChange;
  }

  /* ---- 2. コミットメッセージ（この回の全文書で共通） ---- */
  var docIds = changed.map(function (t) { return t.doc.docId; });
  var versions = [];

  for (var v = 0; v < changed.length; v++) {
    var version = changed[v].meta.version || '0';

    if (versions.indexOf(version) === -1) {
      versions.push(version);
    }
  }

  var message = 'docs(legal): publish from spreadsheet ('
    + docIds.join(', ') + ' / v' + versions.join('+') + ' / ' + publishedAt + ')';

  /*
   * ---- 3. 改定日を先に確定させる ----
   *
   * 公開したあとで改定日を書くと、載っている日付と実際の公開日がずれる。
   * それだけでなく、次回の比較で必ず差分が出て、条文を直していなくても
   * コミットが積み上がる。生成し直してから送ること。
   *
   * 新規作成は「制定」であって「改定」ではないため、日付は入れない。
   */
  var today = formatJpDate_(nowMs_());
  var revised = [];

  for (var r = 0; r < changed.length; r++) {
    var entry2 = changed[r];

    if (entry2.sha === '') {
      continue;
    }

    updateLegalRevisedDate_(entry2.meta, today);

    entry2.meta = readLegalMeta_(entry2.doc.docId);
    entry2.encoded = Utilities.base64Encode(
      buildLegalHtml_(entry2.doc.docId), Utilities.Charset.UTF_8
    );

    revised.push(entry2.doc.docId);
  }

  /* ---- 4. コミット ---- */
  var commitUrls = [];

  for (var k = 0; k < changed.length; k++) {
    var target = changed[k];
    var url = githubPutFile_(token, target.doc.path, target.encoded, target.sha, message);

    commitUrls.push(target.doc.docId + ': ' + (url || '(URL不明)'));
  }

  /* ---- 5. 版が上がった場合の警告 ---- */
  var warnings = [];

  for (var m = 0; m < changed.length; m++) {
    var entry = changed[m];
    var propertyKey = PROP.LEGAL_PUBLISHED_VERSION_PREFIX + entry.doc.docId;
    var previous = getProperty_(propertyKey);
    var now = entry.meta.version;

    if (previous !== '' && previous !== now) {
      warnings.push('【警告】' + entry.doc.docId + ' の版が ' + previous + ' → ' + now
        + ' に上がりました。認証設定シートの TOS_VERSION も更新が必要です（現在: '
        + getTosVersion_() + '）。');
    }

    setProperty_(propertyKey, now);
  }

  /* ---- 6. 実行ログ ---- */
  lines.push('公開しました。');
  lines.push('');
  lines.push('変更: ' + docIds.join(', '));
  lines.push('スキップ: ' + (skipped.length === 0
    ? 'なし'
    : skipped.map(function (t) { return t.doc.docId; }).join(', ')));
  lines.push('');
  lines.push('コミット:');

  for (var c = 0; c < commitUrls.length; c++) {
    lines.push('  ' + commitUrls[c]);
  }

  lines.push('');
  lines.push('メッセージ: ' + message);
  lines.push(revised.length === 0
    ? '改定日は更新していません（新規作成のため）。'
    : '改定日を ' + today + ' に更新しました: ' + revised.join(', '));

  if (warnings.length > 0) {
    lines.push('');

    for (var w = 0; w < warnings.length; w++) {
      lines.push(warnings[w]);
    }
  }

  lines.push('');
  lines.push('GitHub Pages への反映まで1〜2分かかります。');

  var text = lines.join('\n');
  Logger.log(text);
  logAdminAction_('legal', 'publish', docIds.join(','), 'v' + versions.join('+'));

  return text;
}

/* ================================================================
 * プレビュー
 * ================================================================ */

/** プレビュー置き場（TSAM AI/Auth/preview/）を用意する。 */
function ensurePreviewFolder_() {
  var authFolderId = getProperty_(PROP.AUTH_FOLDER_ID);

  if (authFolderId === '') {
    throw new Error('Auth フォルダが未設定です。setupAuthSystem() を実行してください。');
  }

  return ensureFolder_(DriveApp.getFolderById(authFolderId), DRIVE.PREVIEW_FOLDER_NAME);
}

/** 同名のファイルがあれば中身を差し替え、無ければ作る。 */
function writePreviewFile_(folder, name, content) {
  var iterator = folder.getFilesByName(name);

  if (iterator.hasNext()) {
    var file = iterator.next();
    file.setContent(content);
    return file;
  }

  return folder.createFile(name, content, MimeType.HTML);
}

/**
 * 公開せずに、生成HTMLを Drive へ書き出す。
 *
 * 条文を直したあと、publishLegalDocs() の前にここで見た目を確かめる。
 * GitHub には一切触らない。
 */
function previewLegalDocs() {
  var folder = ensurePreviewFolder_();
  var lines = ['プレビューを書き出しました（公開はしていません）。', ''];

  for (var i = 0; i < LEGAL_DOCS.length; i++) {
    var doc = LEGAL_DOCS[i];
    var html = buildLegalHtml_(doc.docId);
    var file = writePreviewFile_(folder, 'legal-preview-' + doc.docId + '.html', html);

    lines.push('  ' + doc.docId + ': ' + file.getUrl());
  }

  lines.push('');
  lines.push('公開するには publishLegalDocs() を実行してください。');

  var text = lines.join('\n');
  Logger.log(text);

  return text;
}
