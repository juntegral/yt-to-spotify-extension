// comment-tracklist.test.js — 고정/상단 댓글 트랙리스트 소스 검증.
// (1) 순수 파서: tracklistFromComments (2) 콘텐츠 스크립트 통합: 설명란·챕터 없음 →
// youtubei/v1/next 목 응답에서 댓글 파싱 → tracks(source:'comment') + musicCards 보존.
// 네트워크·Spotify 호출 0회.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const parse = require('../src/lib/parse-tracklist.js');
const parseSrc = fs.readFileSync(path.join(__dirname, '../src/lib/parse-tracklist.js'), 'utf8');
const contentSrc = fs.readFileSync(path.join(__dirname, '../src/content/youtube-content.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const TRACKLIST_TEXT = '🎵 타임스탬프\n00:00 유우리 - 베텔게우스\n03:56 KK - 달이 아름다워\n08:33 RADWIMPS - Sparkle\n13:18 월피스카터 - 이별만이 인생이다';

// ── 통합용 목 환경 ──
function loadContext(opts) {
  const scripts = [
    { textContent: `var ytInitialData = ${JSON.stringify(opts.embeddedData)};` },
    { textContent: `var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: { shortDescription: opts.desc || '' } })};` },
    { textContent: `(function(){ytcfg.set({"INNERTUBE_API_KEY":"KEY9","INNERTUBE_CLIENT_VERSION":"2.20260601.01.00"});})();` },
  ];
  const fetchCalls = [];
  const sandbox = {
    console, URLSearchParams, JSON, Object, Array, Math, Number, String, Boolean, Set, RegExp,
    window: { __ytSpotifyContentLoaded: true },
    document: {
      title: 'T - YouTube',
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === 'script' ? scripts : []),
    },
    location: { href: `https://www.youtube.com/watch?v=${opts.vid}`, pathname: '/watch', origin: 'https://www.youtube.com', search: `?v=${opts.vid}` },
    fetch: (url, init) => {
      fetchCalls.push({ url, body: init && init.body });
      if (String(url).includes('/youtubei/v1/next')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.nextResponse) });
      }
      return Promise.resolve({ text: () => Promise.resolve('') });
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(parseSrc, sandbox, { filename: 'parse-tracklist.js' });
  vm.runInContext(contentSrc, sandbox, { filename: 'youtube-content.js' });
  return { sandbox, fetchCalls };
}

