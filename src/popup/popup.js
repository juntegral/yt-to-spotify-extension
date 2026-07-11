// popup.js — 팝업 UI 로직
// Spotify 연결은 실제 동작(1단계). 트랙리스트는 아직 목업(파서는 다음 단계).

const els = {};

document.addEventListener('DOMContentLoaded', async () => {
  cacheEls();
  bindButtons();
  await refreshAuthState();
  await loadCurrentVideo();
});

function cacheEls() {
  els.connectBtn = document.getElementById('connect-btn');
  els.status = document.getElementById('spotify-status');
  els.convertBtn = document.getElementById('convert-btn');
  els.videoTitle = document.getElementById('video-title');
  els.videoChannel = document.getElementById('video-channel');
}

function bindButtons() {
  els.connectBtn.addEventListener('click', onConnectClick);
  els.convertBtn.addEventListener('click', onConvertClick);
}

async function send(message) {
  if (typeof chrome === 'undefined' || !chrome.runtime) return null; // 미리보기 방어
  return chrome.runtime.sendMessage(message);
}

// --- Spotify 연결 상태 ---
async function refreshAuthState() {
  const res = await send({ type: 'GET_AUTH_STATE' });
  if (res && res.connected) setConnectedUI(res.profile);
  else setDisconnectedUI();
}

function setConnectedUI(profile) {
  els.status.textContent = profile && profile.name ? `연결됨 · ${profile.name}` : '연결됨';
  els.status.classList.add('on');
  els.connectBtn.textContent = '연결 해제';
  els.connectBtn.classList.remove('btn-green');
  els.connectBtn.classList.add('btn-outline');
  els.connectBtn.dataset.connected = 'true';
}

function setDisconnectedUI() {
  els.status.textContent = '연결 안 됨';
  els.status.classList.remove('on');
  els.connectBtn.textContent = '연결';
  els.connectBtn.classList.add('btn-green');
  els.connectBtn.classList.remove('btn-outline');
  els.connectBtn.dataset.connected = 'false';
}

async function onConnectClick() {
  if (els.connectBtn.dataset.connected === 'true') {
    await send({ type: 'DISCONNECT_SPOTIFY' });
    setDisconnectedUI();
    return;
  }
  els.status.textContent = '연결 중…';
  const res = await send({ type: 'CONNECT_SPOTIFY' });
  if (res && res.ok) setConnectedUI(res.profile);
  else els.status.textContent = '연결 실패: ' + ((res && res.error) || '알 수 없음');
}

async function onConvertClick() {
  if (els.connectBtn.dataset.connected !== 'true') {
    els.status.textContent = '먼저 Spotify를 연결하세요';
    return;
  }
  els.convertBtn.textContent = '변환 중…';
  els.convertBtn.disabled = true;
  const res = await send({ type: 'CONVERT', video: window.__video || null });
  if (!res || !res.ok) {
    els.convertBtn.textContent = '재생목록으로 변환';
    els.convertBtn.disabled = false;
    els.status.textContent = (res && res.error) || '변환 실패';
  }
}

// --- 현재 유튜브 영상 정보 ---
async function loadCurrentVideo() {
  if (typeof chrome === 'undefined' || !chrome.tabs) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/www\.youtube\.com\/watch/.test(tab.url || '')) return;
    const info = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_INFO' });
    if (info && info.title) {
      window.__video = info;
      els.videoTitle.textContent = info.title;
      const n = info.tracks ? info.tracks.length : 0;
      els.videoChannel.textContent = (info.channel || '') + (n ? ` · ${n}곡 감지됨` : '');
    }
  } catch (e) {
    console.debug('[popup] 영상 정보 로드 실패(콘텐츠 스크립트 미주입 등):', e);
  }
}
