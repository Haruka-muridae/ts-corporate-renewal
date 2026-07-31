/*
 * 法務文書のスプレッドシート管理（Legal CMS）。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 書式規約が仕様どおりに解釈されること（段落・箇条書き・差し込み）
 *   - セルにHTMLタグを書いても、タグとして出力されないこと
 *   - シートから生成したHTMLが、現在公開中の内容と一致すること
 *   - 変更のない文書は GitHub へ書きに行かないこと
 *   - トークン未設定なら1バイトも送信せずに中断すること
 *   - トークンがログ・シートへ出ないこと
 *   - セットアップを2回実行しても条文が重複しないこと
 * ==================================================================
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';
import { createReadyEnvironment, setSetting, REPO_ROOT } from '../helpers/gas-harness.mjs';

const DOC_IDS = ['terms', 'privacy', 'tokusho'];
const TOKEN = 'github_pat_TEST_do_not_use_0000000000';

/* タグ構造の違いは許容し、文字として読める内容だけを取り出す。 */
function textOf(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&copy;/g, '(c)')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function readPublished(docId) {
  return readFileSync(
    resolve(REPO_ROOT, 'tests/fixtures/legal-published', `${docId}.html`),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

function readRepoPage(docId) {
  return readFileSync(
    resolve(REPO_ROOT, 'public', 'legal', docId, 'index.html'),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

try {
  const env = createReadyEnvironment();
  const gas = env.api;

  /* ---------------------------------------------------------------- */
  section('セットアップで作られるスプレッドシート');

  check(
    '法務文書スプレッドシートのIDが保存される',
    typeof env.properties.AUTH_LEGAL_SPREADSHEET_ID === 'string'
      && env.properties.AUTH_LEGAL_SPREADSHEET_ID !== '',
  );

  check(
    '認証設定とは別ファイルになっている',
    env.properties.AUTH_LEGAL_SPREADSHEET_ID !== env.properties.AUTH_CONFIG_SPREADSHEET_ID,
  );

  check(
    'ファイル名が「TSAM AI 法務文書」',
    gas.getLegalSpreadsheet_().getName() === 'TSAM AI 法務文書',
  );

  for (const name of ['meta', 'terms', 'privacy', 'tokusho']) {
    check(`${name} シートができる`, gas.getLegalSpreadsheet_().getSheetByName(name) !== null);
  }

  check(
    'meta のヘッダーが仕様どおり',
    JSON.stringify(gas.HEADERS.meta) === JSON.stringify(
      ['doc_id', 'title', 'subtitle', 'established_date', 'revised_date', 'version'],
    ),
  );

  check(
    'terms / privacy のヘッダーが仕様どおり（条単位）',
    JSON.stringify(gas.HEADERS.terms) === JSON.stringify(
      ['block_id', 'heading', 'body', 'sort_order', 'enabled'],
    )
      && JSON.stringify(gas.HEADERS.privacy) === JSON.stringify(gas.HEADERS.terms),
  );

  check(
    'tokusho のヘッダーが仕様どおり（表の行単位）',
    JSON.stringify(gas.HEADERS.tokusho) === JSON.stringify(
      ['row_id', 'item_label', 'item_value', 'sort_order', 'enabled'],
    ),
  );

  check(
    '法務シートは法務スプレッドシートへ振り分けられる',
    gas.spreadsheetForSheet_('terms').getId() === gas.getLegalSpreadsheet_().getId(),
  );

  check(
    '認証設定のシートは従来どおり認証設定スプレッドシートのまま',
    gas.spreadsheetForSheet_('plans').getId() === gas.getConfigSpreadsheet_().getId(),
  );

  /* ---------------------------------------------------------------- */
  section('初期データの移行');

  const metaRows = gas.readRows_('meta');

  check('meta に3文書ぶんの行が入る', metaRows.length === 3, metaRows.length);

  check(
    'meta の doc_id が terms / privacy / tokusho',
    JSON.stringify(metaRows.map((r) => r[0])) === JSON.stringify(DOC_IDS),
  );

  const termsRows = gas.readRows_('terms');
  const privacyRows = gas.readRows_('privacy');
  const tokushoRows = gas.readRows_('tokusho');

  check('terms は前文＋23条の24行', termsRows.length === 24, termsRows.length);
  check('privacy は前文＋16節の17行', privacyRows.length === 17, privacyRows.length);
  check('tokusho は前文＋25項目の26行', tokushoRows.length === 26, tokushoRows.length);

  check(
    'block_id が重複していない',
    new Set(termsRows.map((r) => r[0])).size === termsRows.length,
  );

  check(
    'sort_order が1から連番で入る',
    termsRows.every((row, i) => Number(row[3]) === i + 1),
  );

  check('初期行はすべて enabled', termsRows.every((row) => row[4] === 'TRUE'));

  /* もう一度セットアップしても増えない（冪等）。 */
  gas.setupAuthSystem();

  check(
    'setupAuthSystem() を2回実行しても条文が重複しない',
    gas.readRows_('terms').length === 24 && gas.readRows_('meta').length === 3,
    gas.readRows_('terms').length,
  );

  /* 運用側の編集を、あとからのセットアップが消さないこと。 */
  const termsSheet = gas.getLegalSpreadsheet_().getSheetByName('terms');
  const originalHeading = termsSheet.rows[2][1];
  termsSheet.rows[2][1] = '第1条（定義・改）';
  gas.setupAuthSystem();

  check(
    '編集済みの条文をセットアップが上書きしない',
    gas.getLegalSpreadsheet_().getSheetByName('terms').rows[2][1] === '第1条（定義・改）',
  );

  termsSheet.rows[2][1] = originalHeading;

  check(
    'importLegalDocsFromCurrent_() は行がある間は0件を返す',
    gas.importLegalDocsFromCurrent_().terms === 0,
  );

  /* ---------------------------------------------------------------- */
  section('書式規約：段落と改行');

  check(
    '空行で段落が分かれる',
    gas.renderLegalBody_('一つ目。\n\n二つ目。', 0)
      === '<p>\n  一つ目。\n</p>\n<p>\n  二つ目。\n</p>',
    JSON.stringify(gas.renderLegalBody_('一つ目。\n\n二つ目。', 0)),
  );

  check(
    '段落内の単一改行は <br> になる',
    gas.renderLegalBody_('住所：東京\n電話：000', 0)
      === '<p>\n  住所：東京<br>\n  電話：000\n</p>',
    JSON.stringify(gas.renderLegalBody_('住所：東京\n電話：000', 0)),
  );

  check(
    '最終行のうしろに <br> を付けない',
    !gas.renderLegalBody_('あ\nい', 0).includes('い<br>'),
  );

  check(
    '空行が続いても空の段落を作らない',
    gas.renderLegalBody_('あ\n\n\n\nい', 0) === '<p>\n  あ\n</p>\n<p>\n  い\n</p>',
  );

  check('空文字は何も出さない', gas.renderLegalBody_('', 0) === '');

  check(
    '前後の空白だけの行は無視される',
    gas.renderLegalBody_('  \nあ\n \t \nい', 0).split('<p>').length - 1 === 2,
  );

  /* ---------------------------------------------------------------- */
  section('書式規約：箇条書き');

  check(
    '「- 」で ul になる',
    gas.renderLegalBody_('- 一つ目\n- 二つ目', 0)
      === '<ul>\n  <li>一つ目</li>\n  <li>二つ目</li>\n</ul>',
    JSON.stringify(gas.renderLegalBody_('- 一つ目\n- 二つ目', 0)),
  );

  check(
    '「・」でも ul になる',
    gas.renderLegalBody_('・一つ目\n・二つ目', 0)
      === '<ul>\n  <li>一つ目</li>\n  <li>二つ目</li>\n</ul>',
  );

  check(
    '「1. 」で ol になる',
    gas.renderLegalBody_('1. 一つ目\n2. 二つ目', 0)
      === '<ol>\n  <li>一つ目</li>\n  <li>二つ目</li>\n</ol>',
    JSON.stringify(gas.renderLegalBody_('1. 一つ目\n2. 二つ目', 0)),
  );

  check(
    '番号は書いてある値ではなく ol の並びで振り直される',
    gas.renderLegalBody_('3. あ\n7. い', 0) === '<ol>\n  <li>あ</li>\n  <li>い</li>\n</ol>',
  );

  check(
    'ul と ol が混ざったら別のリストに分かれる',
    gas.renderLegalBody_('- あ\n1. い', 0)
      === '<ul>\n  <li>あ</li>\n</ul>\n<ol>\n  <li>い</li>\n</ol>',
  );

  check(
    '空行でリストが終わる',
    gas.renderLegalBody_('1. あ\n\n1. い', 0)
      === '<ol>\n  <li>あ</li>\n</ol>\n<ol>\n  <li>い</li>\n</ol>',
  );

  check(
    '段落のあとにリストを置ける',
    gas.renderLegalBody_('次のとおり。\n\n- あ', 0)
      === '<p>\n  次のとおり。\n</p>\n<ul>\n  <li>あ</li>\n</ul>',
  );

  check(
    '「1年間」のように数字で始まる本文はリストにしない',
    gas.renderLegalBody_('1年間継続した場合の目安。', 0) === '<p>\n  1年間継続した場合の目安。\n</p>',
  );

  check(
    '「令和1.5」のように途中に数字があってもリストにしない',
    !gas.renderLegalBody_('価格は1.5倍になる。', 0).includes('<ol>'),
  );

  /* ---------------------------------------------------------------- */
  section('書式規約：入れ子');

  check(
    '半角スペース2つで1段ぶら下がる',
    gas.renderLegalBody_('1. 親\n  1. 子', 0)
      === '<ol>\n  <li>\n    親\n    <ol>\n      <li>子</li>\n    </ol>\n  </li>\n</ol>',
    JSON.stringify(gas.renderLegalBody_('1. 親\n  1. 子', 0)),
  );

  check(
    '全角スペースでも1段ぶら下がる',
    gas.renderLegalBody_('1. 親\n　1. 子', 0) === gas.renderLegalBody_('1. 親\n  1. 子', 0),
  );

  check(
    'ぶら下がりは1段まで（2段目も同じ段に並ぶ）',
    (gas.renderLegalBody_('1. 親\n  1. 子\n    1. 孫', 0).match(/<ol>/g) || []).length === 2,
  );

  check(
    '親のいない字下げは通常の項目として扱う',
    gas.renderLegalBody_('  1. 親なし', 0) === '<ol>\n  <li>親なし</li>\n</ol>',
  );

  check(
    '字下げは半角1つでは効かない',
    gas.renderLegalBody_('1. 親\n 1. 子', 0) === '<ol>\n  <li>親</li>\n  <li>子</li>\n</ol>',
  );

  /* ---------------------------------------------------------------- */
  section('書式規約：差し込み記法');

  check(
    '{email} が mailto リンクになる',
    gas.renderLegalInline_('連絡先は{email}です。')
      === '連絡先は<a href="mailto:architect@potenitas.com">architect@potenitas.com</a>です。',
    gas.renderLegalInline_('連絡先は{email}です。'),
  );

  check(
    '{terms} が利用規約へのリンクになる',
    gas.renderLegalInline_('{terms}') === '<a href="../terms/">利用規約</a>',
  );

  check(
    '{privacy} がプライバシーポリシーへのリンクになる',
    gas.renderLegalInline_('{privacy}') === '<a href="../privacy/">プライバシーポリシー</a>',
  );

  check(
    '{tokusho} が特商法表記へのリンクになる',
    gas.renderLegalInline_('{tokusho}') === '<a href="../tokusho/">特定商取引法に基づく表記</a>',
  );

  check(
    '同じ記法が1行に何度出ても全部展開される',
    (gas.renderLegalInline_('{terms}と{terms}').match(/<a /g) || []).length === 2,
  );

  check(
    'リンクは相対パスで、ドメインを持たない',
    !gas.renderLegalInline_('{terms}{privacy}{tokusho}{email}').includes('http'),
  );

  check(
    '知らない記法はそのまま文字として残る',
    gas.renderLegalInline_('{unknown}') === '{unknown}',
  );

  /* ---------------------------------------------------------------- */
  section('書式規約：HTMLタグの直接記述を許さない');

  check(
    '<script> はタグにならない',
    gas.renderLegalInline_('<script>alert(1)</script>')
      === '&lt;script&gt;alert(1)&lt;/script&gt;',
    gas.renderLegalInline_('<script>alert(1)</script>'),
  );

  check(
    '<a href> を書いてもリンクにならない',
    !gas.renderLegalInline_('<a href="https://evil.example">x</a>').includes('<a '),
  );

  check('& がそのまま出ない', gas.renderLegalInline_('A & B') === 'A &amp; B');

  check(
    '属性を抜け出すための引用符もエスケープされる',
    gas.renderLegalInline_('" onload="x') === '&quot; onload=&quot;x',
  );

  check(
    'エスケープしてから記法を展開するので、記法の出力は壊れない',
    gas.renderLegalInline_('<b>{terms}</b>')
      === '&lt;b&gt;<a href="../terms/">利用規約</a>&lt;/b&gt;',
  );

  check(
    '本文経由でもタグにならない',
    gas.renderLegalBody_('- <img src=x onerror=alert(1)>', 0)
      === '<ul>\n  <li>&lt;img src=x onerror=alert(1)&gt;</li>\n</ul>',
  );

  /* ---------------------------------------------------------------- */
  section('生成HTMLの骨格');

  const generated = {};

  for (const docId of DOC_IDS) {
    generated[docId] = gas.buildLegalHtml_(docId);
  }

  for (const docId of DOC_IDS) {
    check(
      `${docId}: GENERATED FILE の注記が冒頭にある`,
      generated[docId].split('\n').slice(0, 3).join('\n').includes('GENERATED FILE'),
    );

    check(
      `${docId}: 直接編集禁止と書いてある`,
      generated[docId].includes('直接編集禁止(次回公開で上書きされます)'),
    );

    check(
      `${docId}: 編集元がスプレッドシート名で示されている`,
      generated[docId].includes('TSAM AI 法務文書'),
    );

    check(`${docId}: doctype で始まる`, generated[docId].startsWith('<!doctype html>\n'));

    check(
      `${docId}: 共有CSSを相対パスで読む`,
      generated[docId].includes('href="../../auth/auth.css"')
        && generated[docId].includes('href="../../css/style.css"'),
    );

    check(
      `${docId}: 絶対URLでサイト内リンクを書かない`,
      !/href="https:\/\/[^"]*tsam/i.test(generated[docId]),
    );

    check(
      `${docId}: 料金プランへの導線がある`,
      generated[docId].includes('href="../../pricing/"'),
    );

    check(
      `${docId}: 自分自身へのナビリンクを出さない`,
      !generated[docId].includes(`<li><a href="../${docId}/">`),
    );

    check(
      `${docId}: 他の2文書へのナビリンクがある`,
      DOC_IDS.filter((id) => id !== docId)
        .every((id) => generated[docId].includes(`<li><a href="../${id}/">`)),
    );

    check(
      `${docId}: 草案の痕跡（DRAFT・法務確認コメント・要確認）が無い`,
      !/DRAFT|法務確認コメント|要確認|公開前/.test(generated[docId]),
    );
  }

  check(
    '特商法ページに表が出る',
    generated.tokusho.includes('<table class="auth-legal__table">'),
  );

  check(
    '特商法ページに登録番号が載る',
    generated.tokusho.includes('T3021003007473'),
  );

  check(
    '利用規約に表は出ない（条単位のため）',
    !generated.terms.includes('<table'),
  );

  check(
    '制定日と版が meta から出る',
    generated.terms.includes('2026年7月30日 制定 ／ Version 1.0'),
  );

  /* ---------------------------------------------------------------- */
  section('現行の公開内容と一致すること');

  for (const docId of DOC_IDS) {
    const before = textOf(readPublished(docId));
    const after = textOf(generated[docId]);

    check(`${docId}: 読める内容が公開中のものと完全に一致する`, before === after);
  }

  for (const docId of DOC_IDS) {
    check(
      `${docId}: リポジトリの legal/${docId}/index.html が生成物と一致する`,
      readRepoPage(docId) === generated[docId],
    );
  }

  check(
    '氏名の表記ゆれが持ち込まれていない（特商法＝齋藤悠貴）',
    generated.tokusho.includes('齋藤悠貴') && !generated.tokusho.includes('齋藤栄貴'),
  );

  check(
    'プライバシーポリシーの代表者は齋藤貴之のまま（別人）',
    generated.privacy.includes('齋藤貴之') && !generated.privacy.includes('齋藤悠貴'),
  );

  /* ---------------------------------------------------------------- */
  section('meta の改定日と版');

  const metaSheet = gas.getLegalSpreadsheet_().getSheetByName('meta');

  metaSheet.rows[1][4] = '2026年8月20日';

  check(
    '改定日を入れると「制定 ／ 改定 ／ Version」の順で出る',
    gas.buildLegalHtml_('terms').includes('2026年7月30日 制定 ／ 2026年8月20日 改定 ／ Version 1.0'),
  );

  metaSheet.rows[1][4] = '';

  check(
    '改定日が空なら「改定」を出さない',
    !gas.buildLegalHtml_('terms').includes('改定'),
  );

  check(
    'enabled=FALSE の条文は出力されない',
    (() => {
      const sheet = gas.getLegalSpreadsheet_().getSheetByName('terms');
      const keep = sheet.rows[2][4];
      sheet.rows[2][4] = 'FALSE';
      const html = gas.buildLegalHtml_('terms');
      sheet.rows[2][4] = keep;
      return !html.includes('第1条（定義）');
    })(),
  );

  check(
    'sort_order で並び替わる',
    (() => {
      const sheet = gas.getLegalSpreadsheet_().getSheetByName('terms');
      const keep = sheet.rows[2][3];
      sheet.rows[2][3] = 999;
      const html = gas.buildLegalHtml_('terms');
      sheet.rows[2][3] = keep;
      return html.indexOf('第1条（定義）') > html.indexOf('第23条');
    })(),
  );

  check(
    '未知の doc_id を渡すと例外になる',
    (() => {
      try {
        gas.buildLegalHtml_('unknown');
        return false;
      } catch (error) {
        return String(error.message).includes('unknown');
      }
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('GitHub トークンが未設定のとき');

  const beforeCalls = env.fetchCalls.length;
  const guide = gas.publishLegalDocs();

  check('公開が中止される', guide.includes('公開を中止しました'));
  check('Fine-grained token の作成手順を案内する', guide.includes('Fine-grained personal access token'));
  check('Contents は Read and write のみと案内する', guide.includes('Contents を Read and write のみ'));
  check('保存先が Script Properties だと案内する', guide.includes('GITHUB_TOKEN'));
  check('手順書の場所を示す', guide.includes('docs/instructions/2026-07-31-github-token.md'));

  check(
    'GitHub へ1回も通信しない',
    env.fetchCalls.length === beforeCalls,
    env.fetchCalls.length - beforeCalls,
  );

  check(
    'トークンは設定シートからは読めない（SECRET_KEYS で遮断）',
    (() => {
      setSetting(env, 'GITHUB_TOKEN', 'leaked-from-sheet');
      return gas.getSetting_('GITHUB_TOKEN') === '';
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('GitHub への公開');

  env.properties.GITHUB_TOKEN = TOKEN;

  /* 偽のリポジトリ。パスごとに中身と sha を持つ。 */
  const repo = new Map();
  const puts = [];

  function installGithub() {
    env.clearFetchHandlers();

    env.onFetch((url, options) => {
      if (!url.startsWith('https://api.github.com/repos/')) {
        return null;
      }

      const path = url.replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\//, '')
        .split('?')[0];

      if ((options.method || 'get') === 'get') {
        if (!repo.has(path)) {
          return { status: 404, body: { message: 'Not Found' } };
        }

        const entry = repo.get(path);

        return {
          status: 200,
          body: {
            sha: entry.sha,
            /* 本物の API は60文字ごとに改行を入れて返す。 */
            content: entry.content.replace(/(.{60})/g, '$1\n'),
          },
        };
      }

      const payload = JSON.parse(options.payload);
      puts.push({ path, payload, options });

      repo.set(path, { sha: `sha-${puts.length}`, content: payload.content });

      return {
        status: repo.has(path) ? 200 : 201,
        body: { commit: { html_url: `https://github.com/example/repo/commit/c${puts.length}` } },
      };
    });
  }

  installGithub();

  const first = gas.publishLegalDocs();

  check('3文書とも新規作成される', puts.length === 3, puts.length);

  check(
    '公開先は legal/<doc_id>/index.html',
    JSON.stringify(puts.map((p) => p.path)) === JSON.stringify(
      DOC_IDS.map((id) => `legal/${id}/index.html`),
    ),
  );

  check(
    '新規作成では sha を送らない',
    puts.every((p) => p.payload.sha === undefined),
  );

  check('コミット先ブランチは main', puts.every((p) => p.payload.branch === 'main'));

  check(
    'コミットメッセージが規定の形',
    /^docs\(legal\): publish from spreadsheet \(terms, privacy, tokusho \/ v1\.0 \/ \d{4}-\d{2}-\d{2}T/
      .test(puts[0].payload.message),
    puts[0].payload.message,
  );

  check(
    '同じ公開回のコミットメッセージは全文書で同じ',
    new Set(puts.map((p) => p.payload.message)).size === 1,
  );

  check(
    '送信内容は base64 で、復号すると生成HTMLと一致する',
    Buffer.from(puts[0].payload.content, 'base64').toString('utf8') === gas.buildLegalHtml_('terms'),
    Buffer.from(puts[0].payload.content, 'base64').toString('utf8').slice(0, 80),
  );

  check(
    '日本語がUTF-8のまま往復する',
    Buffer.from(puts[2].payload.content, 'base64').toString('utf8').includes('特定商取引法に基づく表記'),
  );

  check('変更された文書がログに出る', first.includes('変更: terms, privacy, tokusho'));
  check('コミットURLがログに出る', first.includes('https://github.com/example/repo/commit/'));
  check('Pages 反映までの案内が出る', first.includes('GitHub Pages への反映まで1〜2分'));

  check(
    'Authorization ヘッダーで Bearer トークンを送る',
    puts[0].options.headers.Authorization === `Bearer ${TOKEN}`,
  );

  check(
    'トークンが実行ログに出ない',
    !env.logs.join('\n').includes(TOKEN),
  );

  check(
    'トークンが返り値に出ない',
    !first.includes(TOKEN),
  );

  check(
    'トークンがどのシートにも書かれていない',
    !['settings', 'plans', 'admin_action_logs'].some((name) => JSON.stringify(
      gas.readRows_(name),
    ).includes(TOKEN)),
  );

  check(
    '公開が管理操作ログに残る',
    gas.readRows_('admin_action_logs').some((row) => row[2] === 'publish'),
  );

  check(
    '新規作成では改定日を入れない（制定であって改定ではない）',
    gas.readRows_('meta').every((row) => String(row[4]).trim() === ''),
    JSON.stringify(gas.readRows_('meta').map((r) => r[4])),
  );

  check('新規作成だとログに明記する', first.includes('改定日は更新していません（新規作成のため）'));

  /* ---------------------------------------------------------------- */
  section('変更のない文書はスキップする');

  puts.length = 0;

  const second = gas.publishLegalDocs();

  check('1件も書き込まない', puts.length === 0, puts.length);
  check('変更なしと報告する', second.includes('変更のある文書はありませんでした'));
  check('スキップした文書を挙げる', second.includes('terms, privacy, tokusho'));

  /* 1文書だけ変える。 */
  const tokushoSheet = gas.getLegalSpreadsheet_().getSheetByName('tokusho');
  tokushoSheet.rows[3][2] = '齋藤悠貴（改）';

  const third = gas.publishLegalDocs();

  check('変わった1文書だけを書き込む', puts.length === 1, puts.length);
  check('書き込み先は特商法ページ', puts[0].path === 'legal/tokusho/index.html');
  check('更新では既存の sha を送る', typeof puts[0].payload.sha === 'string' && puts[0].payload.sha !== '');
  check('スキップした2文書がログに出る', third.includes('スキップ: terms, privacy'));

  check(
    'コミットメッセージには変わった文書だけが載る',
    puts[0].payload.message.includes('(tokusho /') && !puts[0].payload.message.includes('terms'),
    puts[0].payload.message,
  );

  check(
    '書き換えた文書の改定日が公開日になる',
    gas.readRows_('meta')[2][4] === '2026年7月29日',
    gas.readRows_('meta')[2][4],
  );

  check(
    '触っていない文書の改定日は空のまま',
    String(gas.readRows_('meta')[0][4]).trim() === '',
  );

  check(
    '送信したHTMLに更新後の改定日が載っている',
    Buffer.from(puts[0].payload.content, 'base64').toString('utf8').includes('2026年7月29日 改定'),
  );

  check(
    '改定日を書いたあとも、内容を変えなければ次回はスキップされる',
    (() => {
      puts.length = 0;
      gas.publishLegalDocs();
      return puts.length === 0;
    })(),
    puts.length,
  );

  tokushoSheet.rows[3][2] = '齋藤悠貴';
  gas.publishLegalDocs();

  /* ---------------------------------------------------------------- */
  section('版が上がったときの警告');

  puts.length = 0;
  metaSheet.rows[1][5] = '1.1';

  const bumped = gas.publishLegalDocs();

  check('版を上げると再公開される', puts.length === 1, puts.length);

  check(
    'TOS_VERSION の更新が必要だと警告する',
    bumped.includes('認証設定シートの TOS_VERSION も更新が必要です'),
    bumped,
  );

  check('前回の版と今回の版を示す', bumped.includes('1.0 → 1.1'));
  check('現在の TOS_VERSION を併記する', bumped.includes('（現在: 1.0）'));

  metaSheet.rows[1][5] = '1.0';
  gas.publishLegalDocs();

  puts.length = 0;
  gas.publishLegalDocs();

  check('版が変わらなければ警告しない', puts.length === 0);

  /* ---------------------------------------------------------------- */
  section('GitHub がエラーを返したとき');

  env.clearFetchHandlers();
  env.onFetch((url) => (url.startsWith('https://api.github.com/')
    ? { status: 500, body: { message: 'boom' } }
    : null));

  check(
    '取得に失敗したら例外にして黙って進まない',
    (() => {
      try {
        gas.publishLegalDocs();
        return false;
      } catch (error) {
        return String(error.message).includes('GitHub からの取得に失敗');
      }
    })(),
  );

  env.clearFetchHandlers();
  env.onFetch((url, options) => {
    if (!url.startsWith('https://api.github.com/')) return null;
    if ((options.method || 'get') === 'get') return { status: 404, body: {} };
    return { status: 403, body: { message: 'forbidden' } };
  });

  check(
    '書き込みに失敗したら例外にする',
    (() => {
      try {
        gas.publishLegalDocs();
        return false;
      } catch (error) {
        return String(error.message).includes('GitHub への書き込みに失敗');
      }
    })(),
  );

  check(
    '失敗の知らせにトークンを混ぜない',
    (() => {
      try {
        gas.publishLegalDocs();
        return false;
      } catch (error) {
        return !String(error.message).includes(TOKEN);
      }
    })(),
  );

  installGithub();

  /* ---------------------------------------------------------------- */
  section('プレビュー');

  puts.length = 0;
  const preview = gas.previewLegalDocs();

  check('GitHub へは通信しない', puts.length === 0);
  check('公開していないと明示する', preview.includes('公開はしていません'));

  for (const docId of DOC_IDS) {
    check(`${docId}: プレビューのURLが出る`, preview.includes(`${docId}: https://drive.example/file/`));
  }

  const previewFolder = gas.ensurePreviewFolder_();

  check('preview フォルダは Auth の下にできる', previewFolder.getName() === 'preview');

  check(
    'ファイル名は legal-preview-<doc_id>.html',
    DOC_IDS.every((id) => previewFolder.getFilesByName(`legal-preview-${id}.html`).hasNext()),
  );

  check(
    'プレビューの中身は生成HTMLそのもの',
    previewFolder.getFilesByName('legal-preview-terms.html').next().content
      === gas.buildLegalHtml_('terms'),
  );

  gas.previewLegalDocs();

  check(
    '2回実行してもファイルが増えない（同名を差し替える）',
    previewFolder.files.filter((f) => f.name === 'legal-preview-terms.html').length === 1,
  );
} catch (error) {
  fatal(error);
}

finish();
