// popup.js — 팝업 UI 로직
// Spotify 연결(1단계) 실제 동작 + 트랙리스트 동적 렌더(2단계).
// 유튜브 SPA 전환 대응: 콘텐츠 스크립트 온디맨드 주입 + 짧은 재시도.

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
  els.trackList = document.getElementById('track-list');
  els.stats = document.getElementById('stats');
  els.thumbImg = document.getElementById('thumb-img');
  els.thumbPh = document.getElementById('thumb-ph');
}

function bindButtons() {
  els.connectBtn.addEventListener('click', onConnectClick);
  els.convertBtn.addEventListener('click', onConvertClick);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendBg(message) {
  if (typeof chrome === 'undefined' || !chrome.runtime) return null;
  return chrome.runtime.sendMessage(message);
}

// --- Spotify 연결 상태 ---
async function refreshAuthState() {
  const res = await sendBg({ type: 'GET_AUTH_STATE' });
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
    await sendBg({ type: 'DISCONNECT_SPOTIFY' });
    setDisconnectedUI();
    return;
  }
  els.status.textContent = '연결 중…';
  const res = await sendBg({ type: 'CONNECT_SPOTIFY' });
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
  const res = await sendBg({ type: 'CONVERT', video: window.__video || null });
  if (!res || !res.ok) {
    els.convertBtn.textContent = '재생목록으로 변환';
    els.convertBtn.disabled = false;
    els.status.textContent = (res && res.error) || '변환 실패';
  }
}

// --- 현재 유튜브 영상 정보 ---
async function loadCurrentVideo() {
  if (typeof chrome === 'undefined' || !chrome.tabs) return; // 미리보기 방어
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const videoId = getVideoId(tab && tab.url);
  if (!videoId) {
    els.videoTitle.textContent = '유튜브 영상 페이지에서 열어주세요';
    els.videoChannel.textContent = '';
    renderTracks([]);
    return;
  }
  setThumbnail(videoId);

  // SPA 전환/지연 로딩 대응: 몇 번 재시도하며 점점 최신 데이터로 갱신
  let got = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const info = await getVideoInfo(tab.id, attempt === 0);
    if (info && info.title) {
      got = info;
      window.__video = info;
      renderVideo(info);
      if (info.tracks && info.tracks.length) break; // 트랙까지 잡히면 종료
    }
    await sleep(400);
  }
  if (!got) {
    els.videoTitle.textContent = '영상 정보를 읽지 못했어요 (새로고침 후 다시)';
    renderTracks([]);
  } else if (!got.tracks || !got.tracks.length) {
    renderTracks([]); // 트랙리스트 못 찾음 → 빈 상태
  }
}

async function getVideoInfo(tabId, allowInject) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_INFO' });
  } catch (e) {
    // 콘텐츠 스크립트 미주입(설치 전 열린 탭 등) → 온디맨드 주입 후 1회 재시도
    if (allowInject && chrome.scripting) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/lib/parse-tracklist.js', 'src/content/youtube-content.js'],
        });
        await sleep(150);
        return await chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_INFO' });
      } catch (e2) {
        console.debug('[popup] inject/재시도 실패:', e2);
      }
    }
    return null;
  }
}

function renderVideo(info) {
  els.videoTitle.textContent = info.title || '';
  els.videoChannel.textContent = info.channel || '';
  renderTracks(info.tracks || []);
}

function renderTracks(tracks) {
  els.trackList.innerHTML = '';
  if (!tracks.length) {
    const d = document.createElement('div');
    d.className = 'tl-empty';
    d.textContent = '이 영상에서 트랙리스트를 찾지 못했어요.\n설명란에 타임스탬프 목록이 있는 영상에서 동작해요.';
    d.style.whiteSpace = 'pre-line';
    els.trackList.appendChild(d);
    els.stats.textContent = '';
    return;
  }
  for (const t of tracks) {
    const row = document.createElement('div');
    row.className = 'track';
    row.innerHTML =
      `<span class="track-idx">${t.index}</span>` +
      `<div class="track-info"><div class="track-name"></div><div class="track-artist"></div></div>` +
      `<span class="dot pending" title="매칭 전"></span>`;
    row.querySelector('.track-name').textContent = t.titleGuess || t.label || '';
    row.querySelector('.track-artist').textContent = t.artistGuess || '';
    els.trackList.appendChild(row);
  }
  els.stats.innerHTML = `<span><b>${tracks.length}</b>곡 감지</span>`;
}

function setThumbnail(videoId) {
  if (!els.thumbImg) return;
  els.thumbImg.onload = () => {
    els.thumbImg.hidden = false;
    if (els.thumbPh) els.thumbPh.style.display = 'none';
  };
  els.thumbImg.onerror = () => { els.thumbImg.hidden = true; };
  els.thumbImg.src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

function getVideoId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    return u.searchParams.get('v');
  } catch (e) {
    return null;
  }
}
