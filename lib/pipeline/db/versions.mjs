/*
 * versions の読み書き（ContentVersion 相当）。**本プロダクトの中核。**
 *
 * ==================================================================
 * ここが担っている要件
 * ==================================================================
 *   - 要件10章「重要」: parentVersionId による派生追跡。
 *     どの Threads 案からどの X・note が派生したかを辿れること
 *   - 要件15章: 「前段の**採用版**を次段の主要入力として扱う」
 *   - 要件15章: 「ユーザーが修正した表現を…AI原案より優先する」
 *     → editedByUser を持ち、生成時のプロンプトで扱いを変える
 *   - FR-013: 複数案。**別ストアにせず versions の複数行**として持ち、
 *     うち1件が adopted になる（案も版も「同じ段階の候補」で構造が同じ）
 * ==================================================================
 */

import { STORE, makeId, previousStage } from './schema.mjs';

function nowIso(now) {
  return (now ?? (() => new Date().toISOString()))();
}

/**
 * 版を作る。`versionNo` は同一 [projectId, stage] 内の連番。
 *
 * @param {import('./port.d.mts').Store} store
 */
export async function createVersion(store, input, deps = {}) {
  const siblings = await store.getAllBy(
    STORE.VERSIONS,
    'byProjectStage',
    [input.projectId, input.stage],
  );

  const maxNo = siblings.reduce((max, v) => (v.versionNo > max ? v.versionNo : max), 0);

  const version = {
    id: makeId(STORE.VERSIONS, deps.cryptoImpl),
    projectId: input.projectId,
    stage: input.stage,
    body: String(input.body ?? ''),
    versionNo: maxNo + 1,
    parentVersionId: input.parentVersionId ?? null,
    adopted: false,
    editedByUser: input.editedByUser === true,
    createdAt: nowIso(deps.now),
  };

  return store.put(STORE.VERSIONS, version);
}

/** 段階の版をすべて（新しい順）。 */
export async function listVersions(store, projectId, stage) {
  const rows = await store.getAllBy(STORE.VERSIONS, 'byProjectStage', [projectId, stage]);

  return rows.sort((a, b) => b.versionNo - a.versionNo);
}

/**
 * 採用版を取る。
 *
 * **adopted が複数立っていた場合は versionNo が最大のものを採る。**
 * 採用の切り替えは読んで書く2手なので、理屈の上では途中で中断されると
 * 2件立ちうる（別タブでの同時操作など）。そのとき画面が固まるより、
 * 決定的に1件へ寄せて次の採用操作で直るほうがよい。
 */
export async function getAdopted(store, projectId, stage) {
  const rows = await store.getAllBy(STORE.VERSIONS, 'byProjectStage', [projectId, stage]);
  const adopted = rows.filter((row) => row.adopted === true);

  if (adopted.length === 0) {
    return null;
  }

  return adopted.reduce((best, row) => (row.versionNo > best.versionNo ? row : best));
}

/**
 * 採用する。**同一 [projectId, stage] で adopted は高々1件。**
 *
 * 旧採用を落としてから新しいものを立てる。まとめ書きにしているのは、
 * IndexedDB 側で1トランザクションに収めるため（indexeddb.mjs の putAll）。
 */
export async function adoptVersion(store, versionId) {
  const target = await store.get(STORE.VERSIONS, versionId);

  if (target === null) {
    throw new Error(`版が見つかりません: ${versionId}`);
  }

  const siblings = await store.getAllBy(
    STORE.VERSIONS,
    'byProjectStage',
    [target.projectId, target.stage],
  );

  const updated = siblings.map((row) => ({ ...row, adopted: row.id === versionId }));

  await store.putAll(STORE.VERSIONS, updated);

  return updated.find((row) => row.id === versionId);
}

/**
 * 本文を編集する。**編集した事実を残す**（要件15章）。
 *
 * 版を作り直さず同じ版を書き換えるのは、「案の採用」と「文言の手直し」を
 * 別の操作として見せるため。手直しのたびに版が増えると、
 * どれが採用版か分からなくなる。
 */
export async function editVersionBody(store, versionId, body) {
  const current = await store.get(STORE.VERSIONS, versionId);

  if (current === null) {
    throw new Error(`版が見つかりません: ${versionId}`);
  }

  return store.put(STORE.VERSIONS, {
    ...current,
    body: String(body ?? ''),
    editedByUser: true,
  });
}

/**
 * 次段の生成に渡す上流（採用済みのものだけ）。
 *
 * 要件15章「前段の採用版を主要入力とする」の実装。
 * **未採用の案は渡さない。** 渡すと、採用しなかった案の表現が
 * 次段に混ざる。
 *
 * @returns {Promise<Array<{ stage: string, body: string, editedByUser: boolean }>>}
 */
export async function collectUpstream(store, projectId, stage) {
  /** @type {Array<{ stage: string, body: string, editedByUser: boolean }>} */
  const chain = [];

  let cursor = previousStage(stage);

  while (cursor !== null) {
    const adopted = await getAdopted(store, projectId, cursor);

    if (adopted !== null) {
      chain.unshift({
        stage: cursor,
        body: adopted.body,
        editedByUser: adopted.editedByUser === true,
      });
    }

    cursor = previousStage(cursor);
  }

  return chain;
}

/**
 * 次段へ進めるか。**前段が採用済みかどうか**で決まる。
 *
 * 画面はこれを見てタブの活性を切り替える（設計 §2-3）。
 *
 * ---------------------------------------------------------------
 * 【第1段との差・要調整】
 *
 * 第1段（`gas-isso/Versions.gs` の `IssoVersions_canGenerate`）は
 * **宣言された上流をすべて**見ている。こちらは**直前の1段だけ**。
 *
 * 実運用では順に進むため結果はほぼ同じだが、`note` の上流は
 * `lib/pipeline/prompts/definitions.mjs` の宣言では **[threads, x] の2つ**で、
 * x を採用したあとに threads の採用を外すと、
 * **片方だけの上流でプロンプトが組まれる。**
 *
 * **第2段を再開するときに、上流すべてを見る規則へ揃えること。**
 * 揃えるときは `previousStage()` ではなく definitions.mjs の
 * `upstreamStages` を参照する（単一ソースに寄せる）。
 * ---------------------------------------------------------------
 */
export async function canGenerate(store, projectId, stage) {
  const previous = previousStage(stage);

  if (previous === null) {
    return true;
  }

  return (await getAdopted(store, projectId, previous)) !== null;
}
