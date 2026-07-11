// youtube-content.js — 유튜브 영상 페이지에서 트랙리스트를 추출하는 콘텐츠 스크립트 (스켈레톤)
// 소스 우선순위: 유튜브 자동 "음악" 섹션(원제목) > 설명란/챕터(번역·보조).

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_VIDEO_INFO') {
    sendResponse(extractVideoInfo());
  }
  return false;
});

function extractVideoInfo() {
  return {
    title: extractTitle(),
    channel: extractChannel(),
    tracks: extractTracks(), // [{ index, title, artist, source }]
  };
}

function extractTitle() {
  const h1 = document.querySelector('h1.ytd-watch-metadata, h1.title');
  return (h1?.textContent || document.title.replace(/ - YouTube$/, '')).trim();
}

function extractChannel() {
  const el = document.querySelector('ytd-channel-name a, #owner #channel-name a');
  return (el?.textContent || '').trim();
}

// 두 소스를 합쳐 트랙 목록 생성 (타임스탬프 순서 기준 병합)
function extractTracks() {
  const fromMusic = extractMusicSection();   // 우선
  const fromDesc = extractDescriptionTracklist(); // 보조
  return mergeTrackSources(fromMusic, fromDesc);
}

// 유튜브가 자동 감지한 "음악" 섹션 파싱 (원제목·아티스트)
function extractMusicSection() {
  // TODO: watch 페이지의 음악 메타데이터(ytd-video-description-music-section-renderer 등) 파싱
  return [];
}

// 설명란/고정댓글/챕터의 "타임스탬프 곡명" 파싱
function extractDescriptionTracklist() {
  // TODO: 설명란 텍스트에서 "0:00 아티스트 - 곡" 패턴 추출
  // 예) /^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+?)\s*[-–]\s*(.+)$/
  return [];
}

function mergeTrackSources(primary, secondary) {
  // TODO: 타임스탬프/순서로 정렬 후 중복 제거, primary(원제목) 우선
  return primary.length ? primary : secondary;
}
