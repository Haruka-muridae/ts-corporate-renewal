/*
 * 定員による申込停止の検証。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 境界は「支払済み >= 定員」。ちょうどで締める（29は通し、30は止める）
 *   - capacity が null のイベントは止めない（従来どおりの運用を壊さない）
 *   - 数えるのは status='paid' だけ。決済待ち（awaiting）を席にしない
 *   - 返金で件数が減れば、再び申し込めるようになる
 *   - 定員なしのときはDBへ問い合わせない（無駄な往復を増やさない）
 *   - 件数はヘッダー（Content-Range）から読み、行を転送しない
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  SOLD_OUT_MESSAGE,
  isEventSoldOut,
  isSoldOut,
  resolveCapacityStatus,
} from '../../lib/event/capacity.mjs';

import { countPaidApplications } from '../../lib/event/db.mjs';

/*
 * PostgREST の代わり。呼ばれた内容を記録し、決めた件数を
 * Content-Range ヘッダーで返す。
 */
function makeFetch({ total = 0, ok = true, status = 200, range = null } = {}) {
  const calls = [];

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });

    const headerValue = range !== null ? range : `0-${Math.max(0, total - 1)}/${total}`;

    return {
      ok,
      status,
      headers: {
        get: (name) =>
          String(name).toLowerCase() === 'content-range' ? headerValue : null,
      },
    };
  };

  return { fetchImpl, calls };
}

function configWith(fetchImpl) {
  return {
    url: 'https://example.supabase.co',
    serviceRoleKey: 'service-role-key',
    fetchImpl,
  };
}

