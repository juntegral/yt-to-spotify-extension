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
  out.forEach((r, i) => {
    r.index = i + 1;
    // 타임스탬프 간격 = 대략적 곡 길이 (마지막 곡은 불명 → null)
    r.durationSec = i + 1 < out.length ? out[i + 1].seconds - r.seconds : null;
  });
  return out.length >= 3 ? out : [];
}

// ── Method B: 설명란 트랙리스트가 없을 때의 대체 소스 ──

// "1. ", "01 - ", "#3 ", "03) " 등 앞머리 트랙 번호 제거
function stripTrackIndex(s) {
  return String(s || '').replace(/^\s*#?\d{1,3}\s*[.):\-–—]?\s+/, '').trim();
}
function secToClock(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
// 명백한 비-곡 챕터(인트로/아웃트로 등) 걸러내기 — best-effort.
// 한글은 \b가 안 먹으므로 정확 일치, ASCII 키워드는 접두 매칭.
function looksNonSong(label) {
  const s = String(label || '').trim().toLowerCase();
  if (/^(intro|outro|opening|ending|인트로|아웃트로|오프닝|엔딩|목차|타임스탬프|tracklist|track ?list)$/.test(s)) return true;
  if (/^(intro|outro|opening|ending)\b/i.test(s)) return true;
  return false;
}

// 유튜브 챕터 [{title, startSec}] → 트랙리스트(설명란 파서와 동일 형태)
function parseChapterList(chapters) {
  if (!Array.isArray(chapters)) return [];
  const rows = chapters
    .map((c) => ({ startSec: Number(c.startSec) || 0, label: cleanLabel(stripTrackIndex(c.title || '')) }))
    .filter((c) => c.label && c.label.length >= 2 && !looksNonSong(c.label))
    .sort((a, b) => a.startSec - b.startSec);
  const seen = new Set();
  const uniq = [];
  for (const r of rows) { if (seen.has(r.startSec)) continue; seen.add(r.startSec); uniq.push(r); }
  if (uniq.length < 3) return [];
  return uniq.map((r, i) => {
    const { partA, partB } = splitArtistTitle(r.label);
    return {
      time: secToClock(r.startSec), seconds: r.startSec, label: r.label,
      artistGuess: partA, titleGuess: partB,
      query: partB ? `${partA} ${partB}` : r.label,
      index: i + 1,
      durationSec: i + 1 < uniq.length ? uniq[i + 1].startSec - r.startSec : null,
      source: 'chapter',
    };
  });
}

// 댓글 텍스트 배열(노출 순서 = 고정 댓글이 항상 첫 번째) → 트랙리스트.
// "곡 순서·타임스탬프는 댓글 확인" 패턴 대응: 앞쪽 댓글부터 설명란 파서를 돌려
// 처음으로 타임스탬프 3개 이상이 나오는 댓글을 트랙리스트로 채택.
function tracklistFromComments(commentTexts) {
  if (!Array.isArray(commentTexts)) return [];
  for (const text of commentTexts.slice(0, 10)) {
    const rows = parseDescriptionTracklist(String(text || ''));
    if (rows.length >= 3) return rows.map((r) => ({ ...r, source: 'comment' }));
  }
  return [];
}

// 유튜브 자동감지 음악카드 [{title, artist, album}] → 트랙리스트(타임스탬프 없음)
function tracksFromMusicCards(cards) {
  if (!Array.isArray(cards) || !cards.length) return [];
  return cards.map((c, i) => ({
    time: null, seconds: null,
    label: [c.artist, c.title].filter(Boolean).join(' - ') || c.title || '',
    artistGuess: c.artist || '',
    titleGuess: c.title || '',
    query: [c.artist, c.title].filter(Boolean).join(' ') || c.title || '',
    index: i + 1, durationSec: null, source: 'music-card',
  }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseDescriptionTracklist, toSeconds, cleanLabel, splitArtistTitle,
    parseChapterList, tracksFromMusicCards, tracklistFromComments,
    stripTrackIndex, secToClock, looksNonSong,
  };
}
