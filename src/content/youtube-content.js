// youtube-content.js — 유튜브 영상 페이지에서 제목/채널/트랙리스트 추출.
// 소스 우선순위: 설명란 타임스탬프 → 챕터 → 자동 "음악" 카드 → DOM.
//
// ⚠️ SPA 내비게이션 대응 (스캔이 "가끔" 안 되던 원인):
//   유튜브는 영상→영상 이동 시 페이지를 리로드하지 않는다. 그래서 HTML에 박힌
//   <script>var ytInitialData = {...}</script> 태그는 "최초 로드된 영상"에 고정(stale)되고,
//   SPA로 이동한 뒤 이 태그를 읽으면 이전 영상의 챕터/음악카드/설명란을 긁게 된다
//   (→ 이전 영상 트랙리스트가 나오거나, videoId 가드에 걸려 0곡).
//   해결: 임베드 데이터의 videoId가 현재 URL과 다르면(=SPA 이동) 현재 watch URL을
//   same-origin 재요청해 "현재 영상"의 신선한 데이터를 확보한다. 풀 로드일 땐 재요청 없이 빠르게.
//
// 온디맨드 주입으로 중복 실행될 수 있으므로 리스너 등록은 1회만.

if (!window.__ytSpotifyContentLoaded) {
  window.__ytSpotifyContentLoaded = true;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_VIDEO_INFO') {
      extractVideoInfo()
        .then(sendResponse)
        .catch((e) => sendResponse({ error: String((e && e.message) || e), tracks: [], musicCards: [] }));
      return true; // 비동기 응답 유지
    }
    return false;
  });
}

function currentVideoId() {
  return new URLSearchParams(location.search).get('v');
}

async function extractVideoInfo() {
  const page = await getFreshPageData();
  const tracks = await extractTracks(page);
  let musicCards = extractMusicCards(page.data); // 유튜브 자동 "음악" 섹션 (원제목·아티스트·앨범)
  // 트랙 자체가 음악카드에서 유래했으면 정렬용 카드는 불필요(중복 매칭 방지)
  if (tracks.length && tracks[0] && tracks[0].source === 'music-card') musicCards = [];
  return {
    title: extractTitle(),
    channel: extractChannel(),
    url: location.origin + location.pathname + '?v=' + (currentVideoId() || ''),
    tracks,
    musicCards,
    videoId: page.vid,
    dataSource: page.source, // 디버그용: embedded | refetch | fallback
  };
}

// ============ 신선한 페이지 데이터 확보 (SPA stale 대응) ============

// 마커 뒤 첫 '{'부터 균형 잡힌 닫는 '}'까지 잘라낸다(문자열/이스케이프 인식).
// '};' 휴리스틱은 전체 HTML 재요청 시 오절단 위험 → 브레이스 매칭으로 견고하게.
function extractBalancedJson(text, marker) {
  const i = (text || '').indexOf(marker);
  if (i === -1) return null;
  const start = text.indexOf('{', i + marker.length);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let p = start; p < text.length; p++) {
    const ch = text[p];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { if (--depth === 0) return text.slice(start, p + 1); }
  }
  return null;
}

