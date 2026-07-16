// spa-fresh-scan.test.js — SPA stale 대응 스캔 로직 검증.
// 네트워크/스포티파이 호출 0회: document/location/fetch를 전부 목으로 대체하고
// 실제 parse-tracklist.js + youtube-content.js 소스를 vm에 로드해 실함수를 테스트한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const parseSrc = fs.readFileSync(path.join(__dirname, '../src/lib/parse-tracklist.js'), 'utf8');
const contentSrc = fs.readFileSync(path.join(__dirname, '../src/content/youtube-content.js'), 'utf8');

function loadContext(opts) {
  const scripts = [{ textContent: `var ytInitialData = ${JSON.stringify(opts.embeddedData)};` }];
  if (opts.embeddedShortDesc != null) {
    scripts.push({ textContent: `var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: { shortDescription: opts.embeddedShortDesc } })};` });
  }
  const fetchCalls = [];
  const sandbox = {
    console, URLSearchParams, JSON, Object, Array, Math, Number, String, Boolean, Set, RegExp,
    window: { __ytSpotifyContentLoaded: true }, // 리스너 등록 블록 건너뜀(chrome 불필요)
    document: {
      title: (opts.title || 'Test') + ' - YouTube',
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === 'script' ? scripts : []),
    },
    location: {
      href: `https://www.youtube.com/watch?v=${opts.currentVid}`,
      pathname: '/watch', origin: 'https://www.youtube.com', search: `?v=${opts.currentVid}`,
    },
    fetch: (...a) => {
      fetchCalls.push(a);
      if (opts.fetchThrows) return Promise.reject(new Error('network'));
      let html = `<!doctype html><html><head></head><body>`;
      html += `<script>var ytInitialData = ${JSON.stringify(opts.fetchData)};</script>`;
      html += `<script>var ytInitialPlayerResponse = {"videoDetails":{"shortDescription":${JSON.stringify(opts.fetchShortDesc || '')}}};</script>`;
      html += `</body></html>`;
      return Promise.resolve({ text: () => Promise.resolve(html) });
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(parseSrc, sandbox, { filename: 'parse-tracklist.js' });
  vm.runInContext(contentSrc, sandbox, { filename: 'youtube-content.js' });
  return { sandbox, fetchCalls };
}

const vidEndpoint = (id, extra) => Object.assign({ currentVideoEndpoint: { watchEndpoint: { videoId: id } } }, extra || {});
const chapters3 = { chaptersHolder: [
  { chapterRenderer: { title: { simpleText: 'Aimer - 육등성의 밤' }, timeRangeStartMillis: 0 } },
  { chapterRenderer: { title: { simpleText: '요네즈 켄시 - 바다의 유령' }, timeRangeStartMillis: 180000 } },
  { chapterRenderer: { title: { simpleText: '마후마후 - RAIN' }, timeRangeStartMillis: 360000 } },
] };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

(async () => {
  // 1) 브레이스 매처: 문자열 안의 '};' 에 속지 않는다
  console.log('1) parseYtInitialDataFromText — 문자열 내부 };에 오절단되지 않음');
  {
    const { sandbox } = loadContext({ currentVid: 'AAAAAAAAAAA', embeddedData: vidEndpoint('AAAAAAAAAAA') });
    const parsed = sandbox.parseYtInitialDataFromText('var ytInitialData = {"t":"a};b","v":{"x":1}};\nvar other=9;');
    ok(parsed && parsed.t === 'a};b' && parsed.v.x === 1, '문자열 내 };와 뒤따르는 코드에도 정확히 파싱');
  }

  // 2) 풀 로드(임베드 videoId == 현재) → 재요청 없이 임베드 사용
  console.log('2) 풀 로드: 임베드가 현재 영상과 일치 → fetch 0회');
  {
    const { sandbox, fetchCalls } = loadContext({
      currentVid: 'FULLLOAD123', embeddedData: vidEndpoint('FULLLOAD123'),
      embeddedShortDesc: '00:00 A - a\n03:00 B - b\n06:00 C - c',
    });
    const info = await sandbox.extractVideoInfo();
    ok(info.dataSource === 'embedded', "source가 'embedded'");
    ok(fetchCalls.length === 0, '재요청 fetch 0회(빠른 경로)');
    ok(info.tracks.length === 3, '임베드 설명란에서 3곡');
  }

  // 3) 핵심: SPA stale → 재요청으로 "현재 영상" 신선 데이터. 이전 영상 트랙 누출 없음.
  console.log('3) SPA stale: 이전 영상 데이터가 DOM에 남아도 결과는 현재 영상(재요청)');
  {
    const { sandbox, fetchCalls } = loadContext({
      currentVid: 'NEWVIDaaaaa',
      embeddedData: vidEndpoint('OLDVIDzzzzz'),                       // DOM엔 이전 영상
      embeddedShortDesc: '00:00 STALE ONE - x\n03:00 STALE TWO - y\n06:00 STALE THREE - z',
      fetchData: vidEndpoint('NEWVIDaaaaa'),                          // 재요청은 현재 영상
      fetchShortDesc: '00:00 유우리 - 베텔게우스\n03:56 KK - 달이 아름다워\n08:33 RADWIMPS - Sparkle',
    });
    const info = await sandbox.extractVideoInfo();
    ok(info.dataSource === 'refetch', "source가 'refetch'");
    ok(info.videoId === 'NEWVIDaaaaa', '현재 videoId 반영');
    ok(fetchCalls.length === 1, '재요청 fetch 정확히 1회');
    ok(info.tracks.length === 3 && /유우리/.test(info.tracks[0].label), '현재 영상 트랙(유우리…) 반환');
    ok(!info.tracks.some((t) => /STALE/.test(t.label)), '이전 영상(STALE) 트랙 누출 없음');
  }

  // 4) SPA stale + 설명란 없음 + 챕터 → Method B(챕터)도 재요청으로 신선
  console.log('4) SPA stale: 설명란 없고 챕터만 → 챕터도 현재 영상 기준(재요청)');
  {
    const { sandbox } = loadContext({
      currentVid: 'CHAPVIDbbbb',
      embeddedData: vidEndpoint('OLDVIDzzzzz'),
      embeddedShortDesc: '',
      fetchData: vidEndpoint('CHAPVIDbbbb', chapters3),
      fetchShortDesc: '',                                            // 설명란 트랙리스트 없음
    });
    const info = await sandbox.extractVideoInfo();
    ok(info.dataSource === 'refetch', "source가 'refetch'");
    ok(info.tracks.length === 3 && info.tracks[0].source === 'chapter', '챕터 3곡 추출');
    ok(/Aimer/.test(info.tracks[0].label), '현재 영상 챕터 라벨');
  }

  // 5) 재요청 실패(네트워크) → 폴백. 크래시 없이 임베드로 degrade.
  console.log('5) 재요청 실패 → 안전 폴백(크래시 없음)');
  {
    const { sandbox } = loadContext({
      currentVid: 'NETFAILcccc', embeddedData: vidEndpoint('OLDVIDzzzzz'),
      embeddedShortDesc: '00:00 A - a\n03:00 B - b\n06:00 C - c', fetchThrows: true,
    });
    const info = await sandbox.extractVideoInfo();
    ok(info.dataSource === 'fallback', "source가 'fallback'");
    ok(Array.isArray(info.tracks), 'tracks 배열 반환(크래시 없음)');
  }

  console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
