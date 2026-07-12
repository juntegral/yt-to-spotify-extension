// service-worker.js — 백그라운드 (MV3)
// 1단계: Spotify OAuth(PKCE) ✅
// 3~4단계: 매칭 파이프라인 (검색 폴백 → 점수 → 3계층) + 최초 릴리스 선택 + 재생목록 생성.
// 변환은 서비스 워커에서 진행 → 팝업이 닫혀도 계속됨. 상태는 chrome.storage.local.

importScripts(chrome.runtime.getURL('src/lib/matching.js'));

const SPOTIFY = {
  authUrl: 'https://accounts.spotify.com/authorize',
  tokenUrl: 'https://accounts.spotify.com/api/token',
  apiBase: 'https://api.spotify.com/v1',
  clientId: '666f8565157f4c32b461d8fa9d9d1d6c', // PKCE 공개 클라이언트
  scopes: ['playlist-modify-public', 'playlist-modify-private', 'user-read-private'], // user-read-private: /me country → 검색 market
};

async function handleMessage(message, sender) {
  switch (message.type) {
    // --- 디버그 브리지 전용 (개발용 — 배포 전 externally_connectable와 함께 제거) ---
    case 'PING':
      return { ok: true, version: chrome.runtime.getManifest().version };
    case 'DEBUG_RELOAD':
      setTimeout(() => chrome.runtime.reload(), 150);
      return { ok: true, reloading: true };
    case 'GET_VIDEO_INFO': {
      // 보낸 탭의 콘텐츠 스크립트에서 영상 정보 추출 (외부 디버그 요청용)
      const tabId = sender && sender.tab && sender.tab.id;
      if (tabId == null) return { ok: false, error: 'sender tab 없음' };
      return { ok: true, info: await chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_INFO' }) };
    }
    // --- 일반 ---
    case 'CONNECT_SPOTIFY':
      return { ok: true, profile: await connectSpotify() };
    case 'DISCONNECT_SPOTIFY':
      await disconnectSpotify();
      return { ok: true };
    case 'GET_AUTH_STATE':
      return { ok: true, ...(await getAuthState()) };
    case 'CONVERT':
      return startConvert(message.video);
    case 'GET_CONVERT_STATE':
      return { ok: true, state: (await chrome.storage.local.get('convertState')).convertState || null };
    case 'RESOLVE_REVIEW':
      return { ok: true, state: await resolveReview(message.itemId, message.uri) };
    case 'UNDO_RESOLVE':
      return { ok: true, state: await undoResolve() };
    case 'MANUAL_SEARCH':
      return { ok: true, results: await manualSearch(message.query) };
    case 'CLEAR_CONVERT':
      await chrome.storage.local.remove(['convertState', 'convertTabId']);
      await setBadge('');
      return { ok: true };
    default:
      return { ok: false, error: 'unknown message: ' + message.type };
  }
}

function messageListener(message, sender, sendResponse) {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // 비동기 응답
}
chrome.runtime.onMessage.addListener(messageListener);
// 디버그 브리지: youtube.com 페이지에서 확장 제어 (manifest externally_connectable)
chrome.runtime.onMessageExternal.addListener(messageListener);

// ============ OAuth (PKCE) ============

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function connectSpotify() {
  const redirectUri = chrome.identity.getRedirectURL();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));

  const authUrl = new URL(SPOTIFY.authUrl);
  authUrl.search = new URLSearchParams({
    client_id: SPOTIFY.clientId, response_type: 'code', redirect_uri: redirectUri,
    code_challenge_method: 'S256', code_challenge: challenge,
    scope: SPOTIFY.scopes.join(' '), state,
    show_dialog: 'true', // 재연결 시 동의 화면 강제 → 스코프 갱신 보장
  }).toString();

  const resp = await chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
  const ret = new URL(resp);
  if (ret.searchParams.get('error')) throw new Error('인증 거부: ' + ret.searchParams.get('error'));
  if (ret.searchParams.get('state') !== state) throw new Error('state 불일치');
  const code = ret.searchParams.get('code');
  if (!code) throw new Error('인증 코드 없음');

  const res = await fetch(SPOTIFY.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: SPOTIFY.clientId, code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error('토큰 교환 실패: ' + res.status);
  await saveTokens(await res.json());

  const me = await apiGet('/me');
  const profile = { id: me.id, name: me.display_name, country: me.country || null };
  await chrome.storage.local.set({ spotifyProfile: profile });
  return profile;
}

