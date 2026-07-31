/*
 * 不足フォルダの「計画」を組み立てる純粋ロジック。
 *
 * ------------------------------------------------------------------
 * ここでは通信しない
 * ------------------------------------------------------------------
 * 通信を伴う探索・作成は folder-create.js が行う。
 * このファイルは
 *   - 目標構成 → 作成順に並んだノード列
 *   - 探索結果 → 既存 / 不足 / 判断保留 の仕分け
 *   - Drive の作成レスポンスの検証
 * だけを扱う。単体テストで全分岐を確認できるようにするためである。
 * ------------------------------------------------------------------
 */

import { FOLDER_STRUCTURE, DRIVE_ROOT_LABEL, MIME } from '../config.js';

/* 1ノードの状態。 */
export const NodeStatus = Object.freeze({
  EXISTING: 'existing',   // 既にある。再利用する
  MISSING: 'missing',     // 無い。作成対象
  AMBIGUOUS: 'ambiguous', // 同名が複数ある。自動では決めない
  BLOCKED: 'blocked',     // 親が未確定のため判定できない
});

/* 計画全体の状態。 */
export const PlanStatus = Object.freeze({
  COMPLETE: 'complete',     // すべて揃っている。作成不要
  INCOMPLETE: 'incomplete', // 作成すべきものがある
  AMBIGUOUS: 'ambiguous',   // 同名フォルダがあり、利用者の選択が要る
});

/*
 * 目標構成を「作成順」に並べたノード列へ展開する。
 *
 * 順序は要件どおり固定する。
 *   TSAM AI → ローカルLLM → 01_ナレッジ → 02_未整理 → 03_アーカイブ → 99_システム
 *
 * 各ノード:
 *   { key, name, depth, parentPath, path, parentKey, isKnowledge }
 *     key        … 'TSAM AI/ローカルLLM/01_ナレッジ' のような一意キー
 *     parentPath … 親までのセグメント配列（ルート直下なら []）
 *     parentKey  … 親ノードの key（ルート直下なら null）
 */
export function buildFolderPlan(structure = FOLDER_STRUCTURE) {
  const base = Array.isArray(structure?.base) ? structure.base : [];
  const children = Array.isArray(structure?.children) ? structure.children : [];
  const nodes = [];

  base.forEach((name, index) => {
    const parentPath = base.slice(0, index);
    nodes.push(makeNode({ name, parentPath, structure }));
  });

  children.forEach((name) => {
    nodes.push(makeNode({ name, parentPath: base, structure }));
  });

  return nodes;
}

function makeNode({ name, parentPath, structure }) {
  const path = [...parentPath, name];

  return Object.freeze({
    key: path.join('/'),
    name,
    depth: parentPath.length,
    parentPath: Object.freeze([...parentPath]),
    path: Object.freeze(path),
    parentKey: parentPath.length > 0 ? parentPath.join('/') : null,
    isKnowledge: name === structure?.knowledge,
  });
}

/* 表示用のフルパス（マイドライブ / TSAM AI / …）。 */
export function formatNodePath(node, rootLabel = DRIVE_ROOT_LABEL) {
  return [rootLabel, ...(node?.path ?? [])].join(' / ');
}

/*
 * 探索結果からノードごとの状態を決める。
 *
 * found は key → { status, folder, candidates } のマップ。
 *   status: 'found' | 'not-found' | 'ambiguous'
 * 親が未確定（不足・複数）の子は BLOCKED にする。
 * 親が「これから作られる」場合も、作成後に決まるので MISSING として扱う。
 */
export function classifyPlan(nodes, found = new Map()) {
  const byKey = new Map();
  const result = [];

  nodes.forEach((node) => {
    const parent = node.parentKey ? byKey.get(node.parentKey) : null;

    /*
     * 親が同名複数のときは、その先を判断してはいけない。
     * BLOCKED も伝播させる（祖先が曖昧なら子孫すべて判定できない）。
     */
    if (parent && (parent.status === NodeStatus.AMBIGUOUS || parent.status === NodeStatus.BLOCKED)) {
      const entry = { node, status: NodeStatus.BLOCKED, folder: null, candidates: [] };
      byKey.set(node.key, entry);
      result.push(entry);
      return;
    }

    const lookup = found.get(node.key) ?? null;

    if (lookup?.status === 'ambiguous') {
      const entry = {
        node,
        status: NodeStatus.AMBIGUOUS,
        folder: null,
        candidates: Array.isArray(lookup.candidates) ? lookup.candidates : [],
      };
      byKey.set(node.key, entry);
      result.push(entry);
      return;
    }

    if (lookup?.status === 'found' && lookup.folder?.id) {
      const entry = { node, status: NodeStatus.EXISTING, folder: lookup.folder, candidates: [] };
      byKey.set(node.key, entry);
      result.push(entry);
      return;
    }

    const entry = { node, status: NodeStatus.MISSING, folder: null, candidates: [] };
    byKey.set(node.key, entry);
    result.push(entry);
  });

  return result;
}

