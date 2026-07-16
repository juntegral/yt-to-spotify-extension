// token-refresh.test.js — 토큰 갱신/세션 로직 검증. fetch·storage를 전부 목(mock)으로 대체하므로
// 실제 Spotify API 호출은 0회. 실제 service-worker.js 소스를 vm에 로드해 실함수를 테스트한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../src/background/service-worker.js'), 'utf8');
src = src.replace(/^importScripts\([^\n]*\);?\s*$/m, '// [test] importScripts stripped');

function makeStorage(initial) {
  let store = Object.assign({}, initial);
  return {
    _dump: () => store,
    get: async (keys) => {
      if (keys == null) return Object.assign({}, store);
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) { const o = {}; keys.forEach((k) => (o[k] = store[k])); return o; }
      const o = {}; for (const k in keys) o[k] = k in store ? store[k] : keys[k]; return o;
    },
    set: async (obj) => { Object.assign(store, obj); },
    remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); },
  };
}

function load(storageInit) {
  const storage = makeStorage(storageInit || {});
  const fetchCalls = [];
  const sandbox = {
    console, URL, URLSearchParams, TextEncoder, AbortController, Promise, Object, Array, JSON, Math, Number, String, Date,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    btoa, atob, crypto: require('crypto').webcrypto,
    __fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    chrome: {
      runtime: {
        onMessage: { addListener() {} }, onMessageExternal: { addListener() {} },
        getURL: (x) => x, getManifest: () => ({ version: '0.6.0' }), reload() {}, getPlatformInfo(cb) { cb && cb({}); },
      },
      storage: { local: storage },
      identity: { getRedirectURL: () => 'https://test.chromiumapp.org/', launchWebAuthFlow: async () => '' },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      tabs: {},
    },
  };
  sandbox.fetch = (...a) => { fetchCalls.push(a); return sandbox.__fetchImpl(...a); };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'service-worker.js' });
  return { sandbox, storage, fetchCalls, setFetch: (fn) => { sandbox.__fetchImpl = fn; } };
}

// ── 미니 assert ──
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } }
async function throwsWith(fn, re, msg) {
  try { await fn(); fail++; console.log('  ✗ ' + msg + ' (예외가 안 남)'); }
  catch (e) { const m = String(e && e.message || e); ok(re.test(m), msg + ' → "' + m + '"'); }
}
const NOW = Date.now();
const okRes = (body) => ({ ok: true, status: 200, json: async () => body });
const errRes = (status, body) => ({ ok: false, status, json: async () => (body || { error: 'x' }) });

(async () => {
  // A) 유효한 액세스 토큰 → 네트워크 호출 없이 그대로 반환
  console.log('A) 미만료 토큰은 갱신 없이 반환');
  {
    const { sandbox, fetchCalls } = load({ accessToken: 'AAA', expiresAt: NOW + 100000, refreshToken: 'R1' });
    const t = await sandbox.getAccessToken();
    ok(t === 'AAA', '캐시된 액세스 토큰 반환');
    ok(fetchCalls.length === 0, 'fetch 0회 (API 절약)');
  }

  // B) 만료 + 갱신 성공 → 새 토큰 저장, 회전된 리프레시 토큰 저장
  console.log('B) 만료 토큰은 갱신되고 회전 리프레시 토큰이 저장됨');
  {
    const { sandbox, storage, fetchCalls, setFetch } = load({ accessToken: 'OLD', expiresAt: NOW - 1000, refreshToken: 'R1' });
    setFetch(async () => okRes({ access_token: 'NEW', expires_in: 3600, refresh_token: 'R2' }));
    const t = await sandbox.getAccessToken();
    ok(t === 'NEW', '새 액세스 토큰 반환');
    ok(fetchCalls.length === 1, '갱신 fetch 정확히 1회');
    const s = storage._dump();
    ok(s.accessToken === 'NEW', '새 액세스 토큰 저장');
    ok(s.refreshToken === 'R2', '회전된 리프레시 토큰(R2) 저장');
    ok(s.expiresAt > NOW, 'expiresAt 갱신');
  }

  // C) 만료 + 갱신 400(invalid_grant) → 저장 세션 자동 삭제 + 명확한 에러 + 이후 미연결
  console.log('C) invalid_grant(400)면 세션을 비우고 재연결을 유도 (반복 실패 루프 차단)');
  {
    const { sandbox, storage } = load({
      accessToken: 'OLD', expiresAt: NOW - 1000, refreshToken: 'DEAD', spotifyProfile: { id: 'me' },
    });
    sandbox.__fetchImpl = async () => errRes(400, { error: 'invalid_grant' });
    await throwsWith(() => sandbox.getAccessToken(), /연결이 해제|다시 연결/, '400이면 사용자향 재연결 에러');
    const s = storage._dump();
    ok(!s.accessToken && !s.refreshToken && !s.expiresAt && !s.spotifyProfile, '죽은 세션 자동 삭제');
    const auth = await sandbox.getAuthState();
    ok(auth.connected === false, '삭제 후 getAuthState는 미연결 보고');
  }

  // D) 만료 상태에서 동시 5회 호출 → 갱신 fetch는 단 1회 (회전 토큰 이중 사용 방지)
  console.log('D) 동시 갱신은 단일 in-flight로 직렬화됨 (회전 토큰 이중 사용 방지)');
  {
    const { sandbox, fetchCalls, setFetch } = load({ accessToken: 'OLD', expiresAt: NOW - 1000, refreshToken: 'R1' });
    setFetch(() => new Promise((r) => setTimeout(() => r(okRes({ access_token: 'NEW', expires_in: 3600, refresh_token: 'R2' })), 20)));
    const results = await Promise.all(Array.from({ length: 5 }, () => sandbox.getAccessToken()));
    ok(fetchCalls.length === 1, '5회 동시 호출에도 갱신 fetch는 1회');
    ok(results.every((t) => t === 'NEW'), '모든 호출이 동일한 새 토큰 수신');
  }

  // E) getAuthState 로컬 판정 (API 호출 0회)
  console.log('E) getAuthState는 로컬만으로 연결 여부 판정 (할당량 보호)');
  {
    let r = load({ accessToken: 'A', expiresAt: NOW + 100000 });
    ok((await r.sandbox.getAuthState()).connected === true, 'E1 미만료 토큰 → 연결');
    r = load({ accessToken: 'A', expiresAt: NOW - 1000, refreshToken: 'R' });
    ok((await r.sandbox.getAuthState()).connected === true, 'E2 만료+리프레시 있음 → 연결(갱신 가능)');
    r = load({ accessToken: 'A', expiresAt: NOW - 1000 });
    ok((await r.sandbox.getAuthState()).connected === false, 'E3 만료+리프레시 없음 → 미연결');
    r = load({});
    ok((await r.sandbox.getAuthState()).connected === false, 'E4 토큰 없음 → 미연결');
    ok(r.fetchCalls.length === 0, 'getAuthState는 fetch 0회');
  }

  console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
