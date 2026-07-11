// popup.js — 팝업 UI 로직 (스켈레톤)
// 실제 매칭/OAuth/API 호출은 service-worker.js와 이후 단계에서 구현.

const state = {
  spotifyConnected: false,
  video: null, // { title, channel, tracks: [...] }
};

document.addEventListener('DOMContentLoaded', async () => {
  bindButtons();
  await loadCurrentVideo();
});

function bindButtons() {
  const connectBtn = document.getElementById('connect-btn');
  const convertBtn = document.getElementById('convert-btn');

  connectBtn.addEventListener('click', onConnectClick);
  convertBtn.addEventListener('click', onConvertClick);
}

// 현재 탭이 유튜브 영상이면 content script에서 정보 요청
async function loadCurrentVideo() {
  if (typeof chrome === 'undefined' || !chrome.tabs) return; // 미리보기 환경 방어
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/www\.youtube\.com\/watch/.test(tab.url || '')) {
      // 유튜브 영상 페이지가 아니면 안내 (지금은 목업 데이터 유지)
      return;
    }
    const info = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_INFO' });
    if (info && info.title) {
      state.video = info;
      renderVideo(info);
    }
  } catch (err) {
    // content script 미주입 등 — 지금은 조용히 목업 유지
    console.debug('[popup] video info 로드 실패:', err);
  }
}

function renderVideo(info) {
  document.getElementById('video-title').textContent = info.title;
  document.getElementById('video-channel').textContent =
    `${info.channel || ''}${info.tracks ? ` · ${info.tracks.length}곡 감지됨` : ''}`;
  // TODO: info.tracks 로 #track-list 렌더링 (매칭 상태 포함)
}

function onConnectClick() {
  // TODO: service-worker에 Spotify OAuth(PKCE) 시작 요청
  // chrome.runtime.sendMessage({ type: 'CONNECT_SPOTIFY' })
  state.spotifyConnected = !state.spotifyConnected;
  const status = document.getElementById('spotify-status');
  const btn = document.getElementById('connect-btn');
  if (state.spotifyConnected) {
    status.textContent = '연결됨';
    status.classList.add('on');
    btn.textContent = '연결 해제';
    btn.classList.remove('btn-green');
    btn.classList.add('btn-outline');
  } else {
    status.textContent = '연결 안 됨';
    status.classList.remove('on');
    btn.textContent = '연결';
    btn.classList.add('btn-green');
    btn.classList.remove('btn-outline');
  }
}

function onConvertClick() {
  if (!state.spotifyConnected) {
    // TODO: 토스트/안내 UI
    document.getElementById('spotify-status').textContent = '먼저 Spotify를 연결하세요';
    return;
  }
  // TODO: service-worker에 변환 요청
  // chrome.runtime.sendMessage({ type: 'CONVERT', video: state.video })
  const btn = document.getElementById('convert-btn');
  btn.textContent = '변환 중…';
  btn.disabled = true;
}
