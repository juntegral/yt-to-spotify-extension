// deferred-playlist.test.js — 지연 생성 검증.
// 핵심: 변환 done 시점엔 재생목록이 없어야 하고(쓰레기값 방지), 검토 해소는 로컬만,
// CREATE_PLAYLIST 시점에 added 전체가 "원래 트랙리스트 순서"로 한 번에 실린다.
// fetch·storage 전부 목 → 실제 Spotify 호출 0회.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../src/background/service-worker.js'), 'utf8');
src = src.replace(/^importScripts\([^\n]*\);?\s*$/m, '// [test] importScripts stripped');

function makeStorage(initial) {
  let store = JSON.parse(JSON.stringify(initial || {}));
  return {
    _get: (k) => store[k],
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
  const storage = makeStorage({ accessToken: 'tok', expiresAt: NOW + 100000, spotifyProfile: { id: 'me' }, convertState });
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
    const method = (init && init.method) || 'GET';
    let body = null; try { body = JSON.parse((init && init.body) || 'null'); } catch (e) {}
    calls.push({ url, method, body });
    if (method === 'GET' && url.includes('/me/playlists')) {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ items: [] }) });
    }
    if (method === 'POST' && url.endsWith('/me/playlists')) {
      return Promise.resolve({ ok: true, status: 201, headers: { get: () => null }, json: async () => ({ id: 'NEWPL', external_urls: { spotify: 'https://open.spotify.com/playlist/NEWPL' } }) });
    }
    return Promise.resolve({ ok: true, status: 201, headers: { get: () => null }, json: async () => ({ snapshot_id: 's' }) });
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'service-worker.js' });
  return { sandbox, storage, calls };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const urisOf = (a) => a.map((x) => x.resolvedUri || (x.track && x.track.uri));

(async () => {
  // 기준 상태: 매칭 done, 재생목록 미생성. 자동 슬롯 0·2·4, 검토 1·3, 못찾음 7.
  const base = () => ({
    status: 'done', videoTitle: '테스트 모음', videoUrl: 'https://youtu.be/x', playlistId: null, playlistUrl: null,
    added: [{ id: 'e0', track: { uri: 'u0' } }, { id: 'e2', track: { uri: 'u2' } }, { id: 'e4', track: { uri: 'u4' } }],
    review: [{ id: 'e1', candidates: [] }, { id: 'e3', candidates: [] }],
    notFound: [{ id: 'e7', candidates: [] }],
    skipped: [],
  });

  console.log('A) 생성 전 검토 해소 = 로컬만 (Spotify 호출 0회), 슬롯 순서 유지 + 아트 보존');
  {
    const { sandbox, storage, calls } = load(base());
    await sandbox.resolveReview('e3', 'u3', { uri: 'u3', name: '祝祭', image: 'https://img/art3.jpg', artists: ['RADWIMPS'], durationMs: 301000 });
    await sandbox.resolveReview('e1', 'u1'); // track 미전달 → 후보 목록에서 복원 시도(후보 없음 → undefined)
    await sandbox.resolveReview('e7', 'u7');
    ok(calls.length === 0, 'fetch 0회 (재생목록 없음 → 전부 로컬)');
    const st = storage._get('convertState');
    ok(JSON.stringify(urisOf(st.added)) === JSON.stringify(['u0', 'u1', 'u2', 'u3', 'u4', 'u7']),
      'added가 원래 순서로 축적 → ' + urisOf(st.added).join(','));
    const e3 = st.added.find((x) => x.id === 'e3');
    ok(e3.track && e3.track.image === 'https://img/art3.jpg', '선택 후보의 앨범아트가 added에 저장됨');
  }

  console.log("A') track 미전달 시 후보 목록에서 uri로 복원");
  {
    const withCand = base();
    withCand.review[0] = { id: 'e1', candidates: [{ uri: 'u1', name: 'なんでもないや', image: 'https://img/art1.jpg' }] };
    const { sandbox, storage } = load(withCand);
    await sandbox.resolveReview('e1', 'u1'); // track 안 넘김
    const e1 = storage._get('convertState').added.find((x) => x.id === 'e1');
    ok(e1.track && e1.track.image === 'https://img/art1.jpg', '후보 목록에서 track 자동 복원');
  }

  console.log('B) 생성 전 되돌리기 = 로컬만 (DELETE 없음)');
  {
    const { sandbox, storage, calls } = load(base());
    await sandbox.resolveReview('e1', 'u1');
    await sandbox.undoResolve();
    ok(!calls.some((c) => c.method === 'DELETE'), 'DELETE 호출 없음');
    const st = storage._get('convertState');
    ok(st.review.some((x) => x.id === 'e1'), 'e1이 검토로 복원');
    ok(urisOf(st.added).join(',') === 'u0,u2,u4', 'added 원상복구');
  }

  console.log('C) CREATE_PLAYLIST — 그 시점 added 전체를 원래 순서로 일괄 생성');
  {
    const { sandbox, storage, calls } = load(base());
    await sandbox.resolveReview('e3', 'u3');
    await sandbox.resolveReview('e1', 'u1');
    calls.length = 0;
    const st = await sandbox.createPlaylist();
    const creates = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/me/playlists'));
    const adds = calls.filter((c) => c.method === 'POST' && /\/playlists\/NEWPL\/items$/.test(c.url));
    ok(creates.length === 1, '재생목록 생성 POST 1회');
    ok(adds.length === 1 && JSON.stringify(adds[0].body.uris) === JSON.stringify(['u0', 'u1', 'u2', 'u3', 'u4']),
      '곡 일괄 추가 = 원래 순서 u0..u4');
    ok(adds[0].body.position === undefined, '일괄 추가는 position 불필요(배열 순서 그대로)');
    ok(st.playlistId === 'NEWPL' && /NEWPL/.test(st.playlistUrl), '상태에 playlistId/Url 기록');
    ok(storage._get('convertState').playlistId === 'NEWPL', '저장소에도 반영');

    // 멱등성: 재호출 시 추가 생성 없음
    calls.length = 0;
    await sandbox.createPlaylist();
    ok(calls.length === 0, '재호출 시 API 0회(멱등)');
  }

  console.log('D) 생성 후 남은 검토 해소 = 기존 하이브리드(API position 삽입)');
  {
    const { sandbox, calls } = load(base());
    await sandbox.createPlaylist(); // u0,u2,u4 실림
    calls.length = 0;
    await sandbox.resolveReview('e1', 'u1'); // slot1 → 앞선 슬롯 {0} → position 1
    const add = calls.find((c) => c.method === 'POST' && /items$/.test(c.url));
    ok(!!add && add.body.position === 1 && add.body.uris[0] === 'u1', '생성 후엔 position 1로 API 삽입');
  }

  console.log('E) 빈 added로 생성 시도 → 명확한 에러');
  {
    const { sandbox } = load({ ...base(), added: [] });
    let msg = '';
    try { await sandbox.createPlaylist(); } catch (e) { msg = String(e.message || e); }
    ok(/곡이 없어요|추가/.test(msg), '에러: ' + msg);
  }

  console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