try {
  /* ---------------------------------------------------------------- */
  section('満席の境界');

  check('29 / 30 は通す', isSoldOut({ capacity: 30, paidCount: 29 }) === false);
  check('30 / 30 は止める（ちょうどで締める）',
    isSoldOut({ capacity: 30, paidCount: 30 }) === true);
  check('31 / 30 は止める', isSoldOut({ capacity: 30, paidCount: 31 }) === true);
  check('0 / 30 は通す', isSoldOut({ capacity: 30, paidCount: 0 }) === false);

  /* ---------------------------------------------------------------- */
  section('定員なし（後方互換）');

  check('capacity が null なら止めない',
    isSoldOut({ capacity: null, paidCount: 1000 }) === false);
  check('capacity が undefined でも止めない',
    isSoldOut({ capacity: undefined, paidCount: 1000 }) === false);

  /*
   * 0 や負数は設定ミス。満席扱いにすると受付が丸ごと止まり、
   * しかも原因が分かりにくい。定員なしに倒し、管理画面側で気づけるようにする。
   */
  check('capacity が 0 なら定員なし扱い',
    isSoldOut({ capacity: 0, paidCount: 1 }) === false);
  check('capacity が負数なら定員なし扱い',
    isSoldOut({ capacity: -1, paidCount: 1 }) === false);
  check('capacity が小数なら定員なし扱い',
    isSoldOut({ capacity: 30.5, paidCount: 100 }) === false);

  /* ---------------------------------------------------------------- */
  section('返金による再開放');

  /*
   * 返金すると applications.status が 'refunded' に変わり、
   * status='paid' の件数から外れる。席を空ける専用の処理は要らない。
   */
  check('30 / 30 で満席', isSoldOut({ capacity: 30, paidCount: 30 }) === true);
  check('1件返金して 29 / 30 になれば再び通す',
    isSoldOut({ capacity: 30, paidCount: 29 }) === false);

  /* ---------------------------------------------------------------- */
  section('件数の問い合わせ');

  {
    const { fetchImpl, calls } = makeFetch({ total: 30 });
    const total = await countPaidApplications(configWith(fetchImpl), 'event-1');

    check('Content-Range の総数を返す', total === 30, String(total));
    check('問い合わせは1回', calls.length === 1, String(calls.length));

    const [call] = calls;

    check('applications を引く', call.url.includes('/rest/v1/applications?'), call.url);
    check('イベントで絞る', call.url.includes('event_id=eq.event-1'), call.url);

    /*
     * ここが「awaiting を数えない」の実体。
     * 条件が status=eq.paid であることを直接確かめる。
     */
    check('支払済みだけを数える', call.url.includes('status=eq.paid'), call.url);
    check('決済待ちを混ぜない', !call.url.includes('awaiting'), call.url);

    check('HEAD で投げる（行を転送しない）', call.options.method === 'HEAD',
      String(call.options.method));
    check('件数を要求する', call.options.headers.Prefer === 'count=exact',
      String(call.options.headers.Prefer));
    check('service role キーで呼ぶ',
      call.options.headers.apikey === 'service-role-key');
  }

  {
    const { fetchImpl, calls } = makeFetch({ total: 0 });
    const total = await countPaidApplications(configWith(fetchImpl), 'ev/1 &2');

    check('0件を 0 として読む', total === 0, String(total));
    check('イベントIDをURLエンコードする',
      calls[0].url.includes('event_id=eq.ev%2F1%20%262'), calls[0].url);
  }

  {
    /* 該当が無いとき PostgREST は範囲を "*" で返す。総数だけを見る。 */
    const { fetchImpl } = makeFetch({ range: '*/0' });
    const total = await countPaidApplications(configWith(fetchImpl), 'event-1');

    check('範囲が "*" でも総数を読む', total === 0, String(total));
  }

  {
    const { fetchImpl } = makeFetch({ ok: false, status: 500 });
    let threw = false;

    try {
      await countPaidApplications(configWith(fetchImpl), 'event-1');
    } catch {
      threw = true;
    }

    check('失敗したら例外にする（満席かどうかを推測しない）', threw);
  }

  {
    const { fetchImpl } = makeFetch({ range: '' });
    let threw = false;

    try {
      await countPaidApplications(configWith(fetchImpl), 'event-1');
    } catch {
      threw = true;
    }

    check('ヘッダーが無ければ例外にする', threw);
  }

  /* ---------------------------------------------------------------- */
  section('イベント単位の判定');

  {
    const { fetchImpl, calls } = makeFetch({ total: 29 });
    const soldOut = await isEventSoldOut(configWith(fetchImpl), {
      id: 'event-1',
      capacity: 30,
    });

    check('29 / 30 は通す', soldOut === false);
    check('件数を数えている', calls.length === 1, String(calls.length));
  }

  {
    const { fetchImpl } = makeFetch({ total: 30 });
    const soldOut = await isEventSoldOut(configWith(fetchImpl), {
      id: 'event-1',
      capacity: 30,
    });

    check('30 / 30 は止める', soldOut === true);
  }

  {
    const { fetchImpl } = makeFetch({ total: 31 });
    const soldOut = await isEventSoldOut(configWith(fetchImpl), {
      id: 'event-1',
      capacity: 30,
    });

    check('31 / 30 は止める', soldOut === true);
  }

  {
    const { fetchImpl, calls } = makeFetch({ total: 1000 });
    const soldOut = await isEventSoldOut(configWith(fetchImpl), {
      id: 'event-1',
      capacity: null,
    });

    check('定員なしなら止めない', soldOut === false);
    check('定員なしならDBを見に行かない', calls.length === 0, String(calls.length));
  }

  {
    const { fetchImpl, calls } = makeFetch({ total: 1000 });
    const soldOut = await isEventSoldOut(configWith(fetchImpl), null);

    check('イベントが無ければ止めない', soldOut === false);
    check('イベントが無ければDBを見に行かない', calls.length === 0);
  }

  /* ---------------------------------------------------------------- */
  section('管理画面に出す状態');

  {
    const none = resolveCapacityStatus({ capacity: null, paidCount: 5 });
    check('定員なしは none', none.state === 'none', none.state);
    check('定員なしでは残席を出さない', none.remaining === null);

    const ok = resolveCapacityStatus({ capacity: 30, paidCount: 29 });
    check('空きありは ok', ok.state === 'ok', ok.state);
    check('残席を出す', ok.remaining === 1, String(ok.remaining));
    check('超過は0', ok.over === 0, String(ok.over));

    const full = resolveCapacityStatus({ capacity: 30, paidCount: 30 });
    check('ちょうどは full', full.state === 'full', full.state);
    check('残席は0', full.remaining === 0, String(full.remaining));
    check('ちょうどは超過に数えない', full.over === 0, String(full.over));

    const over = resolveCapacityStatus({ capacity: 30, paidCount: 32 });
    check('超えていれば over', over.state === 'over', over.state);
    check('超過件数を出す', over.over === 2, String(over.over));
    check('残席は0で止める', over.remaining === 0, String(over.remaining));
  }

  /* ---------------------------------------------------------------- */
  section('文言');

  check('満席の文言を1か所に持つ',
    typeof SOLD_OUT_MESSAGE === 'string' && SOLD_OUT_MESSAGE.includes('定員'),
    SOLD_OUT_MESSAGE);

  finish();
} catch (error) {
  fatal(error);
}
