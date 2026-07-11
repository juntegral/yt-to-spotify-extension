// matching.js — 매칭 점수 모델 + 신뢰도 분류 + 최초 공식 릴리스 선택.
// 순수 함수만 포함 (chrome API 없음) → Node 테스트 & 서비스 워커 양쪽에서 사용.
//
// 설계 근거 (프로젝트 문서 §3~4):
//  - 점수 = 제목·아티스트 퍼지 + 재생시간 지수감쇠 + 금지어 페널티 (spotDL 공식 참고)
//  - 타임스탬프 간격 = 곡 길이 (언어 무관 신호)
//  - "공식" = 트랙리스트에 적힌 그 아티스트의 음원 (우타이테 커버 포함)
//  - 최초 릴리스 = 같은 녹음(ISRC) 중 컴필/리마스터 제외 후 최초 날짜

// ---------- 정규화 ----------

function nfkc(s) {
  s = String(s || '');
  return s.normalize ? s.normalize('NFKC') : s;
}

// 괄호류(부제) 제거 변형
function stripParen(s) {
  return String(s || '')
    .replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】|「[^」]*」|『[^』]*』/g, ' ');
}

function slugify(s) {
  return nfkc(s)
    .toLowerCase()
    .replace(/\b(feat|ft|featuring|with)\.?\s+/gi, ' ')
    .replace(/[「」『』【】\[\](){}<>]/g, ' ')
    .replace(/[’'`´‘“”".,!?~♪♡★☆・：:;|/\\_+*#@=&%$^–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- 유사도 ----------

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function charRatio(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  const max = Math.max(a.length, b.length);
  return (1 - levenshtein(a, b) / max) * 100;
}

function tokenSortRatio(a, b) {
  const ta = a.split(' ').filter(Boolean).sort().join(' ');
  const tb = b.split(' ').filter(Boolean).sort().join(' ');
  return charRatio(ta, tb);
}

// 짧은 쪽이 긴 쪽에 포함되면 높은 점수 (예: "Sparkle" ⊂ "Sparkle (Original Ver.)")
function containmentScore(a, b) {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (!s || s.length < 2) return 0;
  if (!l.includes(s)) return 0;
  return 72 + 28 * (s.length / l.length);
}

// 두 문자열의 종합 유사도 (0~100)
function similarity(rawA, rawB) {
  const a = slugify(rawA), b = slugify(rawB);
  if (!a || !b) return 0;
  const a2 = slugify(stripParen(rawA)), b2 = slugify(stripParen(rawB));
  return Math.max(
    charRatio(a, b),
    a2 && b2 ? charRatio(a2, b2) : 0,
    tokenSortRatio(a, b),
    containmentScore(a, b)
  );
}

// ---------- 금지어 (커버/가라오케/변형 버전 필터) ----------

const FORBIDDEN_WORDS = [
  'karaoke', 'tribute', 'in the style of', 'originally performed',
  'made famous', 'cover', 'covered by', 'instrumental', 'off vocal',
  'live', 'acoustic', 'remix', 'sped up', 'slowed', 'nightcore',
  '8 bit', '8bit', 'music box', 'lofi', 'lo fi', 'reverb', 'remaster',
  '노래방', '커버', 'カバー', 'オルゴール', 'ピアノ', 'inst ',
];

// 후보(트랙명+앨범명)에만 있고 원본 라벨엔 없는 금지어당 -15점
function forbiddenPenalty(sourceLabel, candText) {
  const src = ' ' + slugify(sourceLabel) + ' ';
  const cand = ' ' + slugify(candText) + ' ';
  let penalty = 0;
  for (const w of FORBIDDEN_WORDS) {
    const sw = ' ' + slugify(w) + ' ';
    const inCand = cand.includes(sw.trim().length ? slugify(w) : w);
    if (inCand && !src.includes(slugify(w))) penalty += 15;
  }
  return penalty;
}

// ---------- 재생시간 점수 ----------

// expectedSec: 타임스탬프 간격(초). 5초 유예 후 지수 감쇠. 없으면 null(중립).
function durationScore(expectedSec, candMs) {
  if (!expectedSec || !candMs) return null;
  const diff = Math.abs(expectedSec - candMs / 1000);
  return Math.exp(-0.1 * Math.max(0, diff - 5)) * 100;
}

// ---------- 후보 점수 ----------

// entry: { titleGuess, artistGuess, label, durationSec }
// cand:  { name, artists: [이름...], artistIds, durationMs, album: {name} }
// opts:  { artistLocked: true }  → 아티스트 확정 상태(폴백 검색), 길이 가중 강화
//        { resolvedArtistIds: [] } → 아티스트 엔티티(ID) 확정 — 로마자/한자 표기가 달라도
//          ID가 일치하면 아티스트 점수 100 (예: 입력 "優里" ↔ API "Yuuri")
function scoreCandidate(entry, cand, opts) {
  opts = opts || {};
  const artistJoined = (cand.artists || []).join(' ');
  const entityMatch = !!(
    opts.resolvedArtistIds && opts.resolvedArtistIds.length &&
    cand.artistIds && cand.artistIds.some((id) => opts.resolvedArtistIds.includes(id))
  );

  // "A - B"의 순서 모호 → 두 방향 모두 계산해 나은 쪽 채택
  function orientation(title, artist) {
    const t = similarity(title, cand.name);
    let a = 0;
    if (artist) {
      for (const an of cand.artists || []) a = Math.max(a, similarity(artist, an));
      a = Math.max(a, similarity(artist, artistJoined));
    }
    return { t, a };
  }
  const o1 = orientation(entry.titleGuess || entry.label, entry.artistGuess);
  const o2 = entry.artistGuess
    ? orientation(entry.artistGuess, entry.titleGuess)
    : { t: 0, a: 0 };
  const o1s = o1.t * 0.6 + o1.a * 0.4;
  const o2s = o2.t * 0.6 + o2.a * 0.4;
  const o = o1s >= o2s ? o1 : o2;

  const dur = durationScore(entry.durationSec, cand.durationMs);
  const artistScore = entityMatch ? 100 : o.a; // 엔티티 일치 = 표기 무관 확정

  let base;
  if (opts.artistLocked) {
    // 아티스트는 이미 확정 → 길이 중심 + 제목 보조
    base = dur != null ? o.t * 0.4 + dur * 0.6 : o.t;
  } else if (dur != null) {
    base = o.t * 0.45 + artistScore * 0.3 + dur * 0.25;
  } else {
    base = o.t * 0.6 + artistScore * 0.4;
  }

  const penalty = forbiddenPenalty(
    entry.label || `${entry.artistGuess || ''} ${entry.titleGuess || ''}`,
    `${cand.name} ${(cand.album && cand.album.name) || ''}`
  );

  const score = Math.max(0, Math.min(100, base - penalty));
  return { score, titleScore: o.t, artistScore, durScore: dur, penalty, entityMatch };
}

// ---------- 신뢰도 분류 ----------

const TIER = { AUTO: 'auto', REVIEW: 'review', REJECT: 'reject' };

function classify(score) {
  if (score >= 85) return TIER.AUTO;
  if (score >= 60) return TIER.REVIEW;
  return TIER.REJECT;
}

// ---------- 최초 공식 릴리스 선택 ----------

// 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD' → 비교 가능한 수치 (누락 자리는 01로 패딩)
function releaseDateValue(d) {
  if (!d) return 99999999;
  const p = String(d).split('-');
  const y = p[0] ? p[0].padStart(4, '0') : '9999';
  const m = p[1] ? p[1].padStart(2, '0') : '01';
  const day = p[2] ? p[2].padStart(2, '0') : '01';
  return Number(y + m + day);
}

const REISSUE_RE = /remaster|deluxe|anniversary|best|complete|collection|greatest|리마스터|베스트/i;

function isCompilationLike(cand) {
  const alb = cand.album || {};
  if ((alb.type || '').toLowerCase() === 'compilation') return true;
  const albArtists = (alb.artists || []).join(' ').toLowerCase();
  if (albArtists.includes('various artists')) return true;
  return false;
}

function isReissueLike(cand) {
  return REISSUE_RE.test((cand.album && cand.album.name) || '');
}

// 같은 녹음인가: ISRC 일치 or (제목 유사 ≥90 + 대표 아티스트 일치)
function sameRecording(a, b) {
  if (a.isrc && b.isrc) return a.isrc === b.isrc;
  const artistEq =
    (a.artistIds && b.artistIds && a.artistIds[0] === b.artistIds[0]) ||
    similarity((a.artists || [])[0] || '', (b.artists || [])[0] || '') >= 90;
  return artistEq && similarity(a.name, b.name) >= 90;
}

// pool에서 best와 같은 녹음의 릴리스들 중 "최초 공식" 선택.
// 우선순위: 비컴필 > 컴필, 비재발매 > 재발매, 최초 날짜, (동률) 싱글 우선.
function pickOriginalRelease(best, pool) {
  const group = (pool || []).filter((c) => sameRecording(best, c));
  if (group.length <= 1) return best;
  const typeRank = { single: 0, album: 1, compilation: 2 };
  group.sort((a, b) => {
    const compA = isCompilationLike(a) ? 1 : 0, compB = isCompilationLike(b) ? 1 : 0;
    if (compA !== compB) return compA - compB;
    const reA = isReissueLike(a) ? 1 : 0, reB = isReissueLike(b) ? 1 : 0;
    if (reA !== reB) return reA - reB;
    const dA = releaseDateValue(a.album && a.album.releaseDate);
    const dB = releaseDateValue(b.album && b.album.releaseDate);
    if (dA !== dB) return dA - dB;
    const tA = typeRank[(a.album && a.album.type) || 'album'] ?? 1;
    const tB = typeRank[(b.album && b.album.type) || 'album'] ?? 1;
    return tA - tB;
  });
  return group[0];
}

// ---------- 음악 카드 ↔ 타임스탬프 슬롯 정렬 (순서 보존 DP) ----------
// 카드(원제목 매칭 결과)와 설명란 슬롯은 둘 다 재생 순서 → 교차 없는 정렬.
// 점수 = 아티스트 일치(엔티티/이름) + 길이 적합도. 영상이 곡을 잘라도(트림) 견디게 설계.

function cardSlotScore(slot, card, pos) {
  const entity = !!(slot.artistIds && slot.artistIds.length &&
    card.artistIds && card.artistIds.some((id) => slot.artistIds.includes(id)));
  const nameOk = !entity && slot.artistGuess &&
    similarity(slot.artistGuess, (card.artistNames || []).join(' ')) >= 55;
  const consistent = entity || nameOk;
  let durFit = 15; // 길이 정보 없음 → 낮은 중립값
  if (slot.durationSec && card.durationMs) {
    const diff = Math.abs(slot.durationSec - card.durationMs / 1000);
    durFit = Math.exp(-0.06 * Math.max(0, diff - 8)) * 45;
  }
  // 위치 보정: 카드 순서 ≈ 슬롯 순서 → 상대 위치가 가까울수록 소폭 가산 (동률 타이브레이크)
  let posBonus = 0;
  if (pos) posBonus = 4 * (1 - Math.min(1, Math.abs(pos.slotFrac - pos.cardFrac) * 2));
  const score = (consistent ? 55 : 0) + durFit + posBonus;
  // 자격: 아티스트 일치면 트림/페이드로 길이가 어긋나도 허용(±60초 수준),
  //       불일치면 길이가 거의 정확(±13초)해야만 후보
  const eligible = (consistent && durFit >= 1.5) || durFit >= 33;
  return { score, consistent, eligible };
}

// slots: [{durationSec, artistGuess, artistIds}], cards: [{durationMs, artistIds, artistNames}]
// 반환: [{cardIndex, slotIndex, score, consistent}] (slotIndex 오름차순, 교차 없음)
function alignMusicCards(slots, cards) {
  const n = slots.length, m = cards.length;
  const S = [];
  for (let j = 0; j < m; j++) {
    S[j] = [];
    for (let i = 0; i < n; i++) {
      S[j][i] = cardSlotScore(slots[i], cards[j], {
        slotFrac: n > 1 ? i / (n - 1) : 0.5,
        cardFrac: m > 1 ? j / (m - 1) : 0.5,
      });
    }
  }
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let j = 1; j <= m; j++) {
    for (let i = 1; i <= n; i++) {
      let v = Math.max(dp[j - 1][i], dp[j][i - 1]);
      const sc = S[j - 1][i - 1];
      if (sc.eligible) v = Math.max(v, dp[j - 1][i - 1] + sc.score);
      dp[j][i] = v;
    }
  }
  const pairs = [];
  let j = m, i = n;
  while (j > 0 && i > 0) {
    const sc = S[j - 1][i - 1];
    if (sc.eligible && dp[j][i] === dp[j - 1][i - 1] + sc.score) {
      pairs.push({ cardIndex: j - 1, slotIndex: i - 1, score: sc.score, consistent: sc.consistent });
      j--; i--;
    } else if (dp[j][i] === dp[j - 1][i]) {
      j--;
    } else {
      i--;
    }
  }
  return pairs.reverse();
}

// ---------- exports ----------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    slugify, similarity, forbiddenPenalty, durationScore,
    scoreCandidate, classify, TIER,
    releaseDateValue, pickOriginalRelease, sameRecording,
    isCompilationLike, isReissueLike,
    cardSlotScore, alignMusicCards,
  };
}
