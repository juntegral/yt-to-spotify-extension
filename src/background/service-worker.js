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
  scopes: ['playlist-modify-public', 'playlist-modify-private'],
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'CONNECT_SPOTIFY':
          sendResponse({ ok: true, profile: await connectSpotify() });
          break;
        case 'DISCONNECT_SPOTIFY':
          await disconnectSpotify();
          sendResponse({ ok: true });
          break;
        case 'GET_AUTH_STATE':
          sendResponse({ ok: true, ...(await getAuthState()) });
          break;
        case 'CONVERT':
          sendResponse(startConvert(message.video));
          break;
        case 'GET_CONVERT_STATE':
          sendResponse({ ok: true, state: (await chrome.storage.local.get('convertState')).convertState || null });
          break;
        case 'RESOLVE_REVIEW':
          sendResponse({ ok: true, state: await resolveReview(message.itemId, message.uri) });
          break;
        case 'MANUAL_SEARCH':
          sendResponse({ ok: true, results: await manualSearch(message.query) });
          break;
        case 'CLEAR_CONVERT':
          await chrome.storage.local.remove(['convertState', 'convertTabId']);
          await setBadge('');
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: 'unknown message: ' + message.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

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
  const res = await fetch(SPOTIFY.apiBase + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, ...((init && init.headers) || {}) },
  });
  if (res.status === 429 && attempt < 3) {
    const wait = (Number(res.headers.get('Retry-After')) || 1) * 1000 + 200;
    await sleep(wait);
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

// 검색 캐시 (세션 메모리)
const searchCache = new Map();
async function spSearch(q, type, limit) {
  type = type || 'track'; limit = limit || 10;
  const key = `${type}|${limit}|${q}`;
  if (searchCache.has(key)) return searchCache.get(key);
  const { spotifyProfile } = await chrome.storage.local.get('spotifyProfile');
  const market = spotifyProfile && spotifyProfile.country ? `&market=${spotifyProfile.country}` : '';
  const data = await apiGet(`/search?type=${type}&limit=${limit}${market}&q=${encodeURIComponent(q)}`);
  const items = type === 'track' ? (data.tracks?.items || []) : (data.artists?.items || []);
  searchCache.set(key, items);
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
    album: {
      name: t.album?.name, type: t.album?.album_type,
      releaseDate: t.album?.release_date,
      artists: (t.album?.artists || []).map((a) => a.name),
    },
  };
}

// ============ 매칭 파이프라인 ============

async function matchEntry(entry) {
  const pool = new Map(); // uri → simplified
  const addToPool = (items) => items.forEach((t) => { if (t && t.uri && !pool.has(t.uri)) pool.set(t.uri, simplify(t)); });

  const strategies = [];
  const T = (entry.titleGuess || '').trim(), A = (entry.artistGuess || '').trim();
  if (T && A) strategies.push(`track:"${T}" artist:"${A}"`);
  if (T && A) strategies.push(`${A} ${T}`);
  if (T && A) strategies.push(`track:"${A}" artist:"${T}"`); // 순서 모호 대비
  strategies.push(T || entry.label);

  let best = null, bestScore = -1;
  const rescore = () => {
    for (const c of pool.values()) {
      const { score } = scoreCandidate(entry, c);
      c._score = Math.round(score * 10) / 10;
      if (score > bestScore) { bestScore = score; best = c; }
    }
  };

  for (const q of strategies) {
    if (!q || !q.trim()) continue;
    try { addToPool(await spSearch(q, 'track', 10)); } catch (e) { /* 개별 쿼리 실패 무시 */ }
    rescore();
    if (bestScore >= 85) break; // 조기 종료 → API 절약
  }

  let artistLockedUsed = false;
  // 폴백: 텍스트 매칭 실패(번역 제목 등) → 아티스트 고정 + 길이 중심
  if (bestScore < 60 && A) {
    try {
      const artists = await spSearch(A, 'artist', 3);
      const cand = artists && artists[0];
      if (cand && cand.name) {
        const items = await spSearch(`artist:"${cand.name}"`, 'track', 50);
        for (const t of items) {
          const s = simplify(t);
          if (!pool.has(s.uri)) {
            const { score } = scoreCandidate(entry, s, { artistLocked: true });
            s._score = Math.round(score * 10) / 10;
            s._locked = true;
            pool.set(s.uri, s);
            if (score > bestScore) { bestScore = score; best = s; artistLockedUsed = true; }
          }
        }
      }
    } catch (e) { /* 폴백 실패 무시 */ }
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
  runConvert(video).catch(async (e) => {
    await patchState({ status: 'error', error: String((e && e.message) || e) });
    await setBadge('!', '#e05c5c');
  }).finally(() => { converting = false; });
  return { ok: true, started: true };
}

async function patchState(patch) {
  const { convertState } = await chrome.storage.local.get('convertState');
  const next = Object.assign({}, convertState || {}, patch);
  await chrome.storage.local.set({ convertState: next });
  return next;
}

async function runConvert(video) {
  await chrome.storage.local.set({
    convertState: {
      status: 'running', videoTitle: video.title, videoUrl: video.url || null,
      total: video.tracks.length, processed: 0,
      added: [], review: [], notFound: [], playlistId: null, playlistUrl: null,
    },
  });

  // 1) 전 곡 매칭
  const auto = [], review = [], notFound = [];
  for (let i = 0; i < video.tracks.length; i++) {
    const entry = video.tracks[i];
    const r = await matchEntry(entry);
    const item = {
      id: 'e' + i,
      label: entry.label || `${entry.artistGuess || ''} - ${entry.titleGuess || ''}`,
      time: entry.time || null,
    };
    if (r.tier === 'auto') auto.push({ ...item, track: r.chosen, score: r.score });
    else if (r.tier === 'review') review.push({ ...item, candidates: r.candidates, score: r.score });
    else notFound.push({ ...item, candidates: r.candidates });
    await patchState({
      processed: i + 1,
      added: auto, review, notFound,
    });
    await setBadge(Math.round(((i + 1) / video.tracks.length) * 100) + '%');
  }

  // 2) 재생목록 생성 (이름 = 영상 제목, 중복 시 " (2)")
  const me = await apiGet('/me');
  const name = await uniquePlaylistName(video.title);
  const desc = video.url ? `YouTube에서 변환: ${video.url}` : 'YouTube 노래 모음에서 변환';
  const pl = await apiPost(`/users/${me.id}/playlists`, { name, description: desc.slice(0, 300), public: false });

  // 3) 자동 매칭 곡 추가 (100개 배치)
  const uris = auto.map((a) => a.track.uri);
  for (let i = 0; i < uris.length; i += 100) {
    await apiPost(`/playlists/${pl.id}/tracks`, { uris: uris.slice(i, i + 100) });
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

  const pick = (arr) => (arr || []).find((x) => x.id === itemId);
  const item = pick(st.review) || pick(st.notFound);
  if (!item) throw new Error('항목을 찾을 수 없습니다');

  if (uri) {
    await apiPost(`/playlists/${st.playlistId}/tracks`, { uris: [uri] });
    st.added.push({ ...item, resolvedUri: uri });
  }
  st.review = (st.review || []).filter((x) => x.id !== itemId);
  st.notFound = (st.notFound || []).filter((x) => x.id !== itemId);
  if (uri == null) (st.skipped = st.skipped || []).push(item);
  await chrome.storage.local.set({ convertState: st });
  return st;
}

async function manualSearch(query) {
  if (!query || !query.trim()) return [];
  const items = await spSearch(query.trim(), 'track', 10);
  return items.map(simplify);
}
