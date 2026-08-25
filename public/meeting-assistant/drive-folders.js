/*
 * 保存先フォルダの解決（検索 → 無ければ作成）と、フォルダ ID の保持。
 * Drive API そのものは持たず、drive.js の関数を依存として受け取る。
 *
 * ------------------------------------------------------------------
 * 保存先は毎回「保証」する。作らせない、探させない
 * ------------------------------------------------------------------
 *   マイドライブ
 *   └─ Potenitas System
 *      └─ Potenitas Administrator
 *         └─ Potenitas meet
 *            ├─ Potenitas voice
 *            └─ Potenitas record
 *
 * 各階層を「名前と親」で検索し、無い階層だけを作る（drive.js の ensureFolderChain）。
 * 途中まで存在していれば、その下の不足分だけを作る。同名のフォルダが既にあれば
 * 作成時刻が最も古いものを再利用し、二重に作らない。
 *
 * ------------------------------------------------------------------
 * フォルダ ID の保持と、保存前の検証
 * ------------------------------------------------------------------
 * 一度解決できた階層の ID を localStorage に持ち、次回からは名前での
 * 逐次検索（4 階層 = 4 往復）を省く。ただし ID を盲信しない。保存の直前に
 * 各階層を files.get で並列に確認し、次のどれかなら捨てて解決しなおす。
 *
 *   - 無い（404 / 403）        … 完全に削除された、別アカウントの ID
 *   - ゴミ箱にある（trashed）  … 上位階層がゴミ箱でも、その階層自身で検出できる
 *   - 名前が違う               … 利用者が改名した（別物として扱い、正しい名前で作りなおす）
 *   - 親が違う                 … 移動された
 *
 * 並列に投げるので往復は 1 回分。検索しなおす場合の 4 往復より短い。
 * 通信エラー・認証切れは「無効」とは扱わず、そのまま呼び出し側へ返す
 * （オフラインで作りなおしに走ると重複を生むため）。
 *
 * ID そのものは秘密ではないが、音声・トークンと同じ場所には置かない。
 * ------------------------------------------------------------------
 *
 * drive.file スコープの範囲:
 *   このアプリ（同じ GCP プロジェクトの OAuth クライアント）が作成した
 *   フォルダ・ファイルだけが見える。利用者が Drive の画面で手作業で作った
 *   同名フォルダは検索に出ず、アプリは別のフォルダを作ってしまう。
 *   スコープはここでは広げない（config.js の OAUTH.scope が唯一の定義）。
 */

import { AppError, ErrorCode } from './errors.js';

export const FOLDER_CACHE_KEY = 'meeting-assistant-drive-folders';
const CACHE_VERSION = 1;
/*
 * 同じ保存処理の中で voice と record を続けて解決するとき、共通の階層を二度確認しない
 * ための猶予。短くしてあるのは「保存の直前に検知する」を弱めないため
 * （Gemini の処理を挟んで数分後に record を解決するときは改めて確認する）。
 */
const VALIDATION_TTL_MS = 5 * 1000;

function sameName(left, right) {
  /* Drive の名前検索は大文字小文字を区別しないので、こちらも合わせる。 */
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();
}

