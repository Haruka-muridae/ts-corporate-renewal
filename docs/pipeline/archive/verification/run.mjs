/*
 * Phase 0 検証の実行役。
 *
 * ==================================================================
 * tests/run.mjs との違い
 * ==================================================================
 * 似た形をしているが、別物である。
 *
 *   - tests/run.mjs は「実装が仕様どおりか」を見る。外部へ出ない。CI が回す。
 *   - こちらは「外部依存が成立するか」を見る。実サービスへ出る。人が回す。
 *
 * したがって **npm test からは呼ばない。** CI にも入れない。
 * 入れると secrets を CI へ置くことになり、push のたびに課金と
 * レート制限を消費する。README にも同じことを書いてある。
 * ==================================================================
 *
 * 使い方:
 *   node verification/pipeline/run.mjs            自動実行できる項目をすべて
 *   node verification/pipeline/run.mjs T1         トラック単位
 *   node verification/pipeline/run.mjs T3-2       項目単位
 *   node verification/pipeline/run.mjs --list     一覧（通信しない）
 *   node verification/pipeline/run.mjs --plan     実行対象だけ出す（通信しない）
 *   node verification/pipeline/run.mjs T1-2 --publish   実投稿を伴う項目を許可する
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeRaw, redact } from './lib/record.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const TRACK_FILES = [
  'tracks/T1-threads.mjs',
  'tracks/T2-x.mjs',
  'tracks/T3-youtube.mjs',
  'tracks/T4-note.mjs',
  'tracks/T5-media.mjs',
  'tracks/T6-common.mjs',
];

/* ------------------------------------------------------------------
 * 引数
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const selectors = argv.filter((a) => !a.startsWith('--'));

const wantList = flags.has('--list');
const wantPlan = flags.has('--plan');
/*
 * 実投稿・実課金を伴う項目は、明示しない限り実行しない。
 * 検証スクリプトが不意に本番アカウントへ投稿するのは事故のもと。
 */
const publish = flags.has('--publish');

/* ------------------------------------------------------------------
 * .env.local の読み込み（依存を足さないため自前）
 * ------------------------------------------------------------------ */