const dataWithComments = (vid) => ({
  currentVideoEndpoint: { watchEndpoint: { videoId: vid } },
  contents: { list: [
    { itemSectionRenderer: { sectionIdentifier: 'comment-item-section',
      contents: [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOK123' } } } }] } },
    { horizontalCardListRenderer: { cards: [
      { videoAttributeViewModel: { title: 'ベテルギウス', subtitle: 'Yuuri', secondarySubtitle: { content: '壱' } } },
    ] } },
  ] },
});

(async () => {
  console.log('1) 순수 파서 — 첫 트랙리스트 댓글 채택, 잡담 스킵');
  {
    const t = parse.tracklistFromComments(['좋은 노래 감사해요~', TRACKLIST_TEXT, '00:10 가짜']);
    ok(t.length === 4, '4곡 추출');
    ok(t[0].source === 'comment' && t.every((x) => x.source === 'comment'), "source='comment'");
    ok(t[0].label === '유우리 - 베텔게우스' && t[0].seconds === 0, '1번 곡 라벨·초');
    ok(t[2].durationSec === 285, '간격→길이 계산(8:33→13:18=285s)');
    ok(parse.tracklistFromComments(['ㅋㅋ', '최고']).length === 0, '트랙리스트 없으면 []');
  }

  console.log("1') 실측 회귀 — 서두 잡음 타임스탬프('[40:38] 광고 제거')가 있어도 본 리스트 채택");
  {
    // 실제 고정 댓글 패턴: 안내문(큰 타임스탬프) 뒤에 00:00부터 시작하는 진짜 트랙리스트
    const noisy = '광고 제거 ✖[40:38] 리플레이 버튼 🔁눌러주세요!\n\n' + TRACKLIST_TEXT + '\n17:00 마지막 곡 - 끝';
    const t = parse.tracklistFromComments([noisy]);
    ok(t.length === 5, `가장 긴 오름차순 구간 채택 → 5곡 (실제 ${t.length})`);
    ok(t[0].seconds === 0 && /베텔게우스/.test(t[0].label), '1번 곡 = 00:00 유우리 - 베텔게우스');
    ok(!t.some((x) => x.seconds === 2438), '잡음(40:38)은 리스트에서 제외');
  }

  console.log('2) 통합(신형 commentEntityPayload) — 설명란·챕터 없음 → 댓글 소스 + musicCards 보존');
  {
    const nextResponse = { frameworkUpdates: { entityBatchUpdate: { mutations: [
      { payload: { commentEntityPayload: { properties: { content: { content: TRACKLIST_TEXT } }, author: { isCreator: true } } } },
      { payload: { commentEntityPayload: { properties: { content: { content: '잘 듣고 갑니다' } } } } },
    ] } } };
    const { sandbox, fetchCalls } = loadContext({ vid: 'VIDCOMMENT1', embeddedData: dataWithComments('VIDCOMMENT1'), desc: '', nextResponse });
    const info = await sandbox.extractVideoInfo();
    ok(info.tracks.length === 4 && info.tracks[0].source === 'comment', "댓글 소스 4곡 (source='comment')");
    ok(/베텔게우스/.test(info.tracks[0].label), '1번 곡 = 유우리 - 베텔게우스');
    ok(info.musicCards.length === 1, 'musicCards(원제목·정렬 소스) 함께 보존');
    const call = fetchCalls.find((c) => String(c.url).includes('/youtubei/v1/next'));
    ok(!!call && /KEY9/.test(call.url) && /TOK123/.test(call.body), 'next 요청에 페이지 키+토큰 사용');
  }

  console.log('3) 통합(구형 commentRenderer runs) — 동일 동작');
  {
    const nextResponse = { onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: { continuationItems: [
      { commentThreadRenderer: { comment: { commentRenderer: {
        pinnedCommentBadge: {}, authorIsChannelOwner: true,
        contentText: { runs: TRACKLIST_TEXT.split('\n').map((l, i) => ({ text: (i ? '\n' : '') + l })) },
      } } } },
    ] } }] };
    const { sandbox } = loadContext({ vid: 'VIDCOMMENT2', embeddedData: dataWithComments('VIDCOMMENT2'), desc: '', nextResponse });
    const info = await sandbox.extractVideoInfo();
    ok(info.tracks.length === 4 && info.tracks[0].source === 'comment', '구형 포맷도 4곡 추출');
  }

  console.log('4) 설명란이 있으면 댓글 요청 자체를 안 함(비용 0 우선순위)');
  {
    const { sandbox, fetchCalls } = loadContext({
      vid: 'VIDDESC0001', embeddedData: dataWithComments('VIDDESC0001'),
      desc: '00:00 A - a\n03:00 B - b\n06:00 C - c', nextResponse: {},
    });
    const info = await sandbox.extractVideoInfo();
    ok(info.tracks.length === 3 && info.tracks[0].source === undefined, '설명란 소스 우선');
    ok(!fetchCalls.some((c) => String(c.url).includes('/youtubei/v1/next')), '/next 미호출');
  }

  console.log('5) 토큰/키 없음·요청 실패 → 조용히 다음 폴백(musicCards)');
  {
    const data = { currentVideoEndpoint: { watchEndpoint: { videoId: 'VIDNOCOMMENT' } },
      contents: { list: [{ horizontalCardListRenderer: { cards: [
        { videoAttributeViewModel: { title: 'Song', subtitle: 'Artist', secondarySubtitle: { content: 'Al' } } },
      ] } }] } };
    const { sandbox } = loadContext({ vid: 'VIDNOCOMMENT', embeddedData: data, desc: '', nextResponse: {} });
    const info = await sandbox.extractVideoInfo();
    ok(info.tracks.length === 1 && info.tracks[0].source === 'music-card', '댓글 불가 → 음악카드 폴백');
  }

  console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
