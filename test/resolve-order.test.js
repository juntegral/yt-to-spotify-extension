// resolve-order.test.js — 검토/못찾음 곡을 추가할 때 "추가한 순서"가 아니라
// "원래 트랙리스트 순서"대로 재생목록에 삽입되는지 검증. fetch·storage 목 → 실제 Spotify 호출 0.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../src/background/service-worker.js'), 'utf8');
src = src.replace(/^importScripts\([^\n]*\);?\s*$/m, '// [test] importScripts stripped');

function makeStorage(initial) {
  let store = JSON.parse(JSON.stringify(initial || {}));
  return {
    _get: (k) => store[k],
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
  const storage = makeStorage({
    accessToken: 'tok', expiresAt: NOW + 100000, spotifyProfile: { id: 'me', country: 'US' },
    convertState,
  });
  const posts = [];
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
    let body = null; try { body = JSON.parse((init && init.body) || 'null'); } catch (e) {}
    if (init && init.method === 'POST') posts.push({ url, body });
    return Promise.resolve({ ok: true, status: 201, headers: { get: () => null }, json: async () => ({ snapshot_id: 's' }) });
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'service-worker.js' });
  return { sandbox, storage, posts };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const urisOf = (added) => added.map((a) => (a.resolvedUri || (a.track && a.track.uri) || '?'));

(async () => {
  // 시나리오: 자동 추가된 슬롯 0·2·4 (id만, slot 필드 없음 → id 파싱 경로 = 현재 라이브 변환과 동일)
  console.log('A) 검토/못찾음 곡을 순서 뒤죽박죽으로 추가해도 원래 슬롯 순서로 삽입');
  {
    const { sandbox, storage, posts } = load({
      status: 'done', playlistId: 'PL',
      added: [{ id: 'e0', track: { uri: 'u0' } }, { id: 'e2', track: { uri: 'u2' } }, { id: 'e4', track: { uri: 'u4' } }],
      review: [{ id: 'e1', candidates: [{ uri: 'c1' }] }, { id: 'e3', candidates: [{ uri: 'c3' }] }],
      notFound: [{ id: 'e7', candidates: [] }],
      skipped: [],
    });
    // 일부러 순서 뒤죽박죽: e3 먼저, 그다음 e1, 마지막 e7
    await sandbox.resolveReview('e3', 'u3');
    await sandbox.resolveReview('e1', 'u1');
    await sandbox.resolveReview('e7', 'u7');

    // 각 POST의 position 확인 (원래 슬롯 기준)
    ok(posts.length === 3, 'POST 3회');
    ok(posts[0].body.position === 2, "e3 → position 2 (앞선 슬롯 0·2 뒤)"); // added=[0,2,4], slot<3 → {0,2}=2
    ok(posts[1].body.position === 1, "e1 → position 1 (앞선 슬롯 0 뒤)");   // added=[0,2,3,4], slot<1 → {0}=1
    ok(posts[2].body.position === 5, "e7 → position 5 (맨 끝)");            // added=[0,1,2,3,4], slot<7 → 5
    ok(posts.every((p) => Array.isArray(p.body.uris) && p.body.uris.length === 1), '각 POST는 uri 1개');

    const added = storage._get('convertState').added;
    ok(JSON.stringify(urisOf(added)) === JSON.stringify(['u0', 'u1', 'u2', 'u3', 'u4', 'u7']),
      'st.added 최종 순서 = 원래 슬롯 순서 u0,u1,u2,u3,u4,u7 → ' + urisOf(added).join(','));
    const cs = storage._get('convertState');
    ok(cs.review.length === 0 && cs.notFound.length === 0, '검토·못찾음 비워짐');
  }

  // B) 명시적 slot 필드가 있으면 그것을 우선 사용
  console.log('B) 명시적 slot 우선 + 건너뛰기는 재생목록 미변경');
  {
    const { sandbox, storage, posts } = load({
      status: 'done', playlistId: 'PL',
      added: [{ id: 'x-a', slot: 0, track: { uri: 'u0' } }, { id: 'x-b', slot: 5, track: { uri: 'u5' } }],
      review: [{ id: 'x-c', slot: 2, candidates: [{ uri: 'c2' }] }],
      notFound: [{ id: 'x-d', slot: 9, candidates: [] }],
      skipped: [],
    });
    await sandbox.resolveReview('x-c', 'u2');       // slot 2 → 앞선 슬롯 0 뒤 = position 1
    ok(posts[0].body.position === 1, 'slot 2 → position 1');
    await sandbox.resolveReview('x-d', null);        // 건너뛰기: POST 없음, skipped로
    ok(posts.length === 1, '건너뛰기는 재생목록 POST 안 함');
    const cs = storage._get('convertState');
    ok(JSON.stringify(urisOf(cs.added)) === JSON.stringify(['u0', 'u2', 'u5']), '추가 순서 u0,u2,u5');
    ok((cs.skipped || []).some((x) => x.id === 'x-d'), '건너뛴 항목은 skipped에 기록');
  }

  console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
