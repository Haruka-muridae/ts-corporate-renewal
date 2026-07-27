/*
 * Drive API と Google Identity Services のモック。
 *
 * 本番コードには一切手を入れず、
 *   - globalThis.google       … GIS を差し替え（ポップアップ無しでトークンを返す）
 *   - globalThis.fetch        … Drive API の応答を組み立てる
 * だけで、認証完了後の全経路を実行できるようにする。
 *
 * loadGis() は globalThis.google.accounts.oauth2 の有無しか見ないため、
 * これを先に用意しておけば外部スクリプトを取りに行かない。
 */

const FOLDER = 'application/vnd.google-apps.folder';
const GDOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';

export const MIMES = { FOLDER, GDOC, SHEET };

const realFetch = globalThis.fetch.bind(globalThis);

export function getRealFetch() {
  return realFetch;
}

export async function loadFixtures(names) {
  const out = {};

  for (const name of names) {
    /* eslint-disable-next-line no-await-in-loop */
    const response = await realFetch(`/tests/fixtures/generated/${name}`);
    if (!response.ok) {
      throw new Error(`fixture ${name}: ${response.status}`);
    }
    /* eslint-disable-next-line no-await-in-loop */
    out[name] = await response.arrayBuffer();
  }

  return out;
}

/* ---------- GIS ---------- */

export function installFakeGis(options = {}) {
  const state = {
    requests: 0,
    lastPrompt: null,
    revoked: 0,
    mode: options.mode ?? 'ok',   // 'ok' | 'popup_closed' | 'popup_blocked' | 'access_denied' | 'silent' | 'wrong_scope'
    scope: options.scope ?? 'https://www.googleapis.com/auth/drive.readonly',
  };

  globalThis.google = {
    accounts: {
      oauth2: {
        initTokenClient({ callback, error_callback }) {
          return {
            requestAccessToken(params = {}) {
              state.requests += 1;
              state.lastPrompt = params.prompt ?? '';

              setTimeout(() => {
                if (state.mode === 'silent') {
                  /* 何も返さない（利用者が同意画面を放置した状況）。 */
                  return;
                }
                if (state.mode === 'popup_closed') {
                  error_callback?.({ type: 'popup_closed' });
                  return;
                }
                if (state.mode === 'popup_blocked') {
                  error_callback?.({ type: 'popup_failed_to_open' });
                  return;
                }
                if (state.mode === 'access_denied') {
                  callback({ error: 'access_denied' });
                  return;
                }
                if (state.mode === 'wrong_scope') {
                  callback({ access_token: 'fake-token-wrong', expires_in: 3600, scope: 'https://www.googleapis.com/auth/userinfo.email' });
                  return;
                }

                callback({
                  access_token: `fake-token-${state.requests}`,
                  expires_in: options.expiresIn ?? 3600,
                  scope: state.scope,
                  token_type: 'Bearer',
                });
              }, 0);
            },
          };
        },
        hasGrantedAllScopes: (response, wanted) => String(response?.scope ?? '').split(/\s+/).includes(wanted),
        revoke: (token, done) => { state.revoked += 1; done?.({ successful: true }); },
      },
    },
  };

  return state;
}

/* ---------- ファイルツリー ---------- */

