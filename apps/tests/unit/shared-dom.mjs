/*
 * ブラウザ側の経路（localStorage / sessionStorage / カスタムイベント）を
 * 最小のシムで検証する。実ブラウザでの挙動に合わせている。
 */

import { check, section, finish, fatal } from '../helpers/assert.mjs';
import { sharedUrl } from '../helpers/env.mjs';

/* 絶対パスを書かない。リポジトリのどこへ置いても動くようにする。 */
const url = (name) => sharedUrl(name);


/* ---- シム ---- */

function createStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get size() { return map.size; },
    dump: () => Object.fromEntries(map),
  };
}

globalThis.localStorage = createStorage();
globalThis.sessionStorage = createStorage();

const target = new EventTarget();
globalThis.document = {
  readyState: 'complete',
  addEventListener: (...a) => target.addEventListener(...a),
  removeEventListener: (...a) => target.removeEventListener(...a),
  dispatchEvent: (e) => target.dispatchEvent(e),
};

/* ---- 検証 ---- */

section("1. bootstrap の自動起動");

const readyEvents = [];
globalThis.document.addEventListener('tsam-shared-ready', (e) => readyEvents.push(e.detail));

const shared = await import(url('bootstrap.js'));

check('tsam-shared-ready が1回発行される', readyEvents.length === 1, `count=${readyEvents.length}`);
check('detail に profile / ai がある',
  readyEvents[0] && 'profile' in readyEvents[0] && 'ai' in readyEvents[0]);
check('初期はプロフィール未登録', readyEvents[0].profile === null);
check('初期モードは free', readyEvents[0].ai.mode === 'free');
check('detail にAPIキー実値が無い', !JSON.stringify(readyEvents[0]).includes('AIza'));
check('startShared の二重呼び出しは無害', shared.startShared() !== null && readyEvents.length === 1);

section("2. プロフィールのキャッシュとイベント");

const ps = shared.profileStore;
const profileEvents = [];
globalThis.document.addEventListener('tsam-profile-change', (e) => profileEvents.push(e.detail));

check('未登録', ps.hasRegisteredProfile() === false);

const doc = ps.buildProfileDocument(
  { displayName: '山田 太郎', company: '株式会社テスト' },
  { sub: 'sub-abc' },
);

check('キャッシュ書き込み成功', ps.writeCachedProfile(doc) === true);
check('tsam-profile-change が発行される', profileEvents.length === 1);
check('登録済みになる', ps.hasRegisteredProfile() === true);
check('読み戻せる', ps.readCachedProfile().profile.displayName === '山田 太郎');
check('localStorage のキーは1つ',
  Object.keys(globalThis.localStorage.dump()).join(',') === 'tsam-ai-profile-cache',
  Object.keys(globalThis.localStorage.dump()).join(','));

globalThis.localStorage.setItem('tsam-ai-profile-cache', '{壊れたJSON');
check('壊れたキャッシュは null を返す', ps.readCachedProfile() === null);
check('壊れたキャッシュは自動削除される',
  globalThis.localStorage.getItem('tsam-ai-profile-cache') === null);

ps.writeCachedProfile(doc);
globalThis.localStorage.setItem(
  'tsam-ai-profile-cache',
  JSON.stringify({ ...doc, v: 99 }),
);
check('バージョン違いも破棄される', ps.readCachedProfile() === null);

section("3. AI設定の保存先の切り替え");

const ac = shared.aiConfig;
const configEvents = [];
globalThis.document.addEventListener('tsam-ai-config-change', (e) => configEvents.push(e.detail));

const KEY = `AIza${'a'.repeat(31)}wxyz`;

check('モード変更', ac.setAiMode('my-key') === true && ac.getAiMode() === 'my-key');
check('モード変更が通知される', configEvents.length === 1);

