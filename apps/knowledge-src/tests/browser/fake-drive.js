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

const READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const WRITE_SCOPE = 'https://www.googleapis.com/auth/drive';

export function installFakeGis(options = {}) {
  const state = {
    requests: 0,
    lastPrompt: null,
    revoked: 0,
    mode: options.mode ?? 'ok',   // 'ok' | 'popup_closed' | 'popup_blocked' | 'access_denied' | 'silent' | 'wrong_scope'
    scope: options.scope ?? READONLY_SCOPE,

    /*
     * 書き込みスコープ（フォルダ作成用）の認可は読み取りと別に制御する。
     * 'ok' 以外にすると「作成の同意だけ拒否された」状況を再現できる。
     */
    writeRequests: 0,
    writeMode: options.writeMode ?? 'ok',
    writeScope: options.writeScope ?? WRITE_SCOPE,
  };

  const respond = ({ mode, scope, token, callback, error_callback }) => {
    if (mode === 'silent') {
      /* 何も返さない（利用者が同意画面を放置した状況）。 */
      return;
    }
    if (mode === 'popup_closed') {
      error_callback?.({ type: 'popup_closed' });
      return;
    }
    if (mode === 'popup_blocked') {
      error_callback?.({ type: 'popup_failed_to_open' });
      return;
    }
    if (mode === 'access_denied') {
      callback({ error: 'access_denied' });
      return;
    }
    if (mode === 'wrong_scope') {
      callback({ access_token: 'fake-token-wrong', expires_in: 3600, scope: 'https://www.googleapis.com/auth/userinfo.email' });
      return;
    }

    callback({
      access_token: token,
      expires_in: options.expiresIn ?? 3600,
      scope,
      token_type: 'Bearer',
    });
  };

  globalThis.google = {
    accounts: {
      oauth2: {
        /* 初期化時に渡されたスコープを覚え、その種類ごとに応答を変える。 */
        initTokenClient({ callback, error_callback, scope: requested }) {
          const isWrite = String(requested ?? '') === state.writeScope;

          return {
            requestAccessToken(params = {}) {
              state.lastPrompt = params.prompt ?? '';

              if (isWrite) {
                state.writeRequests += 1;
                const n = state.writeRequests;
                setTimeout(() => respond({
                  mode: state.writeMode,
                  scope: state.writeScope,
                  token: `fake-write-token-${n}`,
                  callback,
                  error_callback,
                }), 0);
                return;
              }

              state.requests += 1;
              const n = state.requests;
              setTimeout(() => respond({
                mode: state.mode,
                scope: state.scope,
                token: `fake-token-${n}`,
                callback,
                error_callback,
              }), 0);
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

/*
 * multipart/related の本文を、メタデータ部と本文部へ分ける。
 * Google が受け取る形式を、テスト側でも同じ規則で解釈する。
 */
function parseMultipart(raw, contentType) {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1]?.trim();

  if (!boundary) {
    return { metadata: null, content: null };
  }

  const parts = String(raw)
    .split(`--${boundary}`)
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '--');

  const bodies = parts.map((part) => {
    const separator = part.indexOf('\r\n\r\n');
    return separator === -1 ? '' : part.slice(separator + 4);
  });

  let metadata = null;

  try {
    metadata = JSON.parse(bodies[0] ?? '');
  } catch {
    metadata = null;
  }

  return { metadata, content: bodies[1] ?? null };
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

    /*
     * 読み取りは .../drive/v3/...、本文つき作成は .../upload/drive/v3/... へ行く。
     * どちらも捕まえないと、テストが実際のGoogleへ通信してしまう。
     */
    if (!url.includes('googleapis.com/drive/v3') && !url.includes('googleapis.com/upload/drive/v3')) {
      return realFetch(input, init);
    }

    const parsed = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const auth = init.headers?.Authorization ?? init.headers?.authorization ?? '';

    /* 送信本文は検証のために残す（トークンは含まれない）。 */
    const contentType = init.headers?.['Content-Type'] ?? init.headers?.['content-type'] ?? '';
    let sentBody = null;
    let sentContent = null;

    if (typeof init.body === 'string') {
      if (contentType.startsWith('multipart/related')) {
        const parsed = parseMultipart(init.body, contentType);
        sentBody = parsed.metadata;
        sentContent = parsed.content;
      } else {
        try {
          sentBody = JSON.parse(init.body);
        } catch {
          sentBody = { raw: String(init.body).slice(0, 200) };
        }
      }
    }

    requests.push({
      url: parsed.pathname + parsed.search,
      path: parsed.pathname,
      method,
      hasAuthHeader: auth.startsWith('Bearer '),
      /* トークンの値そのものは保持しない（漏洩検査で誤検知しないため）。 */
      authLength: auth.length,
      /* 読み取り用と書き込み用のどちらのトークンで来たか（値は残さない）。 */
      writeToken: auth.includes('fake-write-token-'),
      pageToken: parsed.searchParams.get('pageToken'),
      fields: parsed.searchParams.get('fields'),
      uploadType: parsed.searchParams.get('uploadType'),
      isUpload: parsed.pathname.startsWith('/upload/'),
      contentType,
      body: sentBody,
      content: sentContent,
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

    /*
     * フォルダ作成（POST /files）。
     * 実装が守るべき約束をここで機械的に確認する。
     *   - メソッドが POST であること
     *   - mimeType がフォルダであること
     *   - parents がちょうど1件であること
     *   - fields が要件どおりであること
     * 違反したら 400 を返し、テスト側が気づけるようにする。
     */
    if (parsed.pathname.endsWith('/files') && method === 'POST') {
      const upload = parsed.pathname.startsWith('/upload/');
      const injected = scenario.inject?.(upload ? 'upload' : 'create', {
        body: sentBody, content: sentContent, parent: sentBody?.parents?.[0],
      });
      if (injected) return injected;

      /* 本文つきファイル作成（multipart）。 */
      if (upload) {
        if (parsed.searchParams.get('uploadType') !== 'multipart') return driveError(400, 'invalidUploadType');
        if (!sentBody || typeof sentBody.name !== 'string' || sentBody.name === '') return driveError(400, 'invalidName');
        if (!Array.isArray(sentBody.parents) || sentBody.parents.length !== 1) return driveError(400, 'invalidParents');
        if (typeof sentContent !== 'string' || sentContent === '') return driveError(400, 'invalidContent');

        const uploadParent = String(sentBody.parents[0]);
        if (uploadParent !== 'root' && !tree.has(uploadParent)) return driveError(404, 'notFound');

        const fileId = `f-file-${(scenario.uploadedCount = (scenario.uploadedCount ?? 0) + 1)}`;
        const encoded = new TextEncoder().encode(sentContent);

        tree.set(fileId, {
          id: fileId,
          parent: uploadParent,
          name: sentBody.name,
          mimeType: sentBody.mimeType,
          modifiedTime: '2026-03-01T00:00:00.000Z',
          version: '1',
          trashed: false,
          body: encoded.buffer,
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        });

        return json(200, {
          id: fileId,
          name: sentBody.name,
          mimeType: sentBody.mimeType,
          parents: [uploadParent],
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        });
      }

      if (sentBody?.mimeType !== FOLDER) return driveError(400, 'invalidMimeType');
      if (!Array.isArray(sentBody?.parents) || sentBody.parents.length !== 1) return driveError(400, 'invalidParents');
      if (typeof sentBody?.name !== 'string' || sentBody.name === '') return driveError(400, 'invalidName');

      const parentId = String(sentBody.parents[0]);

      /* 親が存在しない（root は常に有効）。 */
      if (parentId !== 'root' && !tree.has(parentId)) {
        return driveError(404, 'notFound');
      }

      const id = `f-new-${(scenario.createdCount = (scenario.createdCount ?? 0) + 1)}`;

      tree.set(id, {
        id,
        parent: parentId,
        name: sentBody.name,
        mimeType: FOLDER,
        modifiedTime: '2026-03-01T00:00:00.000Z',
        version: '1',
        trashed: false,
        webViewLink: `https://drive.google.com/drive/folders/${id}`,
      });

      return json(200, {
        id,
        name: sentBody.name,
        mimeType: FOLDER,
        parents: [parentId],
        webViewLink: `https://drive.google.com/drive/folders/${id}`,
      });
    }

    /* POST 以外の書き込みメソッドは実装しない（呼ばれたら必ず落ちる）。 */
    if (method !== 'GET') {
      return driveError(405, 'methodNotAllowed');
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
    countList: () => requests.filter((r) => r.path.endsWith('/files') && r.method === 'GET').length,
    nonGet: () => requests.filter((r) => r.method !== 'GET'),
    missingAuth: () => requests.filter((r) => !r.hasAuthHeader),

    /* フォルダ作成の検証用。 */
    creates: () => requests.filter((r) => r.method === 'POST' && r.path.endsWith('/files') && !r.isUpload),
    /* 本文つきファイル作成（サンプルファイル）の検証用。 */
    uploads: () => requests.filter((r) => r.method === 'POST' && r.isUpload),
    /* POST 以外の書き込み（PUT / PATCH / DELETE）が1件でもあれば異常。 */
    forbiddenWrites: () => requests.filter((r) => ['PUT', 'PATCH', 'DELETE'].includes(r.method)),
  };
}