async function saveTokens(t) {
  const data = { accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
  if (t.refresh_token) data.refreshToken = t.refresh_token;
  await chrome.storage.local.set(data);
}

async function getAccessToken() {
  const { accessToken, expiresAt, refreshToken } =
    await chrome.storage.local.get(['accessToken', 'expiresAt', 'refreshToken']);
  if (!accessToken) throw new Error('Spotify 미연결');
  if (Date.now() < (expiresAt || 0)) return accessToken;
  if (!refreshToken) throw new Error('세션 만료 — 다시 연결해주세요');
  const res = await fetch(SPOTIFY.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: SPOTIFY.clientId,
    }),
  });
  if (!res.ok) throw new Error('토큰 갱신 실패: ' + res.status);
  const t = await res.json();
  await saveTokens(t);
  return t.access_token;
}

async function getAuthState() {
  const { spotifyProfile, accessToken } = await chrome.storage.local.get(['spotifyProfile', 'accessToken']);
  return { connected: !!accessToken, profile: spotifyProfile || null };
}
async function disconnectSpotify() {
  await chrome.storage.local.remove(['accessToken', 'refreshToken', 'expiresAt', 'spotifyProfile']);
}

// ============ Spotify API (레이트리밋 대응) ============

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiFetch(path, init, attempt) {
  attempt = attempt || 0;
  const token = await getAccessToken();
  // 요청 타임아웃 20초 — 매달린 요청이 변환 전체를 멈추지 않게
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(SPOTIFY.apiBase + path, {
      ...init,
      signal: ctrl.signal,
      headers: { Authorization: 'Bearer ' + token, ...((init && init.headers) || {}) },
    });
  } catch (e) {
    clearTimeout(timer);
    if (attempt < 2) { await sleep(1500); return apiFetch(path, init, attempt + 1); }
    throw new Error('네트워크 시간초과: ' + path.split('?')[0]);
  }
  clearTimeout(timer);
  if (res.status === 429) {
    const waitSec = Number(res.headers.get('Retry-After')) || 1;
    // 긴 대기는 무한로딩처럼 보임 → 30초 초과면 명시적 에러로 전환
    if (waitSec > 30 || attempt >= 3) {
      throw new Error(`Spotify 요청 한도 초과 — 약 ${waitSec}초 후 다시 시도해주세요`);
    }
    await sleep(waitSec * 1000 + 200);
    return apiFetch(path, init, attempt + 1);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j && j.error && (j.error.message || JSON.stringify(j.error))) || '';
    } catch (e) { try { detail = (await res.text()).slice(0, 200); } catch (e2) { /* noop */ } }
    throw new Error(`Spotify API ${path.split('?')[0]} 실패: ${res.status}${detail ? ' — ' + detail : ''}`);
  }
  return res.status === 201 || res.status === 200 ? res.json() : null;
}
const apiGet = (p) => apiFetch(p);
const apiPost = (p, body) =>
  apiFetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const apiDelete = (p, body) =>
  apiFetch(p, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function isRateLimit(e) { return /요청 한도/.test(String((e && e.message) || e)); }

// 검색 캐시: 메모리 + 영구(chrome.storage, 7일 TTL, 최대 600키)
// → 같은 영상 재변환·재시도 시 API 호출을 거의 0으로 (일일 쿼터 보호)
const memCache = new Map();
let cachePromise = null;
function loadCache() {
  if (!cachePromise) cachePromise = chrome.storage.local.get('spSearchCache').then((r) => r.spSearchCache || {});
  return cachePromise;
}
async function putCache(key, v) {
  const c = await loadCache();
  c[key] = { v, t: Date.now() };
  const keys = Object.keys(c);
  if (keys.length > 600) {
    keys.sort((a, b) => c[a].t - c[b].t);
    for (const k of keys.slice(0, keys.length - 500)) delete c[k];
  }
  await chrome.storage.local.set({ spSearchCache: c });
}

function simplifyArtist(a) {
  return { id: a.id, name: a.name, followers: (a.followers && a.followers.total) || 0 };
}

// 반환: 간소화된 결과 (track → simplify, artist → simplifyArtist). 캐시 객체 공유 주의 — 호출부에서 복사.
async function spSearch(q, type, limit) {
  type = type || 'track'; limit = limit || 10;
  const key = `${type}|${limit}|${q}`;
  if (memCache.has(key)) return memCache.get(key);
  const stored = (await loadCache())[key];
  if (stored && Date.now() - stored.t < 7 * 24 * 3600 * 1000) {
    memCache.set(key, stored.v);
    return stored.v;
  }
  const { spotifyProfile } = await chrome.storage.local.get('spotifyProfile');
  const market = spotifyProfile && spotifyProfile.country ? `&market=${spotifyProfile.country}` : '';
  const data = await apiGet(`/search?type=${type}&limit=${limit}${market}&q=${encodeURIComponent(q)}`);
  const items = type === 'track'
    ? (data.tracks?.items || []).map(simplify)
    : (data.artists?.items || []).map(simplifyArtist);
  memCache.set(key, items);
  await putCache(key, items);
  return items;
}

function simplify(t) {
  return {
    uri: t.uri, id: t.id, name: t.name,
    artists: (t.artists || []).map((a) => a.name),
    artistIds: (t.artists || []).map((a) => a.id),
    durationMs: t.duration_ms,
    isrc: (t.external_ids && t.external_ids.isrc) || null,
    popularity: t.popularity || 0,
    image: (t.album && t.album.images && t.album.images.length)
      ? (t.album.images[t.album.images.length - 1].url) : null, // 최소 크기 앨범아트

    album: {
      name: t.album?.name, type: t.album?.album_type,
      releaseDate: t.album?.release_date,
      artists: (t.album?.artists || []).map((a) => a.name),
    },
  };
}

// ============ 매칭 파이프라인 ============

// 아티스트 엔티티 확정: 이름 → Spotify 아티스트 ID들 (별칭 처리: "優里" 검색 → Yuuri)
async function resolveArtistIds(name) {
  if (!name || !name.trim()) return [];
  try {
    const artists = await spSearch(name.trim(), 'artist', 5);
    return (artists || []).slice(0, 3).map((a) => a.id).filter(Boolean);
  } catch (e) {
    if (isRateLimit(e)) throw e; // 레이트리밋은 전체 중단 (쓰레기 결과 방지)
    return [];
  }
}

async function matchEntry(entry) {
  const pool = new Map(); // uri → simplified (캐시 오염 방지를 위해 복사본 저장)
  const addToPool = (items) => items.forEach((t) => { if (t && t.uri && !pool.has(t.uri)) pool.set(t.uri, { ...t }); });

  const strategies = [];
  const T = (entry.titleGuess || '').trim(), A = (entry.artistGuess || '').trim();
  if (T && A) strategies.push(`track:"${T}" artist:"${A}"`);
  if (T && A) strategies.push(`${A} ${T}`);
  if (T && A) strategies.push(`track:"${A}" artist:"${T}"`); // 순서 모호 대비
  strategies.push(T || entry.label);

  // 아티스트 ID 확정 (캐시됨) — A 실패 시 T도 시도 (순서 모호)
  let resolvedArtistIds = await resolveArtistIds(A);
  if (!resolvedArtistIds.length && T && T !== A) resolvedArtistIds = await resolveArtistIds(T);
  const scoreOpts = { resolvedArtistIds };

  let best = null, bestScore = -1;
  const rescore = () => {
    for (const c of pool.values()) {
      const { score } = scoreCandidate(entry, c, scoreOpts);
      c._score = Math.round(score * 10) / 10;
      if (score > bestScore) { bestScore = score; best = c; }
    }
  };

  for (const q of strategies) {
    if (!q || !q.trim()) continue;
    try { addToPool(await spSearch(q, 'track', 10)); }
    catch (e) { if (isRateLimit(e)) throw e; /* 그 외 개별 쿼리 실패 무시 */ }
    rescore();
    if (bestScore >= 85) break; // 조기 종료 → API 절약
  }

  let artistLockedUsed = false;
  // 폴백: 텍스트 매칭이 약함(번역 제목/커버 오염 등) → 아티스트 고정 + 길이 중심.
  // 한국어 커버(피아노 버전 등)가 60~75점으로 폴백을 막는 문제 → 임계값 75.
  if (bestScore < 75 && A) {
    try {
      const artists = await spSearch(A, 'artist', 3);
      const cand = artists && artists[0];
      if (cand && cand.name) {
        const items = await spSearch(`artist:"${cand.name}"`, 'track', 50);
        for (const t of items) {
          const s = { ...t };
          if (!pool.has(s.uri)) {
            const { score } = scoreCandidate(entry, s, { artistLocked: true, resolvedArtistIds });
            s._score = Math.round(score * 10) / 10;
            s._locked = true;
            pool.set(s.uri, s);
            if (score > bestScore) { bestScore = score; best = s; artistLockedUsed = true; }
          }
        }
      }
    } catch (e) { if (isRateLimit(e)) throw e; /* 그 외 폴백 실패 무시 */ }
  }

  if (!best) return { tier: 'notfound', chosen: null, candidates: [] };

  let tier = classify(bestScore);
  if (artistLockedUsed && tier === 'auto') tier = 'review'; // 길이 중심 매칭은 자동 금지

  // 최초 공식 릴리스 선택 (같은 녹음의 다른 릴리스가 pool에 있으면 교체)
  let chosen = best;
  if (tier === 'auto') {
    chosen = pickOriginalRelease(best, [...pool.values()]);
    chosen._score = best._score;
  }

  const candidates = [...pool.values()]
    .sort((a, b) => (b._score || 0) - (a._score || 0))
    .slice(0, 5)
    .filter((c) => (c._score || 0) >= 40);

  return { tier: tier === 'reject' ? 'notfound' : tier, chosen, candidates, score: bestScore };
}

// ============ 변환 실행 (비동기, 상태는 storage) ============

// 아이콘 배지: 팝업이 닫혀 있어도 진행률이 보이게
async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    if (text) await chrome.action.setBadgeBackgroundColor({ color: color || '#1ed760' });
  } catch (e) { /* noop */ }
}