// 임의의 텍스트(스크립트 태그 내용 또는 재요청 HTML)에서 ytInitialData JSON 파싱.
function parseYtInitialDataFromText(text) {
  const raw = extractBalancedJson(text, 'var ytInitialData = ');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function dataVideoId(data) {
  return (data && data.currentVideoEndpoint && data.currentVideoEndpoint.watchEndpoint &&
    data.currentVideoEndpoint.watchEndpoint.videoId) || null;
}

// 현재 DOM의 <script> 태그들에서 ytInitialData 파싱 (풀 로드면 신선, SPA면 stale)
function findEmbeddedYtInitialData() {
  for (const s of document.querySelectorAll('script')) {
    const t = s.textContent || '';
    if (t.indexOf('var ytInitialData = ') !== -1) {
      const d = parseYtInitialDataFromText(t);
      if (d) return d;
    }
  }
  return null;
}

// 임의 텍스트에서 videoDetails.shortDescription 추출
function parseShortDescriptionFromText(text) {
  const m = (text || '').match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
  if (m) { try { return JSON.parse('"' + m[1] + '"'); } catch (e) { /* noop */ } }
  return '';
}

// 현재 영상 기준의 { data, shortDescription, vid, source } 반환.
// source: 'embedded'(풀 로드·재요청 없음) | 'refetch'(SPA 신선화) | 'fallback'(둘 다 실패)
async function getFreshPageData() {
  const vid = currentVideoId();
  const embedded = findEmbeddedYtInitialData();

  // 1) 임베드 데이터가 현재 영상과 일치 → 풀 로드. 그대로 사용(빠름).
  if (vid && embedded && dataVideoId(embedded) === vid) {
    return { data: embedded, shortDescription: getDescriptionFromInitialData(), vid, source: 'embedded' };
  }

  // 2) stale(SPA 이동) 또는 임베드 없음 → 현재 watch URL을 재요청해 신선화.
  try {
    const html = await fetch(location.href, { credentials: 'include' }).then((r) => r.text());
    const data = parseYtInitialDataFromText(html);
    if (data && (!vid || dataVideoId(data) === vid)) {
      return { data, shortDescription: parseShortDescriptionFromText(html), vid, source: 'refetch' };
    }
  } catch (e) { /* 네트워크 실패 → 폴백 */ }

  // 3) 폴백: 가진 것으로 최선 (임베드 있으면 사용, 없으면 DOM만)
  return { data: embedded || null, shortDescription: getDescriptionFromInitialData(), vid, source: 'fallback' };
}

// ============ 필드 추출 ============

function extractTitle() {
  const h1 = document.querySelector('h1.ytd-watch-metadata, h1.title yt-formatted-string, h1.title');
  return (h1?.textContent || document.title.replace(/ - YouTube$/, '')).trim();
}

function extractChannel() {
  const el = document.querySelector('ytd-channel-name a, #owner #channel-name a, #upload-info a');
  return (el?.textContent || '').trim();
}

// 소스 폴백 체인: 설명란 타임스탬프 → 유튜브 챕터 → 고정/상단 댓글 → 자동감지 음악카드 → DOM.
// 댓글 소스("타임스탬프는 댓글 확인" 패턴)가 잡히면 타임스탬프·순서·길이를 확보하면서
// musicCards(원제목)는 정렬 소스로 함께 살아있어 정밀 매칭 콤보가 된다.
async function extractTracks(page) {
  const fromDesc = extractDescriptionTracklist(page);
  if (fromDesc.length >= 3) return fromDesc;

  if (typeof parseChapterList === 'function') {
    const fromChapters = parseChapterList(extractChapters(page.data));
    if (fromChapters.length >= 3) return fromChapters;
  }
  if (typeof tracklistFromComments === 'function') {
    const fromComments = tracklistFromComments(await fetchTopComments(page));
    if (fromComments.length >= 3) return fromComments;
  }
  if (typeof tracksFromMusicCards === 'function') {
    const fromCards = tracksFromMusicCards(extractMusicCards(page.data));
    if (fromCards.length >= 1) return fromCards;
  }
  return extractMusicSection(); // 최후 보조(best-effort DOM)
}

// ---- 고정/상단 댓글: youtubei/v1/next 연속 요청 (same-origin, 페이지 자체 키 사용) ----

// 신선한 ytInitialData에서 댓글 섹션의 continuation 토큰 찾기
function findCommentsToken(data) {
  let token = null;
  (function walk(n) {
    if (!n || typeof n !== 'object' || token) return;
    if (Array.isArray(n)) { for (const x of n) { walk(x); if (token) return; } return; }
    const isr = n.itemSectionRenderer;
    if (isr && /comment/i.test(isr.sectionIdentifier || '')) {
      (function dig(m) {
        if (!m || typeof m !== 'object' || token) return;
        if (Array.isArray(m)) { for (const x of m) { dig(x); if (token) return; } return; }
        if (m.continuationCommand && m.continuationCommand.token) { token = m.continuationCommand.token; return; }
        for (const k in m) { dig(m[k]); if (token) return; }
      })(isr);
      return;
    }
    for (const k in n) { walk(n[k]); if (token) return; }
  })(data);
  return token;
}

// 페이지 스크립트에서 INNERTUBE 키·클라이언트 버전 (ytcfg — 영상 바뀌어도 동일)
function getInnertubeCfg() {
  for (const s of document.querySelectorAll('script')) {
    const t = s.textContent || '';
    const k = t.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    if (k) {
      const v = t.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
      return { key: k[1], version: (v && v[1]) || '2.20260101.00.00' };
    }
  }
  return null;
}

// /next 응답에서 댓글 텍스트를 노출 순서대로 수집(고정 댓글이 항상 첫 번째).
// 신형(commentEntityPayload)·구형(commentRenderer) 포맷 모두 지원.
function commentTextsFromNext(json) {
  const texts = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const p = n.commentEntityPayload;
    if (p && p.properties && p.properties.content && typeof p.properties.content.content === 'string') {
      texts.push(p.properties.content.content);
    }
    const r = n.commentRenderer;
    if (r && r.contentText) {
      const t = r.contentText.simpleText || (r.contentText.runs || []).map((x) => x.text).join('');
      if (t) texts.push(t);
    }
    for (const k in n) walk(n[k]);
  })(json);
  return texts;
}

