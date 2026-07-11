// service-worker.js — 백그라운드 (MV3 서비스 워커) 스켈레톤
// 역할: Spotify OAuth(PKCE), 검색/매칭, 재생목록 생성·추가 오케스트레이션.
// 현재는 메시지 라우팅 골격 + TODO 스텁만 존재.

const SPOTIFY = {
  authUrl: 'https://accounts.spotify.com/authorize',
  tokenUrl: 'https://accounts.spotify.com/api/token',
  apiBase: 'https://api.spotify.com/v1',
  // TODO: 1단계에서 발급받은 Client ID 입력 (PKCE 공개 클라이언트라 노출돼도 안전)
  clientId: '',
  scopes: ['playlist-modify-public', 'playlist-modify-private'],
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'CONNECT_SPOTIFY':
      connectSpotify().then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
      return true; // async 응답

    case 'CONVERT':
      convertVideoToPlaylist(message.video)
        .then(sendResponse)
        .catch((e) => sendResponse({ error: String(e) }));
      return true;

    default:
      return false;
  }
});

// --- Spotify OAuth (Authorization Code + PKCE) ---
async function connectSpotify() {
  // TODO:
  //  1) code_verifier / code_challenge 생성
  //  2) chrome.identity.launchWebAuthFlow 로 authorize
  //  3) code → token 교환 (tokenUrl)
  //  4) chrome.storage 에 access/refresh token 저장
  throw new Error('connectSpotify: 미구현 (1단계)');
}

// --- 변환 파이프라인 ---
async function convertVideoToPlaylist(video) {
  // TODO 파이프라인:
  //  1) video.tracks 정제(normalize)
  //  2) 각 트랙 Spotify 검색 + 신뢰도 점수 → 매칭
  //  3) 재생목록 생성 (이름 = video.title)
  //  4) 매칭된 트랙 uri 를 100개 배치로 추가
  //  5) 미매칭 목록 반환
  throw new Error('convertVideoToPlaylist: 미구현 (3~4단계)');
}

// --- Spotify API 헬퍼 (스텁) ---
async function searchTrack(query) {
  // TODO: GET /search?type=track — 아티스트/제목/재생시간 비교로 최적 매치
}

async function createPlaylist(userId, name) {
  // TODO: POST /users/{userId}/playlists
}

async function addTracks(playlistId, uris) {
  // TODO: POST /playlists/{id}/tracks — 요청당 최대 100개
}