let converting = false;

function startConvert(video) {
  if (converting) return { ok: false, error: '이미 변환이 진행 중입니다' };
  if (!video || !video.tracks || !video.tracks.length) {
    return { ok: false, error: '트랙리스트가 없습니다' };
  }
  converting = true;
  // MV3 서비스 워커가 변환 도중 잠들지 않게 keepalive (20초 간격 API 핑)
  const keepalive = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) { /* noop */ } }, 20000);
  runConvert(video).catch(async (e) => {
    await patchState({ status: 'error', error: String((e && e.message) || e) });
    await setBadge('!', '#e05c5c');
  }).finally(() => { converting = false; clearInterval(keepalive); });
  return { ok: true, started: true };
}

async function patchState(patch) {
  const { convertState } = await chrome.storage.local.get('convertState');
  const next = Object.assign({}, convertState || {}, patch, { lastUpdate: Date.now() });
  await chrome.storage.local.set({ convertState: next });
  return next;
}

// 고아 상태 감지: 서비스 워커가 재시작됐는데 상태가 'running'이면
// 그 변환은 이전 워커와 함께 죽은 것 → 에러로 전환해 무한로딩 방지
(async () => {
  try {
    const { convertState } = await chrome.storage.local.get('convertState');
    if (convertState && convertState.status === 'running') {
      convertState.status = 'error';
      convertState.error = '변환이 중단되었습니다 (백그라운드 재시작). 다시 실행해주세요.';
      convertState.lastUpdate = Date.now();
      await chrome.storage.local.set({ convertState });
      await setBadge('!', '#e05c5c');
    }
  } catch (e) { /* noop */ }
})();