function loadEnvLocal() {
  const path = resolve(here, '.env.local');

  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const eq = trimmed.indexOf('=');

    if (eq <= 0) {
      continue;
    }

    const key = trimmed.slice(0, eq).trim();
    /* 値の引用符は外す。前後空白と BOM は record.mjs の env() が落とす。 */
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');

    /* 既に環境変数があればそちらを優先する（シェルからの上書きを効かせる）。 */
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/* ------------------------------------------------------------------
 * 実行コンテキスト
 * ------------------------------------------------------------------ */

/**
 * 項目の run() へ渡す道具一式。
 *
 * fetch をここに包んでいるのは、レート制限ヘッダの取り出しと
 * 例外の握り方を項目ごとに書かせないため。
 */
function makeContext({ trackId, itemId, stamp }) {
  /** @type {{ status: 'ok'|'ng'|'skipped'|'error', note: string, measurements: object } | null} */
  let outcome = null;

  const ctx = {
    stamp,
    publish,

    pass(note, measurements = {}) {
      outcome = { status: 'ok', note, measurements };
      return outcome;
    },
    fail(note, measurements = {}) {
      outcome = { status: 'ng', note, measurements };
      return outcome;
    },
    skip(note, measurements = {}) {
      outcome = { status: 'skipped', note, measurements };
      return outcome;
    },

    /** 生のレスポンスが要るとき（ヘッダを読む・本文を読まない場合）。 */
    async fetchRaw(url, init = {}) {
      return fetch(url, init);
    },

    /** JSON を読み、レート制限ヘッダも一緒に返す。 */
    async fetchJson(url, init = {}) {
      const res = await fetch(url, init);
      let json = null;

      try {
        json = await res.json();
      } catch {
        /* JSON でない応答もあり得る。null のままにして呼び出し側に判断させる。 */
      }

      /** @type {Record<string, string>} */
      const rateLimit = {};

      for (const [name, value] of res.headers) {
        if (/ratelimit|x-rate-limit|retry-after/i.test(name)) {
          rateLimit[name] = value;
        }
      }

      return { ok: res.ok, status: res.status, json, rateLimit };
    },

    get outcome() {
      return outcome;
    },
  };

  ctx.trackId = trackId;
  ctx.itemId = itemId;

  return ctx;
}

/* ------------------------------------------------------------------
 * 本体
 * ------------------------------------------------------------------ */

/**
 * 明示的に名指しされたか。
 *
 * 凍結トラックは「すべて実行」には含めないが、**名指しすれば動く。**
 * 拡張フェーズを再開したときに、ファイルを書き換えずに動かし始められるようにするため。
 */
function namedExplicitly(item, trackId) {
  return selectors.some((s) => s === trackId || s === item.id || item.id.startsWith(`${s}-`));
}

function matches(item, track) {
  const trackId = track.meta.id;

  /* 凍結中のものは、名指しされたときだけ対象にする。 */
  if (track.meta.frozen === true || item.frozen === true) {
    return namedExplicitly(item, trackId);
  }

  return selectors.length === 0 || namedExplicitly(item, trackId);
}

const KIND_LABEL = {
  auto: '自動',
  browser: 'ブラウザ',
  manual: '手動',
};

async function main() {
  loadEnvLocal();

  const tracks = [];

  for (const file of TRACK_FILES) {
    const mod = await import(new URL(file, import.meta.url).href);
    tracks.push({ meta: mod.meta, items: mod.items });
  }

  /* --- 一覧 ------------------------------------------------------- */
  if (wantList) {
    for (const track of tracks) {
      const frozenTrack = track.meta.frozen === true;
      console.log(`\n${track.meta.id}  ${track.meta.title}${frozenTrack ? '  ★凍結（拡張フェーズ送り）' : ''}`);
      console.log(`    目的: ${track.meta.goal}`);

      if (frozenTrack) {
        console.log(`    凍結理由: ${track.meta.frozenReason}`);
      }

      for (const item of track.items) {
        const blocked = item.blockedBy ? `  [保留: ${item.blockedBy}]` : '';
        const frozen = !frozenTrack && item.frozen === true ? '  ★凍結' : '';
        console.log(`  ${item.id.padEnd(7)} [${KIND_LABEL[item.kind]}] ${item.title}${blocked}${frozen}`);

        if (item.needs) {
          console.log(`${' '.repeat(12)}要: ${item.needs.join(', ')}`);
        }
        if (item.probe) {
          console.log(`${' '.repeat(12)}ページ: verification/pipeline/${item.probe}`);
        }
      }
    }

    const live = tracks
      .filter((t) => t.meta.frozen !== true)
      .flatMap((t) => t.items.filter((i) => i.frozen !== true));
    const frozenCount = tracks
      .flatMap((t) => (t.meta.frozen === true ? t.items : t.items.filter((i) => i.frozen === true)))
      .length;
    const counts = live.reduce((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {});

    console.log(
      `\nMVP 対象 ${live.length} 項目`
      + `（自動 ${counts.auto ?? 0} / ブラウザ ${counts.browser ?? 0} / 手動 ${counts.manual ?? 0}）`
      + ` ／ 凍結 ${frozenCount} 項目`,
    );
    console.log('自動以外はこのスクリプトでは実行されない。担当と手順は各項目を参照。');
    console.log('★凍結は「すべて実行」に含まれない。名指し（例: run.mjs T3）すれば動く。理由は FROZEN.md。');
    return 0;
  }

  /* --- 実行対象の確定 --------------------------------------------- */
  const planned = [];

  for (const track of tracks) {
    for (const item of track.items) {
      if (matches(item, track) && item.kind === 'auto' && typeof item.run === 'function') {
        planned.push({ trackId: track.meta.id, item });
      }
    }
  }

  if (planned.length === 0) {
    console.error(
      selectors.length === 0
        ? '自動実行できる項目がない。--list で一覧を見る。'
        : `該当する自動実行項目がない: ${selectors.join(', ')}`,
    );
    return 1;
  }

  if (wantPlan) {
    console.log('実行対象:');
    for (const { trackId, item } of planned) {
      console.log(`  ${trackId}  ${item.id}  ${item.title}`);
    }
    console.log(publish ? '\n--publish 指定あり: 実投稿を伴う項目も実行される。' : '\n--publish なし: 実投稿は行わない。');
    return 0;
  }

  /* --- 実行 -------------------------------------------------------- */
  const stamp = new Date().toISOString();
  let ng = 0;

  console.log(`検証開始 ${stamp}${publish ? '  [--publish: 実投稿を許可]' : ''}\n`);

  for (const { trackId, item } of planned) {
    const ctx = makeContext({ trackId, itemId: item.id, stamp });
    let result;

    try {
      result = await item.run(ctx);
    } catch (error) {
      /*
       * 1項目の失敗で残りを止めない。外部サービス相手なので、
       * たまたま落ちている先が1つあることは普通に起きる。
       */
      result = {
        status: 'error',
        note: `例外: ${error instanceof Error ? error.message : String(error)}`,
        measurements: {},
      };
    }

    const mark = { ok: '  OK  ', ng: '  NG  ', skipped: ' skip ', error: ' ERR  ' }[result.status];
    console.log(`${mark} ${item.id}  ${item.title}`);
    console.log(`        ${redact(result.note)}`);

    if (result.status === 'ng' || result.status === 'error') {
      ng += 1;
    }

    writeRaw({
      trackId,
      itemId: item.id,
      status: result.status,
      note: result.note,
      measurements: result.measurements,
      at: stamp,
    });
  }

  console.log(`\n${planned.length} 項目を実行。NG/ERR: ${ng}`);
  console.log('実測値は verification/pipeline/results/raw/ に記録した。');
  console.log('**判定（Go / 条件付きGo / No-Go）は results/T*.md へ人が書く。**');

  /*
   * NG があっても終了コードは 0 にする。検証の NG は「結果」であって
   * 「スクリプトの失敗」ではない。CI に載せない前提なので、
   * 終了コードで自動判定させる相手もいない。
   */
  return 0;
}

process.exitCode = await main();