export function createTree(fixtures) {
  const nodes = new Map();

  const add = (node) => {
    nodes.set(node.id, {
      version: '1',
      trashed: false,
      webViewLink: `https://drive.google.com/file/d/${node.id}/view`,
      ...node,
    });
  };

  add({ id: 'f-tsam', parent: 'root', name: 'TSAM AI', mimeType: FOLDER, modifiedTime: '2026-01-01T00:00:00.000Z' });
  add({ id: 'f-llm', parent: 'f-tsam', name: 'ローカルLLM', mimeType: FOLDER, modifiedTime: '2026-01-01T00:00:00.000Z' });
  add({ id: 'f-kn', parent: 'f-llm', name: '01_ナレッジ', mimeType: FOLDER, modifiedTime: '2026-01-01T00:00:00.000Z' });
  add({ id: 'f-sub', parent: 'f-kn', name: 'sub', mimeType: FOLDER, modifiedTime: '2026-01-01T00:00:00.000Z' });

  /* 別階層に紛らわしい同名フォルダ（誤検出しないことの確認用）。 */
  add({ id: 'f-decoy-root', parent: 'root', name: '01_ナレッジ', mimeType: FOLDER, modifiedTime: '2026-01-01T00:00:00.000Z' });
  add({ id: 'f-decoy-tsam', parent: 'f-tsam', name: '01_ナレッジ', mimeType: FOLDER, modifiedTime: '2026-01-01T00:00:00.000Z' });
  add({ id: 'f-decoy-trashed', parent: 'root', name: 'TSAM AI', mimeType: FOLDER, modifiedTime: '2026-01-01T00:00:00.000Z', trashed: true });

  add({ id: 'file-txt', parent: 'f-kn', name: 'test-knowledge.txt', mimeType: 'text/plain', modifiedTime: '2026-02-01T00:00:00.000Z', body: fixtures['sample.txt'] });
  add({ id: 'file-md', parent: 'f-kn', name: 'test-knowledge.md', mimeType: 'text/markdown', modifiedTime: '2026-02-02T00:00:00.000Z', body: fixtures['sample.md'] });
  add({ id: 'file-pdf', parent: 'f-kn', name: 'test-knowledge.pdf', mimeType: 'application/pdf', modifiedTime: '2026-02-03T00:00:00.000Z', body: fixtures['sample.pdf'] });
  add({ id: 'file-docx', parent: 'f-kn', name: 'test-knowledge.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', modifiedTime: '2026-02-04T00:00:00.000Z', body: fixtures['sample.docx'] });
  add({ id: 'file-gdoc', parent: 'f-kn', name: 'test-knowledge-gdoc', mimeType: GDOC, modifiedTime: '2026-02-05T00:00:00.000Z', exportText: '# 議事録\n\nテスト用キーワードなにぬねの を含みます。\n\n## 決定事項\n\n次回までに資料を用意すること。\n' });
  add({ id: 'file-sheet', parent: 'f-kn', name: 'test-sheet', mimeType: SHEET, modifiedTime: '2026-02-06T00:00:00.000Z' });
  add({ id: 'file-sub-txt', parent: 'f-sub', name: 'test-sub.txt', mimeType: 'text/plain', modifiedTime: '2026-02-07T00:00:00.000Z', body: fixtures['sample-sjis.txt'] });

  return nodes;
}

/* ---------- クエリの解釈 ---------- */

function parseQuery(q) {
  const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q);
  const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
  const mime = /mimeType = '([^']*)'/.exec(q);
  const unescape = (value) => String(value ?? '').replace(/\\'/g, "'").replace(/\\\\/g, '\\');

  return {
    parent: parent ? unescape(parent[1]) : null,
    name: name ? unescape(name[1]) : null,
    mimeType: mime ? mime[1] : null,
    excludeTrashed: q.includes('trashed = false'),
  };
}

function toResource(node) {
  const resource = {
    id: node.id,
    name: node.name,
    mimeType: node.mimeType,
    modifiedTime: node.modifiedTime,
    version: node.version,
    trashed: node.trashed,
    webViewLink: node.webViewLink,
  };

  if (node.body) {
    resource.size = String(node.body.byteLength);
  }
  if (node.declaredSize !== undefined) {
    resource.size = String(node.declaredSize);
  }
  if (node.shortcutDetails) {
    resource.shortcutDetails = node.shortcutDetails;
  }

  return resource;
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
});

export const driveError = (status, reason, headers = {}) => json(
  status,
  { error: { code: status, message: 'test', errors: reason ? [{ reason, message: 'test' }] : [] } },
  headers,
);

/* JSON ではないエラー応答（Googleが稀に返すHTMLページ）。 */
export const htmlError = (status) => new Response('<html><body>error</body></html>', {
  status,
  headers: { 'Content-Type': 'text/html' },
});

/* ---------- fetch の差し替え ---------- */