// 음악 카드(원제목·아티스트) → Spotify 정밀 매칭.
// 핵심: 쿼리에 제목+아티스트를 넣으면 Spotify가 표기(로마자↔일어) 별칭 매칭을 해줌.
// 따라서 아티스트 엔티티가 일치하는 결과는 제목 문자열 유사도가 0이어도 신뢰.
async function matchMusicCard(card) {
  const ids = await resolveArtistIds(card.artist);
  const pool = new Map();
  for (const q of [`track:"${card.title}" artist:"${card.artist}"`, `${card.artist} ${card.title}`]) {
    try {
      (await spSearch(q, 'track', 10)).forEach((t) => { if (!pool.has(t.uri)) pool.set(t.uri, { ...t }); });
    } catch (e) { if (isRateLimit(e)) throw e; }
    if (ids.length && [...pool.values()].some((c) => (c.artistIds || []).some((id) => ids.includes(id)))) break;
  }
  if (!pool.size) return null;
  const entry = { titleGuess: card.title, artistGuess: card.artist, label: `${card.artist} - ${card.title}`, durationSec: null };
  let best = null, bs = -1;
  for (const c of pool.values()) {
    let { score } = scoreCandidate(entry, c, { resolvedArtistIds: ids });
    if (ids.length && (c.artistIds || []).some((id) => ids.includes(id))) score = Math.max(score, 82);
    c._score = Math.round(score * 10) / 10;
    if (score > bs) { bs = score; best = c; }
  }
  if (bs < 80) return null;
  const chosen = pickOriginalRelease(best, [...pool.values()]);
  chosen._score = best._score;
  return { track: chosen, score: bs, cardArtistIds: ids };
}