/* 仕分け結果から、計画全体の状態と件数をまとめる。 */
export function summarizePlan(entries) {
  const existing = entries.filter((e) => e.status === NodeStatus.EXISTING);
  const missing = entries.filter((e) => e.status === NodeStatus.MISSING);
  const ambiguous = entries.filter((e) => e.status === NodeStatus.AMBIGUOUS);
  const blocked = entries.filter((e) => e.status === NodeStatus.BLOCKED);

  let status = PlanStatus.COMPLETE;

  if (ambiguous.length > 0) {
    status = PlanStatus.AMBIGUOUS;
  } else if (missing.length > 0) {
    status = PlanStatus.INCOMPLETE;
  }

  return {
    status,
    entries,
    existing,
    missing,
    ambiguous,
    blocked,
    /* 「不足フォルダを作成」ボタンを出すかどうか。 */
    needsCreation: missing.length > 0,
    /* 作成できるか（同名複数が残っていると作成に進ませない）。 */
    canCreate: missing.length > 0 && ambiguous.length === 0,
  };
}

/*
 * 作成対象だけを、作成順に並べて返す。
 *
 * 途中で失敗して再実行したときも、この関数へ渡す `found` が
 * 「前回作成済みのフォルダ」を含んでいれば、そのノードは EXISTING になり
 * 対象から外れる。＝ 失敗した続きから再開できる。
 */
export function selectCreationTargets(entries) {
  return entries
    .filter((entry) => entry.status === NodeStatus.MISSING)
    .map((entry) => entry.node);
}

/*
 * Drive の files.create レスポンスを検証する。
 *
 * 応答を鵜呑みにせず、
 *   - フォルダとして作られたか
 *   - 依頼した名前と一致するか
 *   - 依頼した親の直下にあるか
 * を確認する。1つでも外れたら「作った先が違う」ため失敗として扱う。
 */
export function validateCreatedFolder(resource, { name, parentId }) {
  if (!resource || typeof resource !== 'object') {
    return { ok: false, reason: 'empty_response' };
  }

  if (typeof resource.id !== 'string' || resource.id === '') {
    return { ok: false, reason: 'missing_id' };
  }

  if (resource.mimeType !== MIME.GOOGLE_FOLDER) {
    return { ok: false, reason: 'not_a_folder' };
  }

  /* 名前は完全一致で見る（サロゲートペアを含む名前も壊さず比較できる）。 */
  if (String(resource.name) !== String(name)) {
    return { ok: false, reason: 'name_mismatch' };
  }

  const parents = Array.isArray(resource.parents) ? resource.parents : [];

  if (!parents.includes(String(parentId))) {
    return { ok: false, reason: 'parent_mismatch' };
  }

  return { ok: true, reason: null };
}

/*
 * 作成要求の本体を組み立てる。
 *
 * 送ってよいのはこの3つだけ。
 * 既存ファイルに触れるフィールド（id / trashed / 権限）は絶対に入れない。
 */
export function buildCreateBody({ name, parentId }) {
  const folderName = String(name ?? '');
  const parent = String(parentId ?? '');

  if (folderName.trim() === '') {
    return { ok: false, reason: 'empty_name', body: null };
  }

  /* 親IDが空・'/' 混じりなど明らかに不正なものは通信前に弾く。 */
  if (parent === '' || /[/\s]/.test(parent)) {
    return { ok: false, reason: 'invalid_parent', body: null };
  }

  return {
    ok: true,
    reason: null,
    body: {
      name: folderName,
      mimeType: MIME.GOOGLE_FOLDER,
      parents: [parent],
    },
  };
}

/* 確認画面に出す「作成予定の階層」テキスト（既存/新規の別つき）。 */
export function describePlanLines(entries, rootLabel = DRIVE_ROOT_LABEL) {
  return entries.map((entry) => ({
    key: entry.node.key,
    name: entry.node.name,
    depth: entry.node.depth,
    path: formatNodePath(entry.node, rootLabel),
    status: entry.status,
    label: LABEL_BY_STATUS[entry.status] ?? '',
  }));
}

const LABEL_BY_STATUS = Object.freeze({
  [NodeStatus.EXISTING]: '既存（再利用）',
  [NodeStatus.MISSING]: '新規作成',
  [NodeStatus.AMBIGUOUS]: '同名が複数（選択が必要）',
  [NodeStatus.BLOCKED]: '親が未確定',
});

export { LABEL_BY_STATUS };
