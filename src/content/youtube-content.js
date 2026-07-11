// youtube-content.js — 유튜브 영상 페이지에서 제목/채널/트랙리스트 추출.
// 소스 우선순위: 자동 "음악" 섹션(원제목) > 설명란/챕터(번역·보조).
// 온디맨드 주입으로 중복 실행될 수 있으므로 리스너 등록은 1회만.

if (!window.__ytSpotifyContentLoaded) {
  window.__ytSpotifyContentLoaded = true;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_VIDEO_INFO') {
      sendResponse(extractVideoInfo());
    }
    return false;
  });
}

function extractVideoInfo() {
  return { title: extractTitle(), channel: extractChannel(), tracks: extractTracks() };
}

function extractTitle() {
  const h1 = document.querySelector('h1.ytd-watch-metadata, h1.title yt-formatted-string, h1.title');
  return (h1?.textContent || document.title.replace(/ - YouTube$/, '')).trim();
}

function extractChannel() {
  const el = document.querySelector('ytd-channel-name a, #owner #channel-name a, #upload-info a');
  return (el?.textContent || '').trim();
}

function extractTracks() {
  const fromMusic = extractMusicSection();        // 우선(원제목)
  const fromDesc = extractDescriptionTracklist();  // 보조(번역 가능)
  return mergeTrackSources(fromMusic, fromDesc);
}

// 설명란 → 파서. DOM 텍스트(전환 시 최신) 우선, 부족하면 초기데이터로 보강.
function extractDescriptionTracklist() {
  if (typeof parseDescriptionTracklist !== 'function') return [];
  let tracks = parseDescriptionTracklist(getDescriptionText());
  if (tracks.length < 3) {
    const alt = parseDescriptionTracklist(getDescriptionFromInitialData());
    if (alt.length > tracks.length) tracks = alt;
  }
  return tracks;
}

function getDescriptionText() {
  const el = document.querySelector(
    'ytd-text-inline-expander #plain-snippet-text, ' +
    '#description-inline-expander, ytd-text-inline-expander, #description'
  );
  return (el && (el.textContent || el.innerText)) || '';
}

// ytInitialPlayerResponse.videoDetails.shortDescription (초기 로드된 영상 기준)
function getDescriptionFromInitialData() {
  const scripts = document.querySelectorAll('script');
  for (const s of scripts) {
    const t = s.textContent;
    if (t && t.indexOf('ytInitialPlayerResponse') !== -1) {
      const m = t.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
      if (m) {
        try { return JSON.parse('"' + m[1] + '"'); } catch (e) {}
      }
    }
  }
  return '';
}

// 유튜브 자동 감지 "음악" 섹션 (원제목·아티스트).
// 라이브 DOM 구조 확인 필요 — 지금은 best-effort(없으면 []). TODO(2.5단계).
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

function mergeTrackSources(primary, secondary) {
  // TODO(4단계): 타임스탬프/순서로 병합. 지금은 있는 쪽 우선(설명란이 대부분).
  return primary && primary.length ? primary : secondary || [];
}
