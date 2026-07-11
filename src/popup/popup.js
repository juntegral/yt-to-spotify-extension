// popup.js — 팝업 UI
// 연결(1단계) + 트랙리스트(2단계) + 변환·검토·수동검색(3~5단계).
// 변환은 서비스 워커에서 진행 → 여기서는 상태 폴링/렌더만.

const els = {};
let pollTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
  cacheEls();
  bind();
  await refreshAuthState();
  const st = await getConvertState();
  if (st && st.status === 'running') { showView('progress'); renderProgress(st); startPolling(); }
  else if (st && st.status === 'done' && (st.review.length || st.notFound.length)) {
    showView('result'); renderResult(st);
  } else {
    showView('main');
    await loadCurrentVideo();
  }
});

function cacheEls() {
  ['view-main', 'view-progress', 'view-result', 'connect-btn', 'spotify-status', 'convert-btn',
   'video-title', 'video-channel', 'track-list', 'stats', 'thumb-img', 'thumb-ph',
   'prog-title', 'prog-text', 'prog-fill', 'res-title', 'sum-added', 'sum-review', 'sum-notfound',
   'playlist-link', 'review-section', 'review-list', 'notfound-section', 'notfound-list', 'done-btn']
    .forEach((id) => { els[id] = document.getElementById(id); });
}

function bind() {
  els['connect-btn'].addEventListener('click', onConnect);
  els['convert-btn'].addEventListener('click', onConvert);
  els['done-btn'].addEventListener('click', async () => {
    await send({ type: 'CLEAR_CONVERT' });
    showView('main');
    await loadCurrentVideo();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function send(msg) {
  if (typeof chrome === 'undefined' || !chrome.runtime) return null;
  try { return await chrome.runtime.sendMessage(msg); } catch (e) { return { ok: false, error: String(e) }; }
}
async function getConvertState() {
  const r = await send({ type: 'GET_CONVERT_STATE' });
  return r && r.ok ? r.state : null;
}
function showView(name) {
  for (const v of ['main', 'progress', 'result']) {
    els['view-' + v].classList.toggle('hidden', v !== name);
  }
}
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ===== 연결 =====
async function refreshAuthState() {
  const r = await send({ type: 'GET_AUTH_STATE' });
  if (r && r.connected) setConn(true, r.profile); else setConn(false);
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

// ===== 변환 =====
async function onConvert() {
  if (!els['connect-btn'].dataset.on) { els['spotify-status'].textContent = '먼저 Spotify를 연결하세요'; return; }
  const video = window.__video;
  if (!video || !video.tracks || !video.tracks.length) return;
  const r = await send({ type: 'CONVERT', video });
  if (!r || !r.ok) { els['stats'].textContent = (r && r.error) || '변환 시작 실패'; return; }
  els['prog-title'].textContent = video.title;
  showView('progress');
  startPolling();
}
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const st = await getConvertState();
    if (!st) return;
    if (st.status === 'running') renderProgress(st);
    else {
      stopPolling();
      if (st.status === 'done') { showView('result'); renderResult(st); }
      else { showView('main'); els['stats'].textContent = '변환 실패: ' + (st.error || '?'); }
    }
  }, 700);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function renderProgress(st) {
  els['prog-title'].textContent = st.videoTitle || '';
  els['prog-text'].textContent = `매칭 중… ${st.processed}/${st.total}`;
  els['prog-fill'].style.width = (st.total ? Math.round((st.processed / st.total) * 100) : 0) + '%';
}

// ===== 결과/검토 =====
function renderResult(st) {
  els['res-title'].textContent = st.videoTitle || '';
  els['sum-added'].textContent = (st.added || []).length;
  els['sum-review'].textContent = (st.review || []).length;
  els['sum-notfound'].textContent = (st.notFound || []).length;
  if (st.playlistUrl) { els['playlist-link'].href = st.playlistUrl; els['playlist-link'].classList.remove('hidden'); }
  else els['playlist-link'].classList.add('hidden');

  renderReviewList(st);
  renderNotFoundList(st);
}

function candRow(c, onPick) {
  const row = document.createElement('div');
  row.className = 'cand';
  row.innerHTML = `<div class="cand-info"><div class="cand-name"></div><div class="cand-sub"></div></div><span class="cand-dur"></span>`;
  row.querySelector('.cand-name').textContent = c.name;
  const albumBits = [c.artists.join(', '), c.album && c.album.name, c.album && c.album.releaseDate ? String(c.album.releaseDate).slice(0, 4) : null]
    .filter(Boolean).join(' · ');
  row.querySelector('.cand-sub').textContent = albumBits;
  row.querySelector('.cand-dur').textContent = c.durationMs ? fmtDur(c.durationMs) : '';
  row.addEventListener('click', () => onPick(c));
  return row;
}

function reviewItem(item, withCandidates) {
  const box = document.createElement('div');
  box.className = 'review-item';
  const head = document.createElement('div');
  head.className = 'ri-head';
  head.innerHTML = `<div class="ri-label"></div><span class="ri-time"></span>`;
  head.querySelector('.ri-label').textContent = item.label;
  head.querySelector('.ri-time').textContent = item.time || '';
  box.appendChild(head);

  const pick = async (c) => {
    box.style.opacity = '0.5';
    const r = await send({ type: 'RESOLVE_REVIEW', itemId: item.id, uri: c.uri });
    if (r && r.ok) renderResult(r.state);
    else box.style.opacity = '1';
  };

  if (withCandidates && item.candidates && item.candidates.length) {
    for (const c of item.candidates) box.appendChild(candRow(c, pick));
  }

  // 수동 검색 줄
  const sr = document.createElement('div');
  sr.className = 'search-row';
  const input = document.createElement('input');
  input.placeholder = 'Spotify에서 직접 검색…';
  const sbtn = document.createElement('button');
  sbtn.className = 'btn btn-green btn-xs';
  sbtn.textContent = '검색';
  sr.appendChild(input); sr.appendChild(sbtn);

  const resultsBox = document.createElement('div');
  const doSearch = async () => {
    if (!input.value.trim()) return;
    sbtn.disabled = true; sbtn.textContent = '…';
    const r = await send({ type: 'MANUAL_SEARCH', query: input.value });
    sbtn.disabled = false; sbtn.textContent = '검색';
    resultsBox.innerHTML = '';
    for (const c of (r && r.results) || []) resultsBox.appendChild(candRow(c, pick));
  };
  sbtn.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  const actions = document.createElement('div');
  actions.className = 'ri-actions';
  const skip = document.createElement('button');
  skip.className = 'btn btn-ghost btn-xs';
  skip.textContent = '건너뛰기';
  skip.addEventListener('click', async () => {
    const r = await send({ type: 'RESOLVE_REVIEW', itemId: item.id, uri: null });
    if (r && r.ok) renderResult(r.state);
  });
  actions.appendChild(skip);

  box.appendChild(sr);
  box.appendChild(resultsBox);
  box.appendChild(actions);
  return box;
}

function renderReviewList(st) {
  const list = els['review-list'];
  list.innerHTML = '';
  const items = st.review || [];
  els['review-section'].classList.toggle('hidden', !items.length);
  for (const it of items) list.appendChild(reviewItem(it, true));
}
function renderNotFoundList(st) {
  const list = els['notfound-list'];
  list.innerHTML = '';
  const items = st.notFound || [];
  els['notfound-section'].classList.toggle('hidden', !items.length);
  for (const it of items) list.appendChild(reviewItem(it, it.candidates && it.candidates.length > 0));
}
