// reset-convert.test.js — 초기화(RESET_CONVERT) 검증: 재생목록 언팔로우 + 로컬 상태 삭제.
// fetch·storage 목 → 실제 Spotify 호출 0. (언팔로우는 200 빈 본문을 반환 → 관용 처리도 검증)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../src/background/service-worker.js'), 'utf8');
src = src.replace(/^importScripts\([^\n]*\);?\s*$/m, '// [test] importScripts stripped');

function makeStorage(initial) {
  let store = JSON.parse(JSON.stringify(initial || {}));
  return {
    _has: (k) => k in store,
    get: async (keys) => {
      if (keys == null) return JSON.parse(JSON.stringify(store));
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) { const o = {}; keys.forEach((k) => (o[k] = store[k])); return o; }
      const o = {}; for (const k in keys) o[k] = k in store ? store[k] : keys[k]; return o;
    },
    set: async (obj) => { Object.assign(store, obj); },
    remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); },
  };
}

function load(convertState) {
  const NOW = Date.now();
  const storage = makeStorage({ accessToken: 'tok', expiresAt: NOW + 100000, spotifyProfile: { id: 'me' }, convertState, convertTabId: 42, spSearchCache: { 'track|10|q': { v: [], t: 1 } } });
  const calls = [];
  const sandbox = {
    console, URL, URLSearchParams, TextEncoder, AbortController, Promise, Object, Array, JSON, Math, Number, String, RegExp, Set, Date,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, btoa, atob, crypto: require('crypto').webcrypto,
    chrome: {
      runtime: { onMessage: { addListener() {} }, onMessageExternal: { addListener() {} }, getURL: (x) => x, getManifest: () => ({ version: '0.7' }), getPlatformInfo(cb) { cb && cb({}); } },
      storage: { local: storage },
      identity: { getRedirectURL: () => 'https://t.chromiumapp.org/' },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      tabs: {},
    },
  };
  sandbox.fetch = (url, init) => {
    calls.push({ url, method: (init && init.method) || 'GET' });
    // 언팔로우(DELETE /followers)는 200 + 빈 본문 → json()이 throw 하도록
    if ((init && init.method) === 'DELETE') {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('empty body'); } });
    }
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) });
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'service-worker.js' });
  return { sandbox, storage, calls };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

(async () => {
  // A) 재생목록 있음 → 언팔로우 DELETE + 로컬 삭제
  console.log('A) playlistId 있으면 언팔로우 + 로컬 상태 삭제');
  {
    const { sandbox, storage, calls } = load({ status: 'done', playlistId: 'PL9', added: [], review: [], notFound: [] });
    const r = await sandbox.resetConvert();
    const del = calls.find((c) => c.method === 'DELETE');
    ok(!!del && /\/playlists\/PL9\/followers$/.test(del.url), 'DELETE /playlists/PL9/followers 호출');
    ok(r.playlistRemoved === true, 'playlistRemoved=true (200 빈 본문에도 예외 없이)');
    ok(!storage._has('convertState'), 'convertState 삭제됨');
    ok(!storage._has('convertTabId'), 'convertTabId 삭제됨');
    ok(!storage._has('spSearchCache'), '검색 캐시(spSearchCache)도 삭제됨');
  }

  // B) 재생목록 없음(초기 에러 등) → 언팔로우 안 함, 그래도 로컬 삭제
  console.log('B) playlistId 없으면 언팔로우 없이 로컬만 삭제');
  {
    const { sandbox, storage, calls } = load({ status: 'error', playlistId: null, error: 'x' });
    const r = await sandbox.resetConvert();
    ok(!calls.some((c) => c.method === 'DELETE'), 'DELETE 호출 없음');
    ok(r.playlistRemoved === false, 'playlistRemoved=false');
    ok(!storage._has('convertState'), 'convertState 삭제됨');
  }

  // C) 언팔로우 API 실패해도 로컬 초기화는 진행(best-effort)
  console.log('C) 언팔로우 실패해도 로컬 초기화는 보장');
  {
    const { sandbox, storage } = load({ status: 'done', playlistId: 'PLx' });
    sandbox.fetch = (url, init) => (init && init.method) === 'DELETE'
      ? Promise.resolve({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: { message: 'boom' } }) })
      : Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) });
    const r = await sandbox.resetConvert();
    ok(r.playlistRemoved === false, '실패 → playlistRemoved=false');
    ok(!storage._has('convertState'), '실패해도 convertState는 삭제됨');
  }

  console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