async function runConvert(video) {
  await chrome.storage.local.set({
    convertState: {
      status: 'running', videoTitle: video.title, videoUrl: video.url || null,
      total: video.tracks.length, processed: 0,
      added: [], review: [], notFound: [], playlistId: null, playlistUrl: null,
    },
  });

  // 0) 음악 카드(원제목 소스) 사전 매칭 → 순서 보존 DP로 슬롯 정렬
  const preAssigned = new Map(); // slotIndex → {track, score, consistent}
  if (video.musicCards && video.musicCards.length) {
    const matches = [];
    for (const card of video.musicCards) {
      const m = await matchMusicCard(card);
      if (m) matches.push(m);
    }
    if (matches.length) {
      const slotMeta = [];
      for (const t of video.tracks) {
        slotMeta.push({
          durationSec: t.durationSec,
          artistGuess: t.artistGuess || '',
          artistIds: await resolveArtistIds(t.artistGuess || ''),
        });
      }
      const cardMeta = matches.map((m) => ({
        durationMs: m.track.durationMs,
        artistIds: [...new Set([...(m.track.artistIds || []), ...(m.cardArtistIds || [])])],
        artistNames: m.track.artists || [],
      }));
      for (const p of alignMusicCards(slotMeta, cardMeta)) {
        preAssigned.set(p.slotIndex, { ...matches[p.cardIndex], consistent: p.consistent });
      }
    }
  }

  // 1) 전 곡 매칭 (카드 배정 슬롯은 우선 처리)
  const auto = [], review = [], notFound = [];
  for (let i = 0; i < video.tracks.length; i++) {
    const entry = video.tracks[i];
    const item = {
      id: 'e' + i,
      label: entry.label || `${entry.artistGuess || ''} - ${entry.titleGuess || ''}`,
      time: entry.time || null,
    };
    const pre = preAssigned.get(i);
    if (pre) {
      if (pre.consistent) {
        auto.push({ ...item, track: pre.track, score: Math.max(pre.score, 90) });
      } else {
        // 원제목 카드는 원곡을 가리키는데 설명란 아티스트가 다름 (우타이테 커버 가능성)
        // → 자동 추가 금지, 원곡을 최상단 후보로 검토에 올림
        review.push({ ...item, candidates: [pre.track], score: pre.score });
      }
    } else {
      const r = await matchEntry(entry);
      if (r.tier === 'auto') auto.push({ ...item, track: r.chosen, score: r.score });
      else if (r.tier === 'review') review.push({ ...item, candidates: r.candidates, score: r.score });
      else notFound.push({ ...item, candidates: r.candidates });
    }
    await patchState({
      processed: i + 1,
      added: auto, review, notFound,
    });
    await setBadge(Math.round(((i + 1) / video.tracks.length) * 100) + '%');
  }

  // 2) 재생목록 생성 (이름 = 영상 제목, 중복 시 " (2)")
  // 2026-02 Spotify API 이관: POST /users/{id}/playlists → 403, POST /me/playlists 사용
  const name = await uniquePlaylistName(video.title);
  const desc = video.url ? `YouTube에서 변환: ${video.url}` : 'YouTube 노래 모음에서 변환';
  const pl = await apiPost('/me/playlists', { name, description: desc.slice(0, 300), public: false });

  // 3) 자동 매칭 곡 추가 (100개 배치) — 2026-02 이관: /tracks → /items
  const uris = auto.map((a) => a.track.uri);
  for (let i = 0; i < uris.length; i += 100) {
    await apiPost(`/playlists/${pl.id}/items`, { uris: uris.slice(i, i + 100) });
  }

  await patchState({
    status: 'done', playlistId: pl.id, playlistName: name,
    playlistUrl: (pl.external_urls && pl.external_urls.spotify) || null,
  });
  await setBadge('✓');
}

