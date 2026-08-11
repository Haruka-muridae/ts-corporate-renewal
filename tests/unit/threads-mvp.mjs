/*
 * Threads 投稿 MVP（gas-threads/）のスイート。
 *
 * v2.0（intent リンク方式）。API・トークンは使わないため、
 * ここで固定するのは次の4点。
 *   §3.1 「=」始まり文字列のエスケープ（一想の note 取り込みで実際に発生）
 *   §3.2 シート自動生成の3分岐
 *   §3.4 intent リンクの組み立てと履歴記録
 *   §3.5-3.6 予約リマインダーの claim・二重発火防止・canceled スキップ・
 *            failed は再実行しない
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';
import { createThreadsEnvironment } from '../helpers/gas-threads-harness.mjs';

try {
  /* ================================================================ */
  section('§3.1 共通書き込み口の「=」エスケープ');

  {
    const env = createThreadsEnvironment();
    env.api.saveDraft('=SUM(A1) から始まる本文');
    env.api.saveDraft('+81 から始まる本文');
    env.api.saveDraft('@mention から始まる本文');
    env.api.saveDraft('-普通のダッシュ始まり');

    const raw = env.rawRows('下書き');
    check('格納値は先頭にアポストロフィが付く（=）', raw[1][1] === "'=SUM(A1) から始まる本文");
    check('格納値は先頭にアポストロフィが付く（+）', raw[2][1] === "'+81 から始まる本文");
    check('格納値は先頭にアポストロフィが付く（@）', raw[3][1] === "'@mention から始まる本文");
    check('「-」始まりは変更しない', raw[4][1] === '-普通のダッシュ始まり');

    const read = env.readSheet('下書き');
    check('読み出しではアポストロフィが付かない扱いになる',
      read[0]['本文'] === "'=SUM(A1) から始まる本文" || read[0]['本文'] === '=SUM(A1) から始まる本文');
  }

  /* ================================================================ */
  section('§3.2 シート自動生成の3分岐');

  {
    /* 分岐1: 無ければ生成。 */
    const env = createThreadsEnvironment();
    check('最初はシートが無い', env.book.getSheetByName('下書き') === null);

    env.api.ensureSheet_('下書き');
    const sheet = env.book.getSheetByName('下書き');
    check('生成される', sheet !== null);
    check('ヘッダーが書かれる', sheet.rows[0].join(',') === 'id,本文,作成日時');
  }

  {
    /* 分岐2: ヘッダー一致なら既存データを保持したまま使う。 */
    const env = createThreadsEnvironment();
    const sheet = env.book.insertSheet('下書き');
    sheet.appendRow(['id', '本文', '作成日時']);
    sheet.appendRow(['既存-1', '既存の本文', 123]);

    const resolved = env.api.ensureSheet_('下書き');
    check('同じシートが返る', resolved === sheet);
    check('既存データが残る', sheet.rows.length === 2 && sheet.rows[1][0] === '既存-1');
  }

  {
    /* 分岐3: 不一致なら書き込まずエラーで止まり、データを変えない。 */
    const env = createThreadsEnvironment();
    const sheet = env.book.insertSheet('下書き');
    sheet.appendRow(['id', '別の列', '作成日時']);
    sheet.appendRow(['既存-1', '既存の本文', 123]);

    let error = null;
    try {
      env.api.ensureSheet_('下書き');
    } catch (caught) {
      error = caught;
    }

    check('SheetMismatchError で止まる', error !== null && error.name === 'SheetMismatchError');
    check('メッセージにシート名を含む', error !== null && error.message.includes('下書き'));
    check('既存データは無変更', sheet.rows.length === 2 && sheet.rows[0][1] === '別の列');
  }

  /* ================================================================ */
  section('§3.4 intent リンクの組み立てと履歴');

  {
    const env = createThreadsEnvironment();

    const result = env.api.buildIntentLink('こんにちは Threads\n2行目');
    check('成功を返す', result.ok === true);
    check('intent の URL になる',
      result.url.startsWith('https://www.threads.net/intent/post?text='));
    check('本文が URL エンコードされる',
      result.url.includes(encodeURIComponent('こんにちは Threads\n2行目')));

    const history = env.readSheet('履歴');
    check('履歴に「投稿画面を開いた」が残る',
      history.length === 1 && history[0]['種別'] === '投稿画面を開いた'
      && history[0]['成否'] === '成功');
  }

  {
    const env = createThreadsEnvironment();

    const empty = env.api.buildIntentLink('   ');
    check('空本文は失敗を返す', empty.ok === false);

    const long = env.api.buildIntentLink('あ'.repeat(501));
    check('500字超は失敗を返す', long.ok === false);

    const exact = env.api.buildIntentLink('あ'.repeat(500));
    check('ちょうど500字はリンクを作れる', exact.ok === true);

    check('失敗は履歴に残さない（開いていないため）',
      env.readSheet('履歴').length === 1);
  }

  /* ================================================================ */
  section('§3.5 予約の登録・取消');

  {
    const env = createThreadsEnvironment();
    const at = env.getTime() + 60 * 60 * 1000;

    const { id } = env.api.reservePost('予約の本文', at);
    let rows = env.readSheet('予約');
    check('scheduled で登録される', rows.length === 1 && rows[0]['状態'] === 'scheduled');

    const canceled = env.api.cancelReservation(id);
    rows = env.readSheet('予約');
    check('scheduled は取り消せる', canceled.ok === true && rows[0]['状態'] === 'canceled');

    const again = env.api.cancelReservation(id);
    check('canceled は再度取り消せない', again.ok === false);

    let error = null;
    try {
      env.api.reservePost('過去の予約', env.getTime() - 1000);
    } catch (caught) {
      error = caught;
    }
    check('過去日時は登録できない', error !== null);
  }

  /* ================================================================ */
  section('§3.5-3.6 発火・claim・失敗停止');

  {
    const env = createThreadsEnvironment();
    const at = env.getTime() + 30 * 60 * 1000;

    env.api.reservePost('時間が来たら知らせる投稿', at);

    env.api.processDueReservations();
    check('時刻前は送らない', env.sentMails.length === 0
      && env.readSheet('予約')[0]['状態'] === 'scheduled');

    env.advance(31 * 60 * 1000);
    env.api.processDueReservations();

    const row = env.readSheet('予約')[0];
    check('時刻後の発火で done になる', row['状態'] === 'done');
    check('メールが1通だけ送られる', env.sentMails.length === 1);
    check('宛先は自分', env.sentMails[0].to === 'owner@example.com');
    check('本文に intent リンクが入る',
      env.sentMails[0].htmlBody.includes('https://www.threads.net/intent/post?text='));
    check('本文に投稿文が入る',
      env.sentMails[0].htmlBody.includes('時間が来たら知らせる投稿'));

    /* もう一度発火しても、done は再実行されない。 */
    env.api.processDueReservations();
    check('done は再実行しない', env.sentMails.length === 1);

    const history = env.readSheet('履歴');
    check('履歴に予約リマインダーの成功が残る',
      history.length === 1 && history[0]['種別'] === '予約リマインダー'
      && history[0]['成否'] === '成功');
  }

  {
    /* canceled はスキップされる。 */
    const env = createThreadsEnvironment();
    const { id } = env.api.reservePost('取り消される投稿', env.getTime() + 1000);

    env.api.cancelReservation(id);
    env.advance(10 * 60 * 1000);
    env.api.processDueReservations();

    check('canceled は送らない', env.sentMails.length === 0
      && env.readSheet('予約')[0]['状態'] === 'canceled');
  }

  {
    /* 失敗したら failed で止まり、以後の発火で自動再試行しない。 */
    const env = createThreadsEnvironment();
    env.setMailError('quota exceeded');

    env.api.reservePost('失敗する投稿', env.getTime() + 1000);
    env.advance(10 * 60 * 1000);
    env.api.processDueReservations();

    const row = env.readSheet('予約')[0];
    check('failed になりエラーが残る',
      row['状態'] === 'failed' && String(row['エラー']).includes('quota exceeded'));
    check('履歴にも失敗が残る', env.readSheet('履歴')[0]['成否'] === '失敗');

    /* メールが直っても、その予約は二度と自動実行しない。 */
    env.setMailError(null);
    env.api.processDueReservations();
    env.advance(60 * 60 * 1000);
    env.api.processDueReservations();
    check('failed は二度と自動実行しない', env.sentMails.length === 0);
  }

  {
    /* ロックが取れないときは何もしない（二重発火の防止）。 */
    const env = createThreadsEnvironment();

    env.api.reservePost('二重発火させない投稿', env.getTime() + 1000);
    env.advance(10 * 60 * 1000);

    env.holdLock();
    env.api.processDueReservations();
    check('ロック中は送らない', env.sentMails.length === 0
      && env.readSheet('予約')[0]['状態'] === 'scheduled');

    env.releaseLock();
    env.api.processDueReservations();
    check('ロック解放後に送られる', env.sentMails.length === 1
      && env.readSheet('予約')[0]['状態'] === 'done');
  }

  {
    /* メール本文の HTML エスケープ（本文に <script> が入っても壊れない）。 */
    const env = createThreadsEnvironment();
    env.api.reservePost('<b>タグ</b> & 記号', env.getTime() + 1000);
    env.advance(10 * 60 * 1000);
    env.api.processDueReservations();

    const body = env.sentMails[0].htmlBody;
    check('タグはエスケープされる', body.includes('&lt;b&gt;タグ&lt;/b&gt; &amp; 記号'));
  }

  /* ================================================================ */
  section('§3.8 投稿文の生成（Gemini）');

  {
    const env = createThreadsEnvironment({
      properties: { GEMINI_API_KEY: 'FAKE-GEMINI-KEY' },
    });

    env.onFetch((url, options) => {
      if (!String(url).startsWith('https://generativelanguage.googleapis.com/')) {
        return null;
      }

      return {
        status: 200,
        body: {
          candidates: [{
            content: { parts: [{ text: '  生成された投稿文です。\n2行目。  ' }] },
          }],
        },
      };
    });

    const result = env.api.generatePostText('新サービスの告知');
    check('生成に成功する', result.ok === true);
    check('前後の空白を落として返す', result.text === '生成された投稿文です。\n2行目。');

    const call = env.fetchCalls[0];
    check('既定モデルの generateContent を呼ぶ',
      call.url.includes('/models/gemini-2.0-flash:generateContent'));
    check('キーは URL パラメータで渡す（note-auto-fill-gas と同じ）',
      call.url.includes('?key=FAKE-GEMINI-KEY'));

    const payload = JSON.parse(call.options.payload);
    check('role: user で渡す', payload.contents[0].role === 'user');
    check('temperature 0.4（既存実装と同じ）',
      payload.generationConfig.temperature === 0.4);
    check('プロンプトにテーマが入る',
      payload.contents[0].parts[0].text.includes('新サービスの告知'));
    check('プロンプトに500字制約が入る',
      payload.contents[0].parts[0].text.includes('500文字以内'));
    check('プロンプトに創作の禁止が入る',
      payload.contents[0].parts[0].text.includes('創作の禁止'));

    check('生成は下書きへ自動保存しない', env.readSheet('下書き').length === 0);
    check('生成は履歴に残さない', env.readSheet('履歴').length === 0);
  }

  {
    /* キー未設定・空テーマ・API エラーは分かるメッセージで返す。 */
    const env = createThreadsEnvironment();

    const noKey = env.api.generatePostText('テーマ');
    check('キー未設定はその旨を返す',
      noKey.ok === false && noKey.error.includes('GEMINI_API_KEY'));
    check('キー未設定では API を呼ばない', env.fetchCalls.length === 0);

    env.properties.GEMINI_API_KEY = 'FAKE';
    const empty = env.api.generatePostText('   ');
    check('空テーマは失敗を返す', empty.ok === false && empty.error.includes('空'));

    env.onFetch(() => ({ status: 429, body: { error: { message: 'quota exceeded' } } }));
    const apiError = env.api.generatePostText('テーマ');
    check('API エラーは HTTP ステータスと応答先頭を含めて返す',
      apiError.ok === false && apiError.error.includes('HTTP 429')
      && apiError.error.includes('quota exceeded'));

    env.clearFetchHandlers();
    env.onFetch(() => ({ status: 200, body: { candidates: [] } }));
    const noCandidates = env.api.generatePostText('テーマ');
    check('候補なしはその旨を返す',
      noCandidates.ok === false && noCandidates.error.includes('候補を返しませんでした'));

    env.clearFetchHandlers();
    env.onFetch(() => ({
      status: 200,
      body: { candidates: [{ finishReason: 'SAFETY' }] },
    }));
    const blocked = env.api.generatePostText('テーマ');
    check('本文なしは終了理由を添えて返す',
      blocked.ok === false && blocked.error.includes('SAFETY'));
  }

  {
    /* GEMINI_MODEL でモデルを差し替えられ、コードフェンスは剥がされる。 */
    const env = createThreadsEnvironment({
      properties: { GEMINI_API_KEY: 'FAKE', GEMINI_MODEL: 'gemini-2.5-pro' },
    });

    env.onFetch(() => ({
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: '```\n本文だけ\n```' }] } }] },
    }));

    const result = env.api.generatePostText('テーマ');
    check('モデルを差し替えられる',
      env.fetchCalls[0].url.includes('/models/gemini-2.5-pro:generateContent'));
    check('コードフェンスは取り除かれる', result.text === '本文だけ');
  }

  /* ================================================================ */
  section('セットアップ（トリガーの整備）');

  {
    const env = createThreadsEnvironment();

    env.api.setupThreadsMvp();
    env.api.setupThreadsMvp();

    const triggers = env.getTriggers();
    check('2回実行してもトリガーは1本のまま', triggers.length === 1);
    check('5分ポーリングがある', triggers.some(
      (t) => t.getHandlerFunction() === 'processDueReservations' && t.minutes === 5,
    ));
    check('シートも揃う', env.book.getSheetByName('履歴') !== null);
  }
} catch (error) {
  fatal(error);
}

finish();
