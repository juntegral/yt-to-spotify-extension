// popup.js — 팝업은 "시작점"만 담당: 영상 감지 + Spotify 연결 + 변환 시작.
// 진행/결과/검토는 전용 탭(src/pages/convert.html)에서 — 팝업은 포커스를 잃으면
// 닫히는 크롬 특성 때문에 긴 작업 UI를 두지 않는다.

const els = {};

document.addEventListener('DOMContentLoaded', async () => {
  ['banner', 'banner-text', 'banner-btn', 'connect-btn', 'spotify-status', 'convert-btn',
   'video-title', 'video-channel', 'track-list', 'stats', 'thumb-img', 'thumb-ph']
    .forEach((id) => { els[id] = document.getElementById(id); });

  els['connect-btn'].addEventListener('click', onConnect);
  els['convert-btn'].addEventListener('click', onConvert);
  els['banner-btn'].addEventListener('click', openConvertTab);

  await refreshAuthState();
  await refreshBanner();
  await loadCurrentVideo();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function send(msg) {
  if (typeof chrome === 'undefined' || !chrome.runtime) return null;
  try { return await chrome.runtime.sendMessage(msg); } catch (e) { return { ok: false, error: String(e) }; }
}

// ===== 진행 배너 =====
async function refreshBanner() {
  const r = await send({ type: 'GET_CONVERT_STATE' });
  const st = r && r.ok ? r.state : null;
  if (!st) { els['banner'].classList.add('hidden'); return; }
  const pending = (st.review || []).length + (st.notFound || []).length;
  if (st.status === 'running') {
    els['banner-text'].innerHTML = `변환 중 <b>${st.processed}/${st.total}</b>`;
    els['banner'].classList.remove('hidden');
  } else if (st.status === 'done' && pending > 0) {
    els['banner-text'].innerHTML = `<b>${pending}곡</b> 확인 대기 중`;
    els['banner'].classList.remove('hidden');
  } else {
    els['banner'].classList.add('hidden');
  }
}

async function openConvertTab() {
  const url = chrome.runtime.getURL('src/pages/convert.html');
  const { convertTabId } = await chrome.storage.local.get('convertTabId');
  if (convertTabId != null) {
    try { await chrome.tabs.update(convertTabId, { active: true }); return; } catch (e) { /* 탭 닫힘 */ }
  }
  const tab = await chrome.tabs.create({ url });
  await chrome.storage.local.set({ convertTabId: tab.id });
}

// ===== Spotify 연결 =====
async function refreshAuthState() {
  const r = await send({ type: 'GET_AUTH_STATE' });
  setConn(!!(r && r.connected), r && r.profile);
}
function setConn(on, profile) {
  const st = els['spotify-status'], btn = els['connect-btn'];
  st.textContent = on ? (profile && profile.name ? `연결됨 · ${profile.name}` : '연결됨') : '연결 안 됨';
  st.classList.toggle('on', on);
  btn.textContent = on ? '연결 해제' : '연결';
  btn.classList.toggle('btn-green', !on);
  btn.classList.toggle('btn-outline', on);
  btn.dataset.on = on ? '1' : '';
}
async function onConnect() {
  if (els['connect-btn'].dataset.on) { await send({ type: 'DISCONNECT_SPOTIFY' }); setConn(false); return; }
  els['spotify-status'].textContent = '연결 중…';
  const r = await send({ type: 'CONNECT_SPOTIFY' });
  if (r && r.ok) setConn(true, r.profile);
  else els['spotify-status'].textContent = '연결 실패: ' + ((r && r.error) || '?');
}

// ===== 영상/트랙리스트 =====
async function loadCurrentVideo() {
  if (typeof chrome === 'undefined' || !chrome.tabs) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const vid = getVideoId(tab && tab.url);
  if (!vid) {
    els['video-title'].textContent = '유튜브 영상 페이지에서 열어주세요';
    els['video-channel'].textContent = '';
    renderTrackPreview([]);
    return;
  }
  setThumb(vid);
  let got = null;
  for (let i = 0; i < 4; i++) {
    const info = await getVideoInfo(tab.id, i === 0);
    if (info && info.title) {
      got = info; window.__video = info;
      els['video-title'].textContent = info.title;
      els['video-channel'].textContent = info.channel || '';
      renderTrackPreview(info.tracks || []);
      if (info.tracks && info.tracks.length) break;
    }
    await sleep(400);
  }
  if (!got) { els['video-title'].textContent = '영상 정보를 읽지 못했어요'; renderTrackPreview([]); }
}
async function getVideoInfo(tabId, inject) {
  try { return await chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_INFO' }); }
  catch (e) {
    if (inject && chrome.scripting) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/lib/parse-tracklist.js', 'src/content/youtube-content.js'],
        });
        await sleep(150);
        return await chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_INFO' });
      } catch (e2) { /* noop */ }
    }
    return null;
  }
}
function renderTrackPreview(tracks) {
  const list = els['track-list'];
  list.innerHTML = '';
  if (!tracks.length) {
    const d = document.createElement('div');
    d.className = 'tl-empty';
    d.textContent = '이 영상에서 트랙리스트를 찾지 못했어요.\n설명란에 타임스탬프 목록이 있는 영상에서 동작해요.';
    list.appendChild(d);
    els['stats'].textContent = '';
    els['convert-btn'].disabled = true;
    return;
  }
  els['convert-btn'].disabled = false;
  for (const t of tracks) {
    const row = document.createElement('div');
    row.className = 'track';
    row.innerHTML = `<span class="track-idx">${t.index}</span><div class="track-info"><div class="track-name"></div><div class="track-artist"></div></div>`;
    row.querySelector('.track-name').textContent = t.titleGuess || t.label || '';
    row.querySelector('.track-artist').textContent = t.artistGuess || '';
    list.appendChild(row);
  }
  els['stats'].innerHTML = `<span><b>${tracks.length}</b>곡 감지</span>`;
}
function setThumb(id) {
  els['thumb-img'].onload = () => { els['thumb-img'].hidden = false; els['thumb-ph'].style.display = 'none'; };
  els['thumb-img'].onerror = () => { els['thumb-img'].hidden = true; };
  els['thumb-img'].src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}
function getVideoId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return /(^|\.)youtube\.com$/.test(u.hostname) ? u.searchParams.get('v') : null;
  } catch (e) { return null; }
}

// ===== 변환 시작 → 전용 탭 열기 =====
async function onConvert() {
  if (!els['connect-btn'].dataset.on) { els['spotify-status'].textContent = '먼저 Spotify를 연결하세요'; return; }
  const video = window.__video;
  if (!video || !video.tracks || !video.tracks.length) return;
  els['convert-btn'].disabled = true;
  const r = await send({ type: 'CONVERT', video });
  if (!r || !r.ok) {
    els['convert-btn'].disabled = false;
    els['stats'].textContent = (r && r.error) || '변환 시작 실패';
    return;
  }
  await openConvertTab(); // 탭이 열리면 팝업은 자연히 닫힘 (정상)
}