async function uniquePlaylistName(base) {
  base = (base || '변환된 재생목록').slice(0, 100);
  try {
    const data = await apiGet('/me/playlists?limit=50');
    const names = new Set((data.items || []).map((p) => p.name));
    if (!names.has(base)) return base;
    for (let n = 2; n < 20; n++) if (!names.has(`${base} (${n})`)) return `${base} (${n})`;
  } catch (e) { /* 조회 실패 시 그냥 base */ }
  return base;
}

// ============ 검토/수동 추가 ============

async function resolveReview(itemId, uri) {
  const { convertState: st } = await chrome.storage.local.get('convertState');
  if (!st || !st.playlistId) throw new Error('진행 중인 변환 결과가 없습니다');

  const inReview = (st.review || []).some((x) => x.id === itemId);
  const from = inReview ? 'review' : 'notFound';
  const item = (st[from] || []).find((x) => x.id === itemId);
  if (!item) throw new Error('항목을 찾을 수 없습니다');

  if (uri) {
    await apiPost(`/playlists/${st.playlistId}/items`, { uris: [uri] }); // 2026-02 이관
    st.added.push({ ...item, resolvedUri: uri });
  } else {
    (st.skipped = st.skipped || []).push(item);
  }
  st.review = (st.review || []).filter((x) => x.id !== itemId);
  st.notFound = (st.notFound || []).filter((x) => x.id !== itemId);
  st.lastResolve = { itemId, uri: uri || null, from }; // 되돌리기 1단계
  await chrome.storage.local.set({ convertState: st });
  return st;
}

// 마지막 검토 처리(추가/건너뛰기)를 한 단계 되돌린다.
async function undoResolve() {
  const { convertState: st } = await chrome.storage.local.get('convertState');
  if (!st) throw new Error('진행 중인 변환이 없습니다');
  const lr = st.lastResolve;
  if (!lr) throw new Error('되돌릴 작업이 없습니다');

  let item = null;
  if (lr.uri) {
    const idx = (st.added || []).findIndex((x) => x.id === lr.itemId && x.resolvedUri === lr.uri);
    if (idx >= 0) { item = st.added[idx]; st.added.splice(idx, 1); }
    try { await apiDelete(`/playlists/${st.playlistId}/tracks`, { tracks: [{ uri: lr.uri }] }); } catch (e) { /* best-effort */ }
  } else {
    const idx = (st.skipped || []).findIndex((x) => x.id === lr.itemId);
    if (idx >= 0) { item = st.skipped[idx]; st.skipped.splice(idx, 1); }
  }
  if (item) {
    const { resolvedUri, ...orig } = item; // resolvedUri 제거하고 원래 리스트로 복원
    (st[lr.from] = st[lr.from] || []).unshift(orig);
  }
  st.lastResolve = null;
  await chrome.storage.local.set({ convertState: st });
  return st;
}

async function manualSearch(query) {
  if (!query || !query.trim()) return [];
  return spSearch(query.trim(), 'track', 10); // 이미 간소화된 형태
}
