// manual-search.test.js — 수동검색의 이름·가수·길이 스코어링 검증.
// 실제 matching.js(scoreCandidate) + service-worker.js(manualSearch)를 vm에 로드,
// fetch는 검색 API 모양 그대로 목 → 실제 Spotify 호출 0회.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const matchingSrc = fs.readFileSync(path.join(__dirname, '../src/lib/matching.js'), 'utf8');
let swSrc = fs.readFileSync(path.join(__dirname, '../src/background/service-worker.js'), 'utf8');
swSrc = swSrc.replace(/^importScripts\([^\n]*\);?\s*$/m, '// [test] importScripts stripped');

// Spotify /search 응답 목 (API 원형 → simplify가 소화하는 형태)
const track = (id, name, artist, sec, album) => ({
  uri: `spotify:track:${id}`, id, name,
  artists: [{ name: artist, id: 'a-' + artist }],
  duration_ms: sec * 1000, popularity: 50, external_ids: { isrc: 'X' + id },
  album: { name: album || name, album_type: 'single', release_date: '2021-01-01', artists: [{ name: artist }], images: [{ url: 'img' }] },
});
// 쿼리별 결과 시나리오
const RESULTS = {
  raw: [ // 원문 "Yuuri - ベテルギウス" 검색: 원곡(길이 일치) + 피아노 커버(길이 불일치)
    track('orig', 'ベテルギウス', 'Yuuri', 232),
    track('cover', 'ベテルギウス (Piano Cover)', 'CoverLab', 180, 'Piano Covers'),
  ],
  field: [ // 필드 지정 검색에서만 나오는 로마자 표기 후보
    track('roman', 'BETELGEUSE', 'Yuuri', 292, 'BETELGEUSE'),
  ],
};

function makeStorage(initial) {
  let store = JSON.parse(JSON.stringify(initial || {}));
  return {
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
  const storage = makeStorage({ accessToken: 'tok', expiresAt: NOW + 100000, spotifyProfile: { id: 'me', country: 'KR' }, convertState });
  const queries = [];
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
  sandbox.fetch = (url) => {
    const q = decodeURIComponent((url.match(/[?&]q=([^&]*)/) || [])[1] || '');
    queries.push(q);
    const items = q.startsWith('track:"') ? RESULTS.field : RESULTS.raw;
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ tracks: { items } }) });
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(matchingSrc, sandbox, { filename: 'matching.js' });
  vm.runInContext(swSrc, sandbox, { filename: 'service-worker.js' });
  return { sandbox, queries };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

(async () => {
  console.log('A) "아티스트 - 곡" + itemId(길이 문맥) → 길이·이름·가수 종합 정렬');
  {
    const { sandbox, queries } = load({
      status: 'done',
      review: [{ id: 'e5', label: '유우리 - 베텔게우스', durationSec: 233 }], // 타임스탬프 간격 3:53
      notFound: [], added: [],
    });
    const res = await sandbox.manualSearch('Yuuri - ベテルギウス', 'e5');
    ok(queries.length === 3, '쿼리 3종(원문 + 필드 양방향) 실행 → ' + queries.length);
    ok(res.length === 3, '중복 없이 3후보 병합');
    ok(res[0].id === 'orig', '1위 = 원곡(제목·가수·길이 모두 일치) → ' + res[0].id);
    ok(res[0]._durMatch === true, '원곡에 길이 일치(±4s) 배지');
    ok(res.find((c) => c.id === 'cover')._durMatch === false, '커버(180s)는 길이 불일치');
    const covScore = res.find((c) => c.id === 'cover')._score;
    ok(res[0]._score > covScore, `커버는 페널티+길이로 하위 (${res[0]._score} > ${covScore})`);
    ok(res.some((c) => c.id === 'roman'), '필드 검색 전용 후보(로마자)도 풀에 포함');
  }

  console.log('B) itemId 없이(문맥 없음) → 길이 배지 없음, 검색은 동작');
  {
    const { sandbox } = load({ status: 'done', review: [], notFound: [], added: [] });
    const res = await sandbox.manualSearch('Yuuri - ベテルギウス');
    ok(res.length === 3, '3후보 반환');
    ok(res.every((c) => !c._durMatch), '길이 문맥 없음 → _durMatch 전부 false');
  }

  console.log('C) 단일어 쿼리(하이픈 없음) → 원문 검색만, 정상 동작');
  {
    const { sandbox, queries } = load({ status: 'done', review: [], notFound: [], added: [] });
    const res = await sandbox.manualSearch('ベテルギウス');
    ok(queries.length === 1, '필드 쿼리 생략(1회만)');
    ok(res.length === 2, '원문 결과 2후보');
  }

  console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
