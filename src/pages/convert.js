// convert.js — 변환 진행상황/검토 전용 탭 페이지.
// 팝업과 달리 포커스를 잃어도 닫히지 않음. 상태는 storage 폴링.

const $ = (id) => document.getElementById(id);
let pollTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
  $('clear-btn').addEventListener('click', async () => {
    await send({ type: 'CLEAR_CONVERT' });
    window.close();
  });
  const st = await getState();
  render(st);
  startPolling();
});

async function send(msg) {
  try { return await chrome.runtime.sendMessage(msg); } catch (e) { return { ok: false, error: String(e) }; }
}
async function getState() {
  const r = await send({ type: 'GET_CONVERT_STATE' });
  return r && r.ok ? r.state : null;
}
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const st = await getState();
    if (!st || st.status !== 'running') stopPolling();
    render(st);
  }, 700);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function show(id, on) { $(id).classList.toggle('hidden', !on); }

function render(st) {
  if (!st) {
    $('video-title').textContent = '진행 중인 변환이 없습니다';
    show('view-progress', false); show('view-result', false); show('view-error', false);
    return;
  }
  $('video-title').textContent = st.videoTitle || '';

  if (st.status === 'running') {
    show('view-progress', true); show('view-result', false); show('view-error', false);
    $('sub').textContent = '변환 중';
    $('prog-text').textContent = `매칭 중… ${st.processed}/${st.total}`;
    $('prog-fill').style.width = (st.total ? Math.round((st.processed / st.total) * 100) : 0) + '%';
    return;
  }
  if (st.status === 'error') {
    show('view-progress', false); show('view-result', false); show('view-error', true);
    $('sub').textContent = '오류';
    $('error-text').textContent = '변환 실패: ' + (st.error || '알 수 없는 오류');
    return;
  }
  // done
  show('view-progress', false); show('view-error', false); show('view-result', true);
  $('sub').textContent = '완료';
  renderResult(st);
}

function renderResult(st) {
  $('sum-added').textContent = (st.added || []).length;
  $('sum-review').textContent = (st.review || []).length;
  $('sum-notfound').textContent = (st.notFound || []).length;

  const link = $('playlist-link');
  if (st.playlistUrl) { link.href = st.playlistUrl; link.classList.remove('hidden'); }

  renderList('review-section', 'review-list', st.review || [], true);
  renderList('notfound-section', 'notfound-list', st.notFound || [], false);
  show('all-done', !(st.review || []).length && !(st.notFound || []).length);
}

function renderList(sectionId, listId, items, withCandidates) {
  const list = $(listId);
  list.innerHTML = '';
  show(sectionId, items.length > 0);
  for (const it of items) list.appendChild(reviewItem(it, withCandidates || (it.candidates && it.candidates.length)));
}

function candRow(c, onPick) {
  const row = document.createElement('div');
  row.className = 'cand';
  row.innerHTML =
    `<div class="cand-info"><div class="cand-name"></div><div class="cand-sub"></div></div>` +
    `<span class="cand-dur"></span><span class="cand-add">추가</span>`;
  row.querySelector('.cand-name').textContent = c.name;
  row.querySelector('.cand-sub').textContent = [
    (c.artists || []).join(', '),
    c.album && c.album.name,
    c.album && c.album.releaseDate ? String(c.album.releaseDate).slice(0, 4) : null,
  ].filter(Boolean).join(' · ');
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
    if (r && r.ok) render(r.state);
    else box.style.opacity = '1';
  };

  if (withCandidates && item.candidates) {
    for (const c of item.candidates) box.appendChild(candRow(c, pick));
  }

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
    if (r && r.ok) render(r.state);
  });
  actions.appendChild(skip);

  box.appendChild(sr);
  box.appendChild(resultsBox);
  box.appendChild(actions);
  return box;
}
