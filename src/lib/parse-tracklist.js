// parse-tracklist.js — 설명란 텍스트에서 "타임스탬프 트랙리스트"를 추출하는 순수 함수.
// 콘텐츠 스크립트에서는 전역 함수로, Node 테스트에서는 require 로 사용.

function toSeconds(ts) {
  const p = ts.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

function cleanLabel(s) {
  return s
    .replace(/\(https?:\/\/[^)]*\)/gi, ' ') // 마크다운 링크 (url)
    .replace(/https?:\/\/\S+/gi, ' ')       // 벌거벗은 url
    .replace(/[\[\]()]/g, ' ')              // 남은 괄호
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:.·|]+/, '')          // 앞쪽 구분자
    .replace(/[\s\-–—·|]+$/, '')            // 뒤쪽 구분자
    .trim();
}

// "아티스트 - 곡" 또는 "곡 - 아티스트" — 순서는 확정 못 하므로 두 조각 다 보관.
function splitArtistTitle(label) {
  const parts = label.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return { partA: parts[0].trim(), partB: parts.slice(1).join(' - ').trim() };
  }
  return { partA: label, partB: '' };
}

function parseDescriptionTracklist(text) {
  if (!text) return [];

  // 타임스탬프(대괄호/괄호 감싼 형태 포함)를 모두 찾음
  const re = /\[?\(?(\d{1,2}:\d{2}(?::\d{2})?)\)?\]?/g;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    marks.push({ time: m[1], start: m.index, end: re.lastIndex });
  }
  if (marks.length < 3) return []; // 트랙리스트로 보기 어려움

  const rows = [];
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].end;
    const to = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const label = cleanLabel(text.slice(from, to));
    if (!label || label.length < 2) continue;
    const { partA, partB } = splitArtistTitle(label);
    rows.push({
      time: marks[i].time,
      seconds: toSeconds(marks[i].time),
      label,
      artistGuess: partA,
      titleGuess: partB,
      query: partB ? `${partA} ${partB}` : label, // Spotify 검색은 순서 무관 전체어로
    });
  }

  // 시간 오름차순만 유지(오탐 제거) + 중복 타임스탬프 제거
  const seen = new Set();
  let lastSec = -1;
  const out = [];
  for (const r of rows) {
    if (seen.has(r.seconds) || r.seconds < lastSec) continue;
    seen.add(r.seconds);
    lastSec = r.seconds;
    out.push(r);
  }
  out.forEach((r, i) => (r.index = i + 1));
  return out.length >= 3 ? out : [];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseDescriptionTracklist, toSeconds, cleanLabel, splitArtistTitle };
}