function readCache(storage) {
  if (!storage) {
    return {};
  }

  try {
    const raw = storage.getItem(FOLDER_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;

    if (parsed?.version !== CACHE_VERSION || typeof parsed.chains !== 'object' || parsed.chains === null) {
      return {};
    }

    const chains = {};

    for (const [kind, chain] of Object.entries(parsed.chains)) {
      if (Array.isArray(chain) && chain.every((node) => typeof node?.id === 'string' && node.id !== '' && typeof node?.name === 'string')) {
        chains[kind] = chain.map((node) => ({ id: node.id, name: node.name }));
      }
    }

    return chains;
  } catch {
    return {};
  }
}

function writeCache(storage, chains) {
  if (!storage) {
    return false;
  }

  try {
    if (Object.keys(chains).length === 0) {
      storage.removeItem(FOLDER_CACHE_KEY);
    } else {
      storage.setItem(FOLDER_CACHE_KEY, JSON.stringify({ version: CACHE_VERSION, chains }));
    }

    return true;
  } catch {
    return false;
  }
}

/* 「無い・見えない」だけを無効扱いにする。通信・認証の失敗は上へ返す。 */
function isMissingError(error) {
  return error instanceof AppError && error.code === ErrorCode.FOLDER_FORBIDDEN;
}

/*
 * deps:
 *   storage     … localStorage 相当（null 可。無ければメモリだけ）
 *   ensureChain … (names, auth) => Promise<[{ id, name }, ...]>  検索 → 無ければ作成（drive.js）
 *   getFolder   … (id, auth) => Promise<{ id, name, mimeType, trashed, parents }>（drive.js）
 *   paths       … { voice: [...names], record: [...names] }
 *   now         … () => number（テスト用）
 */
export function createFolderResolver({ storage = null, ensureChain, getFolder, paths, now = Date.now } = {}) {
  if (typeof ensureChain !== 'function' || typeof getFolder !== 'function' || !paths) {
    throw new TypeError('createFolderResolver: ensureChain / getFolder / paths are required');
  }

  let chains = readCache(storage);
  /* id → 確認した時刻。同じ保存処理の中で二度確認しない。 */
  const validatedAt = new Map();

  function namesOf(kind) {
    const names = paths[kind];

    if (!Array.isArray(names) || names.length === 0) {
      throw new TypeError(`createFolderResolver: unknown kind ${String(kind)}`);
    }

    return names;
  }

  /*
   * 保持している階層が今も正しいかを並列に確認する。
   * 戻り値: true（使える）/ false（解決しなおす）。通信・認証エラーは投げる。
   */
  async function validateChain(chain, names, auth) {
    if (chain.length !== names.length) {
      return false;
    }

    for (let i = 0; i < chain.length; i += 1) {
      if (!sameName(chain[i].name, names[i])) {
        return false;
      }
    }

    const current = now();
    const pending = chain.filter((node) => {
      const at = validatedAt.get(node.id);
      return !(typeof at === 'number' && current - at < VALIDATION_TTL_MS);
    });

    if (pending.length === 0) {
      return true;
    }

    const results = await Promise.all(pending.map(async (node) => {
      try {
        return { node, meta: await getFolder(node.id, auth) };
      } catch (error) {
        if (isMissingError(error)) {
          return { node, meta: null };
        }

        throw error;
      }
    }));

    const metaById = new Map(results.map(({ node, meta }) => [node.id, meta]));

    for (let i = 0; i < chain.length; i += 1) {
      const node = chain[i];

      if (!metaById.has(node.id)) {
        continue; /* 直近に確認済み */
      }

      const meta = metaById.get(node.id);

      if (!meta || meta.trashed === true) {
        return false;
      }

      if (meta.mimeType && meta.mimeType !== 'application/vnd.google-apps.folder') {
        return false;
      }

      if (!sameName(meta.name, names[i])) {
        return false;
      }

      if (i > 0) {
        const parents = Array.isArray(meta.parents) ? meta.parents : [];

        if (!parents.includes(chain[i - 1].id)) {
          return false;
        }
      }
    }

    for (const node of pending) {
      validatedAt.set(node.id, current);
    }

    return true;
  }

  /*
   * 別の種類（voice ↔ record）の保持から、共通する上位階層を借りる。
   * 「Potenitas System / Administrator / meet」は両方で同じなので、片方を解決した直後に
   * もう片方を解決するときは、最後の 1 階層だけを検索すればよい。
   * 借りる前に、その上位階層が今も使えることを確認する（validateChain と同じ規則）。
   */
  async function reusablePrefix(kind, names, auth) {
    let best = null;

    for (const [otherKind, chain] of Object.entries(chains)) {
      if (otherKind === kind) {
        continue;
      }

      let length = 0;

      while (length < chain.length && length < names.length - 1 && sameName(chain[length].name, names[length])) {
        length += 1;
      }

      if (length > 0 && (!best || length > best.length)) {
        best = { chain: chain.slice(0, length), length };
      }
    }

    if (!best) {
      return null;
    }

    return (await validateChain(best.chain, names.slice(0, best.length), auth)) ? best.chain : null;
  }

  async function resolveChain(kind, auth) {
    const names = namesOf(kind);
    const cached = chains[kind];

    if (cached && await validateChain(cached, names, auth)) {
      return cached;
    }

    /* 保持が無い・使えない。名前で解決しなおし（無い階層だけ作成）、保持を更新する。 */
    const prefix = (await reusablePrefix(kind, names, auth)) ?? [];
    const rest = names.slice(prefix.length);
    const parentId = prefix.length > 0 ? prefix[prefix.length - 1].id : 'root';
    const resolved = await ensureChain(rest, auth, parentId);
    const chain = [
      ...prefix,
      ...resolved.map((node, i) => ({ id: String(node.id), name: String(node.name ?? rest[i]) })),
    ];
    const current = now();

    chain.forEach((node) => validatedAt.set(node.id, current));
    chains = { ...chains, [kind]: chain };
    writeCache(storage, chains);

    return chain;
  }

  return {
    /* 保存先フォルダの ID を返す。無ければ作る。使えない保持は捨てて解決しなおす。 */
    async resolve(kind, auth) {
      const chain = await resolveChain(kind, auth);
      return chain[chain.length - 1].id;
    },

    /* 連携しなおし（別アカウントの可能性）や明示的な取り直しで捨てる。 */
    forget() {
      chains = {};
      validatedAt.clear();
      writeCache(storage, chains);
    },

    /* 表示・テスト用。ID を返すだけで Drive は触らない。 */
    cachedId(kind) {
      const chain = chains[kind];
      return chain ? chain[chain.length - 1].id : null;
    },
  };
}
