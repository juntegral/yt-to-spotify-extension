// service-worker.js — 백그라운드 (MV3 서비스 워커)
// 1단계 구현: Spotify OAuth (Authorization Code + PKCE), 토큰 저장/갱신, API 헬퍼.
// 매칭/변환 파이프라인(3~4단계)은 아직 TODO.

const SPOTIFY = {
  authUrl: 'https://accounts.spotify.com/authorize',
  tokenUrl: 'https://accounts.spotify.com/api/token',
  apiBase: 'https://api.spotify.com/v1',
  clientId: '666f8565157f4c32b461d8fa9d9d1d6c', // PKCE 공개 클라이언트 — 노출돼도 안전
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
          sendResponse({ ok: true, result: await convertVideoToPlaylist(message.video) });
          break;
        default:
          sendResponse({ ok: false, error: 'unknown message: ' + message.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 비동기 응답
});

// --- PKCE 헬퍼 ---
function base64url(buf) {
  const str = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomVerifier() {
  return base64url(crypto.getRandomValues(new Uint8Array(64)));
}
async function challengeFromVerifier(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

// --- OAuth (Authorization Code + PKCE) ---
async function connectSpotify() {
  const redirectUri = chrome.identity.getRedirectURL(); // https://<id>.chromiumapp.org/
  const verifier = randomVerifier();
  const challenge = await challengeFromVerifier(verifier);
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

  const authUrl = new URL(SPOTIFY.authUrl);
  authUrl.search = new URLSearchParams({
    client_id: SPOTIFY.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SPOTIFY.scopes.join(' '),
    state,
  }).toString();

  const redirectResponse = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  const returned = new URL(redirectResponse);
  const error = returned.searchParams.get('error');
  const code = returned.searchParams.get('code');
  const returnedState = returned.searchParams.get('state');
  if (error) throw new Error('Spotify 인증 거부: ' + error);
  if (!code) throw new Error('인증 코드를 받지 못함');
  if (returnedState !== state) throw new Error('state 불일치 (보안 검증 실패)');

  const tokens = await exchangeCodeForTokens(code, verifier, redirectUri);
  await saveTokens(tokens);

  const profile = await apiGet('/me');
  const saved = { id: profile.id, name: profile.display_name };
  await chrome.storage.local.set({ spotifyProfile: saved });
  return saved;
}

async function exchangeCodeForTokens(code, verifier, redirectUri) {
  const res = await fetch(SPOTIFY.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: SPOTIFY.clientId,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error('토큰 교환 실패: ' + res.status + ' ' + (await res.text()));
  return res.json();
}

async function refreshTokens(refreshToken) {
  const res = await fetch(SPOTIFY.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: SPOTIFY.clientId,
    }),
  });
  if (!res.ok) throw new Error('토큰 갱신 실패: ' + res.status);
  return res.json();
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
  if (!refreshToken) throw new Error('세션 만료 — 다시 연결이 필요합니다');
  const refreshed = await refreshTokens(refreshToken);
  await saveTokens(refreshed);
  return refreshed.access_token;
}

async function getAuthState() {
  const { spotifyProfile, accessToken } =
    await chrome.storage.local.get(['spotifyProfile', 'accessToken']);
  return { connected: !!accessToken, profile: spotifyProfile || null };
}

async function disconnectSpotify() {
  await chrome.storage.local.remove(['accessToken', 'refreshToken', 'expiresAt', 'spotifyProfile']);
}

// --- Spotify API 헬퍼 ---
async function apiGet(path) {
  const token = await getAccessToken();
  const res = await fetch(SPOTIFY.apiBase + path, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('API GET ' + path + ' 실패: ' + res.status);
  return res.json();
}
async function apiPost(path, bodyObj) {
  const token = await getAccessToken();
  const res = await fetch(SPOTIFY.apiBase + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  if (!res.ok) throw new Error('API POST ' + path + ' 실패: ' + res.status);
  return res.json();
}

// --- 쓰기 경로 (변환 파이프라인에서 사용) ---
async function createPlaylist(name, description) {
  const me = await apiGet('/me');
  return apiPost(`/users/${me.id}/playlists`, { name, description: description || '', public: false });
}
async function addTracks(playlistId, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    await apiPost(`/playlists/${playlistId}/tracks`, { uris: uris.slice(i, i + 100) });
  }
}
async function searchTrack(query) {
  const data = await apiGet('/search?type=track&limit=5&q=' + encodeURIComponent(query));
  return data.tracks?.items || [];
}

// --- 변환 (매칭 파이프라인은 다음 단계) ---
async function convertVideoToPlaylist(video) {
  // TODO(3~4단계): tracks 정제 → searchTrack 매칭+신뢰도 → createPlaylist → addTracks → 미매칭 반환
  throw new Error('변환 파이프라인은 아직 미구현입니다 (다음 단계). 지금은 Spotify 연결까지 동작합니다.');
}