const saved = ac.setApiKey(KEY);
check('キー保存成功', saved.ok === true);
check('既定は sessionStorage',
  globalThis.sessionStorage.getItem('tsam-ai-gemini-key') === KEY
  && globalThis.localStorage.getItem('tsam-ai-gemini-key') === null);
check('hasApiKey', ac.hasApiKey() === true);
check('getAiConfig にキー実値が無い', !JSON.stringify(ac.getAiConfig()).includes('AIza'));

ac.setApiKey(KEY, { persist: 'local' });
check('localStorage へ移動', globalThis.localStorage.getItem('tsam-ai-gemini-key') === KEY);
check('sessionStorage に残さない',
  globalThis.sessionStorage.getItem('tsam-ai-gemini-key') === null);
check('保存先が記録される', ac.getKeyPersist() === 'local');

ac.setApiKey(KEY, { persist: 'session' });
check('sessionStorage へ戻す',
  globalThis.sessionStorage.getItem('tsam-ai-gemini-key') === KEY
  && globalThis.localStorage.getItem('tsam-ai-gemini-key') === null);

const rejected = ac.setApiKey('bogus');
check('不正キーは保存しない', rejected.ok === false && ac.getApiKey() === KEY);

ac.clearApiKey();
check('削除で両方から消える',
  globalThis.sessionStorage.getItem('tsam-ai-gemini-key') === null
  && globalThis.localStorage.getItem('tsam-ai-gemini-key') === null);
check('保存先の記録も消える',
  globalThis.localStorage.getItem('tsam-ai-key-persist') === null);

section("4. subscribeAiConfig");

const seen = [];
const unsubscribe = ac.subscribeAiConfig((c) => seen.push(c.mode));
check('購読直後に現在値で1回呼ばれる', seen.length === 1 && seen[0] === 'my-key', seen.join(','));

ac.setAiMode('free');
check('変更で呼ばれる', seen.length === 2 && seen[1] === 'free', seen.join(','));

unsubscribe();
ac.setAiMode('my-key');
check('解除後は呼ばれない', seen.length === 2);

section("5. アカウント切り替えでキャッシュを捨てる");

globalThis.sessionStorage.setItem('tsam-ai-google-profile', JSON.stringify({
  v: 1,
  sub: 'sub-OTHER',
  name: '別の人',
  email: 'other@example.com',
  picture: null,
  emailVerified: true,
  expiresAt: Date.now() + 3600000,
}));

ps.writeCachedProfile(doc); /* sub-abc のプロフィール */
check('別アカウントのキャッシュを検出して破棄',
  ps.dropCacheForOtherAccount() === true && ps.readCachedProfile() === null);

globalThis.sessionStorage.setItem('tsam-ai-google-profile', JSON.stringify({
  v: 1,
  sub: 'sub-abc',
  name: '山田 太郎',
  email: 'taro@example.com',
  picture: null,
  emailVerified: true,
  expiresAt: Date.now() + 3600000,
}));

ps.writeCachedProfile(doc);
check('同一アカウントなら破棄しない',
  ps.dropCacheForOtherAccount() === false && ps.readCachedProfile() !== null);
check('同一アカウントは登録済み判定', ps.hasRegisteredProfile() === true);

section("6. 全ストレージの最終状態（想定キーのみ）");
const allKeys = [
  ...Object.keys(globalThis.localStorage.dump()),
  ...Object.keys(globalThis.sessionStorage.dump()),
].sort();
console.log(`  keys: ${allKeys.join(', ')}`);
check('想定外のキーが無い',
  allKeys.every((k) => [
    'tsam-ai-profile-cache', 'tsam-ai-mode', 'tsam-ai-key-persist',
    'tsam-ai-gemini-key', 'tsam-ai-google-profile',
  ].includes(k)));
check('APIキーはどこにも残っていない',
  !JSON.stringify({ ...globalThis.localStorage.dump(), ...globalThis.sessionStorage.dump() }).includes('AIza'));

finish();