export function installFakeFetch({ tree, scenario }) {
  const requests = [];

  const router = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);

    if (!url.includes('googleapis.com/drive/v3')) {
      return realFetch(input, init);
    }

    const parsed = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const auth = init.headers?.Authorization ?? init.headers?.authorization ?? '';

    requests.push({
      url: parsed.pathname + parsed.search,
      path: parsed.pathname,
      method,
      hasAuthHeader: auth.startsWith('Bearer '),
      /* トークンの値そのものは保持しない（漏洩検査で誤検知しないため）。 */
      authLength: auth.length,
      pageToken: parsed.searchParams.get('pageToken'),
    });

    if (init.signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }

    const delay = scenario.delayMs ?? 0;
    if (delay > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    }

    if (parsed.pathname.endsWith('/about')) {
      const injected = scenario.inject?.('about', { url: parsed });
      if (injected) return injected;

      return json(200, {
        user: { displayName: 'テスト太郎', emailAddress: 'test@example.com', photoLink: 'https://lh3.googleusercontent.com/a/x' },
        storageQuota: { limit: '16106127360', usage: '1073741824' },
      });
    }

    if (parsed.pathname.includes('/export')) {
      const id = decodeURIComponent(/\/files\/([^/]+)\/export/.exec(parsed.pathname)?.[1] ?? '');
      const injected = scenario.inject?.('export', { id });
      if (injected) return injected;

      const node = tree.get(id);
      if (!node) return driveError(404, 'notFound');

      return new Response(node.exportText ?? '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }

    if (parsed.searchParams.get('alt') === 'media') {
      const id = decodeURIComponent(/\/files\/([^/]+)$/.exec(parsed.pathname)?.[1] ?? '');
      const injected = scenario.inject?.('media', { id });
      if (injected) return injected;

      const node = tree.get(id);
      if (!node) return driveError(404, 'notFound');
      if (!node.body) return driveError(404, 'notFound');

      return new Response(node.body, { status: 200, headers: { 'Content-Type': node.mimeType } });
    }

    if (parsed.pathname.endsWith('/files')) {
      const q = parsed.searchParams.get('q') ?? '';
      const injected = scenario.inject?.('list', { q, pageToken: parsed.searchParams.get('pageToken') });
      if (injected) return injected;

      const cond = parseQuery(q);
      let files = [...tree.values()].filter((node) => node.parent === cond.parent);

      if (cond.excludeTrashed) files = files.filter((node) => !node.trashed);
      if (cond.mimeType) files = files.filter((node) => node.mimeType === cond.mimeType);
      if (cond.name !== null) {
        /* Drive の name = は大文字小文字を区別しないことがある挙動を再現する。 */
        files = files.filter((node) => String(node.name).toLowerCase() === cond.name.toLowerCase());
      }

      /* ページネーション（1ページあたりの件数をシナリオで絞れる）。 */
      const perPage = scenario.pageSize ?? files.length;
      const offset = Number(parsed.searchParams.get('pageToken') ?? 0);
      const page = files.slice(offset, offset + Math.max(1, perPage));
      const nextOffset = offset + page.length;

      return json(200, {
        files: page.map(toResource),
        nextPageToken: nextOffset < files.length ? String(nextOffset) : undefined,
      });
    }

    if (/\/files\/[^/]+$/.test(parsed.pathname)) {
      const id = decodeURIComponent(/\/files\/([^/]+)$/.exec(parsed.pathname)?.[1] ?? '');
      const node = tree.get(id);
      if (!node) return driveError(404, 'notFound');
      return json(200, toResource(node));
    }

    return driveError(400, 'badRequest');
  };

  globalThis.fetch = router;

  return {
    requests,
    reset: () => { requests.length = 0; },
    restore: () => { globalThis.fetch = realFetch; },
    countMedia: () => requests.filter((r) => r.url.includes('alt=media')).length,
    countExport: () => requests.filter((r) => r.path.includes('/export')).length,
    countList: () => requests.filter((r) => r.path.endsWith('/files')).length,
    nonGet: () => requests.filter((r) => r.method !== 'GET'),
    missingAuth: () => requests.filter((r) => !r.hasAuthHeader),
  };
}