async function fetchTopComments(page) {
  try {
    const token = findCommentsToken(page && page.data);
    const cfg = getInnertubeCfg();
    if (!token || !cfg) return [];
    const res = await fetch(`${location.origin}/youtubei/v1/next?key=${encodeURIComponent(cfg.key)}&prettyPrint=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: cfg.version, hl: 'ko', gl: 'KR' } },
        continuation: token,
      }),
    });
    if (!res.ok) return [];
    return commentTextsFromNext(await res.json());
  } catch (e) { return []; }
}

// ---- 자동 "음악" 섹션: ytInitialData의 videoAttributeViewModel 카드 ----
// data는 getFreshPageData가 보장한 "현재 영상" 데이터 → videoId 가드 불필요.
function extractMusicCards(data) {
  try {
    if (!data) return [];
    const cards = [];
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.horizontalCardListRenderer) {
        const h = n.horizontalCardListRenderer;
        for (const c of h.cards || []) {
          const v = c.videoAttributeViewModel;
          if (v && v.title && v.subtitle) {
            cards.push({
              title: v.title,
              artist: v.subtitle,
              album: (v.secondarySubtitle && v.secondarySubtitle.content) || '',
            });
          }
        }
      }
      for (const k in n) walk(n[k]);
    })(data);

    const seen = new Set();
    return cards.filter((c) => {
      const k = c.title + '|' + c.artist;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } catch (e) { return []; }
}

// ---- 유튜브 챕터: ytInitialData의 chapterRenderer ----
function extractChapters(data) {
  try {
    if (!data) return [];
    const out = [];
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const c = n.chapterRenderer;
      if (c) {
        const title = (c.title && (c.title.simpleText ||
          (c.title.runs && c.title.runs.map((r) => r.text).join('')))) || '';
        const ms = c.timeRangeStartMillis;
        if (title && ms != null) out.push({ title, startSec: Math.round(Number(ms) / 1000) });
      }
      for (const k in n) walk(n[k]);
    })(data);

    const seen = new Set();
    return out.filter((c) => { if (seen.has(c.startSec)) return false; seen.add(c.startSec); return true; });
  } catch (e) { return []; }
}

// 설명란 → 파서. 신선한 shortDescription 우선(현재 영상 확정), 부족하면 DOM 텍스트 보조.
// (SPA 직후 DOM(#description)은 이전 영상 상태로 남아있을 수 있어 shortDescription을 신뢰한다.)
function extractDescriptionTracklist(page) {
  if (typeof parseDescriptionTracklist !== 'function') return [];
  const fresh = parseDescriptionTracklist((page && page.shortDescription) || '');
  if (fresh.length >= 3) return fresh;
  const dom = parseDescriptionTracklist(getDescriptionText());
  return dom.length > fresh.length ? dom : fresh;
}

function getDescriptionText() {
  const el = document.querySelector(
    'ytd-text-inline-expander #plain-snippet-text, ' +
    '#description-inline-expander, ytd-text-inline-expander, #description'
  );
  return (el && (el.textContent || el.innerText)) || '';
}

// ytInitialPlayerResponse.videoDetails.shortDescription (현재 DOM 스크립트 기준)
function getDescriptionFromInitialData() {
  const scripts = document.querySelectorAll('script');
  for (const s of scripts) {
    const t = s.textContent;
    if (t && t.indexOf('ytInitialPlayerResponse') !== -1) {
      const d = parseShortDescriptionFromText(t);
      if (d) return d;
    }
  }
  return '';
}

// 유튜브 자동 감지 "음악" 섹션 (원제목·아티스트) — 최후 보조(DOM). 없으면 [].
function extractMusicSection() {
  const rows = document.querySelectorAll('ytd-metadata-row-renderer, ytd-compact-video-renderer');
  if (!rows || !rows.length) return [];
  const out = [];
  rows.forEach((row) => {
    const title = row.querySelector('#title, .title')?.textContent?.trim();
    const artist = row.querySelector('#subtitle, .subtitle')?.textContent?.trim();
    if (title && title.length > 1) {
      out.push({
        index: out.length + 1,
        titleGuess: title,
        artistGuess: artist || '',
        label: [artist, title].filter(Boolean).join(' - '),
        query: [artist, title].filter(Boolean).join(' '),
        source: 'music-section',
      });
    }
  });
  return out;
}
