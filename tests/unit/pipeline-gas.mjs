/*
 * gas-isso の骨組み（Config.gs / Sheets.gs）の検証。
 *
 * ==================================================================
 * 何を守っているか
 * ==================================================================
 * 1. 列定義と主キーの整合（定義の取り違えを早く見つける）
 * 2. **型の正規化** — Sheets は同じ列で boolean を返したり文字列を
 *    返したりする。ここがずれると採用フラグの判定が壊れる
 * 3. **見出し名で読むこと** — 手で列を並べ替えられても壊れないこと。
 *    足りない見出しは名指しで落ちること
 * 4. ポートの振る舞い（挿入・更新・削除・まとめ差し替え）
 *
 * **実シート経路（SpreadsheetApp）は検証していない。** ハーネスが
 * SpreadsheetApp を用意しないため、触れば ReferenceError で落ちる。
 * そこは実機でしか確かめられない範囲であり、手順書 §G の通し確認で見る。
 * ==================================================================
 */

import { check, section, finish } from '../../public/apps/tests/helpers/assert.mjs';
import { loadIssoGas, createIssoStore } from '../helpers/isso-gas-harness.mjs';

function throws(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

const gas = loadIssoGas({
  properties: {
    ISSO_SPREADSHEET_ID: 'sheet-abc',
    HELPER_SPREADSHEET_ID: 'helper-abc',
    HELPER_SHEET_NAME: '記事キュー',
  },
});

/* ================================================================ */
section('読み込み');

check('.gs をすべて読み込める', gas.files.length >= 2, gas.files.join(','));
check('Config.gs が最初に読まれる', gas.files[0] === 'Config.gs', gas.files[0]);

/* ================================================================ */
section('列定義');

const sheetNames = Object.keys(gas.ISSO_COLUMNS);

check('6シートある', sheetNames.length === 6, String(sheetNames.length));
check('すべてのシートに主キーが定義されている',
  sheetNames.every((name) => typeof gas.ISSO_PRIMARY_KEY[name] === 'string'));
check('主キーは1列目',
  sheetNames.every((name) => gas.ISSO_COLUMNS[name][0].key === gas.ISSO_PRIMARY_KEY[name]));

/* 本文列は最後（横スクロールさせないため。v1.0-personal §4） */
const lastOf = (name) => gas.ISSO_COLUMNS[name][gas.ISSO_COLUMNS[name].length - 1].key;

check('themes の最後は source_text', lastOf('themes') === 'source_text', lastOf('themes'));
check('versions の最後は body', lastOf('versions') === 'body', lastOf('versions'));
check('generation_queue の最後は result', lastOf('generation_queue') === 'result', lastOf('generation_queue'));

/* 会員版 versions への写像（roadmap 要件2） */
const versionKeys = gas.ISSO_COLUMNS.versions.map((c) => c.key);

for (const required of [
  'theme_id', 'stage', 'version_no', 'parent_version_id', 'adopted', 'edited_by_user', 'body',
]) {
  check(`versions に ${required} がある（会員版への写像）`, versionKeys.includes(required));
}

check('adopted は boolean 型',
  gas.ISSO_COLUMNS.versions.find((c) => c.key === 'adopted').type === 'boolean');
check('version_no は number 型',
  gas.ISSO_COLUMNS.versions.find((c) => c.key === 'version_no').type === 'number');

check('未定義のシートは落ちる', throws(() => gas.IssoSheets_columns('nope')) instanceof Error);

/* ================================================================ */
section('型の正規化');

check('真の boolean', gas.IssoSheets_coerce('boolean', true) === true);
check('偽の boolean', gas.IssoSheets_coerce('boolean', false) === false);
check('**文字列の TRUE も真**（手入力に備える）', gas.IssoSheets_coerce('boolean', 'TRUE') === true);
check('小文字の true も真', gas.IssoSheets_coerce('boolean', 'true') === true);
check('空文字は偽', gas.IssoSheets_coerce('boolean', '') === false);
check('null は偽', gas.IssoSheets_coerce('boolean', null) === false);
check('無関係な文字列は偽', gas.IssoSheets_coerce('boolean', 'あとで') === false);

check('数値', gas.IssoSheets_coerce('number', 3) === 3);
check('文字列の数値', gas.IssoSheets_coerce('number', '3') === 3);
check('空は0', gas.IssoSheets_coerce('number', '') === 0);
check('**数字でないものは0**（NaN を下流へ流さない）', gas.IssoSheets_coerce('number', 'x') === 0);

check('文字列の null は空文字', gas.IssoSheets_coerce('string', null) === '');
check('数値は文字列化', gas.IssoSheets_coerce('string', 5) === '5');

check('boolean は TRUE/FALSE で書く', gas.IssoSheets_toCell('boolean', 'TRUE') === false);
check('boolean の書き込みは厳密', gas.IssoSheets_toCell('boolean', true) === true);

/* ================================================================ */
section('見出し名で読む');

{
  /* 定義とは違う順に並べ、間に無関係な列を挟む（手で編集された状態） */
  const seed = {
    settings: [
      ['メモ', 'value', 'key'],
      ['なにか', 'ですます', 'tone'],
    ],
  };
  const { store } = createIssoStore(gas, seed);
  const rows = store.getAll('settings');

  check('**並べ替えられていても正しく読める**', rows.length === 1 && rows[0].key === 'tone',
    JSON.stringify(rows));
  check('値も正しい', rows[0].value === 'ですます');

  const updated = store.update('settings', 'tone', { value: 'である' });
  check('**並べ替えられていても正しく書ける**', updated.value === 'である');
  check('書いた先が正しい列', store.getAll('settings')[0].value === 'である');
  check('無関係な列を壊さない', seed.settings.length === 2);
}

{
  const missing = throws(() => createIssoStore(gas, {
    settings: [['key'], ['tone']],
  }).store.getAll('settings'));

  check('見出しが足りなければ落ちる', missing instanceof Error);
  check('**足りない見出しを名指しする**', String(missing.message).includes('value'),
    String(missing?.message));
}

/* ================================================================ */
section('初期化（ensureSheets）');

{
  const { store, tables } = createIssoStore(gas);
  const dump = tables.dump();

  check('6シートが作られる', Object.keys(dump).length === 6, String(Object.keys(dump).length));
  check('見出し行が入る', dump.versions[0][0] === 'version_id');
  check('見出しだけで本体は空', dump.versions.length === 1);

  /* 何度実行しても同じ結果になること（gas-auth の setupAuthSystem と同じ考え方） */
  store.insert('settings', { key: 'tone', value: 'ですます' });
  const createdAgain = store.ensureSheets();

  check('**再実行しても既存を壊さない**', store.getAll('settings').length === 1);
  check('2回目は何も作らない', createdAgain.length === 0, createdAgain.join(','));
}

/* ================================================================ */
section('ポートの読み書き');

{
  const { store } = createIssoStore(gas);

  store.insert('versions', {
    version_id: 'ver_1', theme_id: 'thm_1', stage: 'threads', version_no: 1,
    parent_version_id: '', adopted: false, edited_by_user: false,
    created_at: '2026-08-08T00:00:00.000Z', body: '案A',
  });
  store.insert('versions', {
    version_id: 'ver_2', theme_id: 'thm_1', stage: 'threads', version_no: 2,
    parent_version_id: '', adopted: true, edited_by_user: false,
    created_at: '2026-08-08T00:00:01.000Z', body: '案B',
  });
  store.insert('versions', {
    version_id: 'ver_3', theme_id: 'thm_2', stage: 'threads', version_no: 1,
    parent_version_id: '', adopted: false, edited_by_user: false,
    created_at: '2026-08-08T00:00:02.000Z', body: '別テーマ',
  });

  check('挿入できる', store.getAll('versions').length === 3);
  check('IDで引ける', store.findById('versions', 'ver_2').body === '案B');
  check('無いIDは null', store.findById('versions', 'ver_9') === null);
  check('**boolean が往復する**', store.findById('versions', 'ver_2').adopted === true);
  check('**number が往復する**', store.findById('versions', 'ver_2').version_no === 2);

  check('列で絞れる', store.findBy('versions', 'theme_id', 'thm_1').length === 2);

  const updated = store.update('versions', 'ver_1', { adopted: true, body: '手直し' });
  check('更新できる', updated.body === '手直し' && updated.adopted === true);
  check('保存されている', store.findById('versions', 'ver_1').adopted === true);
  check('他の行に波及しない', store.findById('versions', 'ver_3').adopted === false);

  const tampered = store.update('versions', 'ver_1', { version_id: 'ver_hack' });
  check('**主キーは書き換えられない**', tampered.version_id === 'ver_1');

  check('無いIDの更新は落ちる',
    throws(() => store.update('versions', 'ver_9', { body: 'x' })) instanceof Error);

  store.remove('versions', 'ver_3');
  check('削除できる', store.getAll('versions').length === 2);
  check('無いIDの削除は落ちない', throws(() => store.remove('versions', 'ver_9')) === null);
}

/* ================================================================ */
section('まとめ差し替え（シーンの作り直し）');

{
  const { store } = createIssoStore(gas);

  for (let i = 0; i < 3; i += 1) {
    store.insert('scenes', {
      scene_id: `scn_${i}`, version_id: 'ver_1', order: i,
      narration: `ナレ${i}`, visual_prompt: `映像${i}`, subtitle: '',
    });
  }

  store.insert('scenes', {
    scene_id: 'scn_other', version_id: 'ver_2', order: 0,
    narration: '別版', visual_prompt: '別映像', subtitle: '',
  });

  store.replaceBy('scenes', 'version_id', 'ver_1', [
    { scene_id: 'scn_new0', version_id: 'ver_1', order: 0, narration: '新0', visual_prompt: '新映像0', subtitle: '' },
    { scene_id: 'scn_new1', version_id: 'ver_1', order: 1, narration: '新1', visual_prompt: '新映像1', subtitle: '' },
  ]);

  const after = store.findBy('scenes', 'version_id', 'ver_1');

  check('**古いシーンが残らない**', after.length === 2, String(after.length));
  check('中身が入れ替わる', after[0].narration === '新0');
  check('**他の版のシーンを巻き込まない**',
    store.findBy('scenes', 'version_id', 'ver_2').length === 1);
}

/* ================================================================ */
section('空行の扱い');

{
  const { store } = createIssoStore(gas, {
    settings: [['key', 'value'], ['tone', 'ですます'], ['', ''], ['   ', '']],
  });

  check('**主キーが空の行は数えない**（手編集で残る空行に備える）',
    store.getAll('settings').length === 1, String(store.getAll('settings').length));
}

/* ================================================================ */
section('Script Properties');

check('読める', gas.IssoConfig_spreadsheetId() === 'sheet-abc');
check('Helper の所在を読める',
  gas.IssoConfig_helperTarget().sheetName === '記事キュー');

{
  const bare = loadIssoGas({ properties: {} });
  const error = throws(() => bare.IssoConfig_spreadsheetId());

  check('無ければ落ちる', error instanceof Error);
  check('**プロパティ名を名指しする**',
    String(error.message).includes('ISSO_SPREADSHEET_ID'), String(error?.message));
}

{
  /* 貼り付け経路で混ざる BOM と空白を落とすこと */
  const dirty = loadIssoGas({ properties: { ISSO_SPREADSHEET_ID: '﻿  sheet-xyz  ' } });

  check('**BOM と前後空白を落とす**', dirty.IssoConfig_spreadsheetId() === 'sheet-xyz',
    JSON.stringify(dirty.IssoConfig_spreadsheetId()));
}

{
  const empty = loadIssoGas({ properties: { ISSO_SPREADSHEET_ID: '   ' } });
  check('空白だけは未設定として扱う',
    throws(() => empty.IssoConfig_spreadsheetId()) instanceof Error);
}

/* ================================================================ */
section('ID と時刻');

check('接頭辞が付く',
  gas.IssoConfig_newId('versions', () => 'abc') === 'ver_abc');
check('シートごとに接頭辞が違う',
  gas.IssoConfig_newId('themes', () => 'abc') === 'thm_abc');
check('未定義のシートは落ちる',
  throws(() => gas.IssoConfig_newId('nope', () => 'x')) instanceof Error);
check('Utilities.getUuid が使える', gas.IssoConfig_newId('versions').startsWith('ver_'));
check('時刻を差し替えられる',
  gas.IssoConfig_now(() => '2026-01-01T00:00:00.000Z') === '2026-01-01T00:00:00.000Z');

/* ================================================================ */
section('状態値の共有');

check('キューの状態が定義されている',
  gas.ISSO_STATUS.QUEUE_WAITING === '待機' && gas.ISSO_STATUS.QUEUE_DONE === '完了');
check('Helper への引き渡しの状態がある',
  typeof gas.ISSO_STATUS.POST_HANDED_TO_HELPER === 'string');
check('既定の settings がある',
  gas.ISSO_DEFAULT_SETTINGS['threads.lengthHint'] === '50〜150字');

finish();
