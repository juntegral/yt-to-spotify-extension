"use strict";
/* ═══════════════════════════════════════════════════════════════
   MIXTAPE · convert.js — 전용 탭(프로덕션).
   GET_CONVERT_STATE 700ms 폴링 → data-state + 전체 렌더.
   검토 추가(RESOLVE_REVIEW) · 건너뛰기 · 직접검색(MANUAL_SEARCH) ·
   되돌리기(UNDO_RESOLVE) · 재생목록 열기 · 미리듣기(Spotify 임베드).
   Apple 변환은 미구현 → 서비스는 Spotify 고정.
   ═══════════════════════════════════════════════════════════════ */

const doc = document.documentElement;
const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* ───────── 메시지 API ───────── */
async function send(msg) {
  if (typeof chrome === "undefined" || !chrome.runtime) return { ok: false, error: "no-chrome" };
  try { return await chrome.runtime.sendMessage(msg); } catch (e) { return { ok: false, error: String(e) }; }
}
async function getState() { const r = await send({ type: "GET_CONVERT_STATE" }); return r && r.ok ? r.state : null; }

/* ───────── 폴링 ───────── */
let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const st = await getState();
    if (!st || st.status !== "running") stopPolling();
    render(st);
  }, 700);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

/* ───────── 유틸 ───────── */
function txt(el, s) { if (el) el.textContent = s == null ? "" : String(s); }
function fmtMs(ms) { const s = Math.max(0, Math.round((ms || 0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function fmtSec(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function itemTime(it) {
  if (it && it.time) return it.time;
  if (it && it.startSec != null) return fmtSec(it.startSec);
  if (it && it.timeSec != null) return fmtSec(it.timeSec);
  return "";
}
function grad(seed) {
  let h = 0; seed = String(seed || "");
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const a = h % 360, b = (a + 28) % 360;
  return `linear-gradient(145deg,hsl(${a} 40% 44%),hsl(${b} 42% 27%))`;
}
/* 후보/트랙 정규화 — auto added는 {track}, 후보는 그대로, 수동 added는 {resolvedUri}만 */
function view(c) {
  if (!c) return { name: "", artists: "", album: "", year: "", durMs: 0, image: null, id: "", uri: "" };
  const t = c.track || c;
  const arts = t.artists;
  const image = t.image || (t.album && (t.album.image || (t.album.images && t.album.images[0] && t.album.images[0].url))) || null;
  return {
    id: t.id || ((t.uri || "").split(":")[2]) || "",
    uri: t.uri || (t.id ? `spotify:track:${t.id}` : (c.resolvedUri || "")),
    name: t.name || c.titleGuess || c.label || "",
    artists: Array.isArray(arts) ? arts.join(", ") : (arts || c.artistGuess || ""),
    album: (t.album && t.album.name) || "",
    year: (t.album && String(t.album.releaseDate || t.album.release_date || "").slice(0, 4)) || "",
    durMs: t.durationMs || t.duration_ms || 0,
    image,
  };
}
function artStyle(v) {
  return v.image
    ? `background-image:url('${v.image}');background-size:cover;background-position:center`
    : `background:${grad(v.name || v.id)}`;
}

/* ───────── SVG 조각 ───────── */
const SVG = {
  play: '<svg width="15" height="15" viewBox="0 0 14 14" aria-hidden="true"><path d="M3.5 1.8l8 5.2-8 5.2z" fill="#fff"/></svg>',
  check: '<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6.4" fill="var(--acc)"/><path d="M4.2 7.3l1.9 1.9 3.7-4" fill="none" stroke="var(--on-acc)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search: '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4.6" stroke="var(--t3)" stroke-width="1.4"/><path d="M9.5 9.5L13 13" stroke="var(--t3)" stroke-width="1.4" stroke-linecap="round"/></svg>',
  skip: '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 1.5l6 4.5-6 4.5zM9.3 1.5h1.6v9H9.3z" fill="currentColor"/></svg>',
  arrow: '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1 5h7M5.4 1.8L8.6 5 5.4 8.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  doneCheck: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2.5 7.5L5.5 10.5L11.5 3.5" stroke="var(--acc)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/* ───────── 상태 → data-state ───────── */
function stateName(st) {
  if (!st) return "empty";
  if (st.status === "running") return "running";
  if (st.status === "error") return "error";
  const pending = (st.review || []).length + (st.notFound || []).length;
  return pending > 0 ? "result" : "complete";
}

/* ───────── 렌더 ───────── */
let lastState = null;
function render(st) {
  lastState = st;
  const name = stateName(st);
  doc.setAttribute("data-state", name === "empty" ? "error" : name);

  if (!st) { renderEmpty(); return; }

  const title = st.videoTitle || "변환";
  // 헤더 타이틀
  const added = st.added || [], review = st.review || [], notFound = st.notFound || [];
  const total = st.total || (added.length + review.length + notFound.length);
  const hd = document.querySelector(".hd-title");
  if (hd) hd.innerHTML = `<span></span>`, txt(hd.firstChild, `${title} · ${total}곡`);

  if (st.status === "running") { renderRunning(st, title, total); return; }
  if (st.status === "error") { renderError(st); return; }
  renderResult(st, title, total, added, review, notFound);
}

function renderEmpty() {
  const et = $("error-text");
  if (et) et.textContent = "진행 중인 변환이 없어요. 팝업에서 유튜브 영상을 열고 변환을 시작하세요.";
}

function renderRunning(st, title, total) {
  txt($("video-title-run"), title);
  txt($("prog-n"), st.processed || 0);
  const of = document.querySelector(".prog-count .of");
  if (of) of.textContent = `/ ${total}`;
  const now = document.querySelector(".prog-now");
  if (now) now.textContent = st.current ? `지금 매칭 — ${st.current}` : "매칭 중…";
  const fill = $("prog-fill");
  if (fill) fill.style.width = (total ? Math.round((st.processed / total) * 100) : 0) + "%";
  const sub = document.querySelector(".prog-video-sub");
  if (sub) sub.innerHTML = `<span class="num">${total}곡</span> 인식됨`;
}

function renderError(st) {
  const et = $("error-text");
  if (et) et.textContent = "변환 실패: " + (st.error || "알 수 없는 오류");
  const act = document.querySelector('[data-show="error"] .act');
  if (act && !act.dataset.wired) {
    act.dataset.wired = "1";
    const [reconnect, restart] = act.querySelectorAll("button");
    if (reconnect) reconnect.addEventListener("click", async () => { await send({ type: "CONNECT_SPOTIFY" }); location.reload(); });
    if (restart) restart.addEventListener("click", async () => { await send({ type: "CLEAR_CONVERT" }); window.close(); });
  }
}

function renderResult(st, title, total, added, review, notFound) {
  // 히어로 타이틀 · 카운트
  document.querySelectorAll(".hero-sp h1, .hero-ap h1").forEach((h) => txt(h, title));
  document.querySelectorAll(".js-hero-count").forEach((e) => txt(e, `${total}곡 중 ${added.length}곡 추가`));
  const rl = document.querySelector(".review-left");
  if (rl) txt(rl, `검토 ${review.length}곡 남음`);

  // 콜라주 (추가된 트랙 앞 4곡 아트)
  setCollage(added);

  // 요약 비례 바 + 숫자
  txt($("sum-added"), added.length);
  txt($("sum-review"), review.length);
  txt($("sum-notfound"), notFound.length);
  const bAdd = document.querySelector(".tally-bar .b-add"),
        bRev = document.querySelector(".tally-bar .b-rev"),
        bMis = document.querySelector(".tally-bar .b-mis");
  if (bAdd) bAdd.style.flex = String(Math.max(0, added.length) || 0.001);
  if (bRev) bRev.style.flex = String(Math.max(0, review.length) || 0.001);
  if (bMis) bMis.style.flex = String(Math.max(0, notFound.length) || 0.001);

  // 추가됨 밴드
  txt($("added-count"), `${added.length}곡`);
  const l2 = document.querySelector(".added-meta .l2");
  if (l2) txt(l2, `${title} · MIXTAPE`);

  // 열기 링크들
  wireOpen(st.playlistUrl);

  // 카운트
  txt($("review-count"), review.length);
  txt($("notfound-count"), notFound.length);
  const rr = $("review-rail");
  if (rr) rr.style.width = (total ? Math.round((added.length / total) * 100) : 0) + "%";

  // 목록
  renderAddedTable(added);
  renderReviewList(review);
  renderNotFoundList(notFound);

  // 완료 문구
  if (stateName(st) === "complete") {
    const b = document.querySelector(".alldone .b");
    if (b) b.innerHTML = `<span class="num">${total}곡 중 ${added.length}곡</span>이 재생목록에 실렸어요 · 건너뛴 <span class="num">${(st.skipped || []).length}곡</span>은 기록에 남아있어요`;
  }
}

function setCollage(added) {
  const arts = added.map((a) => view(a)).slice(0, 4);
  document.querySelectorAll(".collage, .added-band .stack").forEach((box) => {
    const cells = box.children;
    for (let i = 0; i < cells.length; i++) {
      const v = arts[i % (arts.length || 1)] || {};
      cells[i].setAttribute("style", artStyle(v));
    }
  });
}

function wireOpen(url) {
  const openers = [
    $("playlist-link"),
    document.querySelector(".added-band .btn-acc"),
    document.querySelector(".hero-actions .play-cir"),
    document.querySelector(".alldone .btn-acc"),
  ].filter(Boolean);
  openers.forEach((btn) => {
    btn.onclick = () => { if (url) chrome.tabs ? chrome.tabs.create({ url }) : window.open(url, "_blank"); };
    btn.classList.toggle("is-disabled", !url);
  });
  const link = $("playlist-link");
  if (link && url) link.setAttribute("data-url", url);
}

/* ───────── 추가된 트랙 테이블 ───────── */
function renderAddedTable(added) {
  const box = $("added-rows");
  if (!box) return;
  box.innerHTML = "";
  added.forEach((a, i) => {
    const v = view(a);
    const row = document.createElement("div");
    row.className = "trow";
    row.innerHTML =
      `<span class="idx num">${i + 1}</span>` +
      `<div class="main"><div class="art" style="${artStyle(v)}"></div>` +
      `<div style="min-width:0"><div class="name"></div><div class="artist"></div></div></div>` +
      `<span class="album"></span>` +
      `<div class="end">${SVG.check}<span class="dur num">${v.durMs ? fmtMs(v.durMs) : ""}</span></div>`;
    txt(row.querySelector(".name"), v.name);
    txt(row.querySelector(".artist"), v.artists);
    txt(row.querySelector(".album"), v.album);
    box.appendChild(row);
  });
}

/* ───────── 후보 행 ───────── */
function candEl(c, onAdd) {
  const v = view(c);
  const cand = document.createElement("div");
  cand.className = "cand";
  cand.setAttribute("role", "button");
  cand.tabIndex = 0;
  cand.setAttribute("aria-expanded", "false");
  cand.innerHTML =
    `<div class="art" style="${artStyle(v)}"><div class="ply">${SVG.play}</div></div>` +
    `<div class="meta"><div class="name"></div><div class="sub"></div></div>` +
    `<span class="dur num">${v.durMs ? fmtMs(v.durMs) : ""}</span>` +
    `<button type="button" class="add-btn">추가</button>`;
  txt(cand.querySelector(".name"), v.name);
  txt(cand.querySelector(".sub"), [v.artists, v.album, v.year].filter(Boolean).join(" · "));
  cand.querySelector(".add-btn").addEventListener("click", (e) => { e.stopPropagation(); onAdd(v.uri); });

  // 행 클릭 → Spotify 임베드 미리듣기 토글
  const holder = document.createElement("div");
  holder.className = "cand-embed";
  cand.addEventListener("click", () => toggleEmbed(cand, holder, v.id));
  cand.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleEmbed(cand, holder, v.id); } });

  const frag = document.createDocumentFragment();
  frag.appendChild(cand);
  frag.appendChild(holder);
  return frag;
}
function toggleEmbed(cand, holder, id) {
  const open = cand.getAttribute("aria-expanded") === "true";
  // 같은 목록의 다른 임베드 닫기
  const scope = cand.closest(".rcard") || document;
  scope.querySelectorAll('.cand[aria-expanded="true"]').forEach((c) => c.setAttribute("aria-expanded", "false"));
  scope.querySelectorAll(".cand-embed").forEach((h) => (h.innerHTML = ""));
  if (open || !id) return;
  cand.setAttribute("aria-expanded", "true");
  const f = document.createElement("iframe");
  f.src = `https://open.spotify.com/embed/track/${id}?utm_source=generator`;
  f.width = "100%"; f.height = "80"; f.loading = "lazy";
  f.style.border = "0"; f.style.borderRadius = "10px"; f.style.marginTop = "8px";
  f.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
  holder.appendChild(f);
}

/* ───────── 검토/못찾음 카드 공통 골격 ───────── */
function baseCard(item, srcMicro) {
  const card = document.createElement("article");
  card.className = "panel rcard";
  card.dataset.id = item.id;
  card.innerHTML =
    `<div class="origin">` +
      `<div class="tick-col"><span class="tick" aria-hidden="true"></span><span class="tc num"></span></div>` +
      `<div class="origin-main"><div class="origin-name"></div><div class="origin-micro"></div></div>` +
    `</div>` +
    `<div class="done">${SVG.doneCheck}<span class="res"></span>` +
      `<button type="button" class="btn btn-ghost btn-xs undo-btn">되돌리기</button></div>` +
    `<div class="body"></div>`;
  txt(card.querySelector(".tc"), itemTime(item));
  txt(card.querySelector(".origin-name"), item.label || item.titleGuess || "");
  card.querySelector(".origin-micro").innerHTML = srcMicro;
  card.querySelector(".undo-btn").addEventListener("click", () => undoResolve());
  return card;
}
function manualRow(onSearch, withSkip, onSkip) {
  const m = document.createElement("div");
  m.className = "manual";
  m.style.paddingTop = "12px";
  m.innerHTML =
    `<div class="field">${SVG.search}<input type="text" placeholder="곡명·아티스트로 직접 검색" aria-label="직접 검색" /></div>` +
    `<button type="button" class="btn btn-ghost btn-sm search-btn">검색</button>` +
    (withSkip ? `<button type="button" class="link-quiet skip-btn">${SVG.skip}건너뛰기</button>` : "");
  const input = m.querySelector("input"), sbtn = m.querySelector(".search-btn");
  const go = () => onSearch(input.value, sbtn);
  sbtn.addEventListener("click", go);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  if (withSkip) m.querySelector(".skip-btn").addEventListener("click", onSkip);
  return m;
}

function reviewCardEl(item) {
  const n = (item.candidates || []).length;
  const card = baseCard(item, `YOUTUBE 원본 ${SVG.arrow} <span class="sp-only">SPOTIFY 후보 ${n}</span>`);
  const body = card.querySelector(".body");
  const onAdd = (uri) => resolve(item.id, uri);

  const cands = document.createElement("div");
  cands.className = "cands";
  (item.candidates || []).forEach((c) => cands.appendChild(candEl(c, onAdd)));
  body.appendChild(cands);

  // 직접검색 + 건너뛰기
  const results = document.createElement("div");
  results.className = "nf-results";
  const manual = manualRow(
    (q, sbtn) => doSearch(q, sbtn, results, onAdd),
    true,
    () => resolve(item.id, null)
  );
  body.appendChild(manual);
  body.appendChild(results);
  return card;
}

function notFoundCardEl(item) {
  const pre = (item.candidates || []).length;
  const card = baseCard(item, "");
  // origin-micro → nf-src
  const micro = card.querySelector(".origin-micro");
  micro.className = "nf-src";
  micro.textContent = pre ? `후보 ${pre}곡 · 확인 필요` : "트랙리스트 원문 · 일치 결과 없음";
  card.querySelector(".tick").style.background = "var(--t3)";
  const body = card.querySelector(".body");
  const onAdd = (uri) => resolve(item.id, uri);

  const results = document.createElement("div");
  results.className = "nf-results";
  (item.candidates || []).forEach((c) => results.appendChild(candEl(c, onAdd)));

  const manual = manualRow(
    (q, sbtn) => doSearch(q, sbtn, results, onAdd),
    true,
    () => resolve(item.id, null)
  );
  body.appendChild(manual);
  body.appendChild(results);
  return card;
}

function renderReviewList(review) {
  const box = $("review-list");
  if (!box) return;
  box.innerHTML = "";
  review.forEach((it) => box.appendChild(reviewCardEl(it)));
}
function renderNotFoundList(notFound) {
  const box = $("notfound-list");
  if (!box) return;
  box.innerHTML = "";
  notFound.forEach((it) => box.appendChild(notFoundCardEl(it)));
}

/* ───────── 직접 검색 ───────── */
async function doSearch(query, sbtn, resultsBox, onAdd) {
  if (!query || !query.trim()) return;
  const old = sbtn.textContent;
  sbtn.disabled = true; sbtn.textContent = "…";
  const r = await send({ type: "MANUAL_SEARCH", query });
  sbtn.disabled = false; sbtn.textContent = old;
  resultsBox.innerHTML = "";
  const list = (r && r.results) || [];
  if (!list.length) {
    resultsBox.appendChild(el("div", "searching", "검색 결과가 없어요"));
    return;
  }
  list.forEach((c) => resultsBox.appendChild(candEl(c, onAdd)));
}

/* ───────── resolve / undo ───────── */
async function resolve(itemId, uri) {
  const r = await send({ type: "RESOLVE_REVIEW", itemId, uri });
  if (r && r.ok) {
    render(r.state);
    const name = uri ? (findAddedName(r.state, itemId)) : null;
    showToast(uri ? `${name ? '"' + name + '" ' : ""}재생목록에 추가했어요` : "건너뛰었어요 — 되돌릴 수 있어요");
  } else {
    showToast("실패: " + ((r && r.error) || "?"), true);
  }
}
function findAddedName(st, itemId) {
  const a = (st.added || []).find((x) => x.id === itemId);
  return a ? view(a).name : "";
}
async function undoResolve() {
  const r = await send({ type: "UNDO_RESOLVE" });
  if (r && r.ok) { render(r.state); hideToast(); }
  else showToast("되돌리기 실패", true);
}

/* ───────── 토스트 ───────── */
let toastT = null;
function showToast(msg, isErr) {
  const t = $("toast"), m = $("toast-msg");
  if (!t || !m) return;
  m.textContent = msg;
  t.classList.toggle("err", !!isErr);
  t.classList.add("on");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("on"), 4600);
}
function hideToast() { const t = $("toast"); if (t) t.classList.remove("on"); }

/* ───────── 스티키 헤더 응축 + 읽기 레일 ───────── */
const hd = $("hd"), hdProg = $("hd-prog");
let hdRaf = 0;
function onScroll() {
  cancelAnimationFrame(hdRaf);
  hdRaf = requestAnimationFrame(() => {
    const y = window.scrollY;
    if (hd) hd.classList.toggle("scrolled", y > 28);
    if (hdProg) {
      const max = document.body.scrollHeight - window.innerHeight;
      hdProg.style.width = `${max > 0 ? Math.min(1, y / max) * 100 : 0}%`;
    }
  });
}
window.addEventListener("scroll", onScroll, { passive: true });

/* ───────── 인터랙티브 모션(커서 틸트 + 스크롤 등장) ───────── */
function motionLayer() {
  if (reduceMotion.matches) return;
  const MAX = 7;
  document.querySelectorAll(".hero-sp, .hero-ap").forEach((hero) => {
    const collage = hero.querySelector(".collage");
    if (!collage) return;
    let frame = 0;
    hero.addEventListener("pointerenter", () => collage.classList.add("lit"));
    hero.addEventListener("pointermove", (e) => {
      cancelAnimationFrame(frame);
      const r = hero.getBoundingClientRect(), cr = collage.getBoundingClientRect();
      const nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      const ny = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      const mx = ((e.clientX - cr.left) / cr.width) * 100, my = ((e.clientY - cr.top) / cr.height) * 100;
      frame = requestAnimationFrame(() => {
        collage.style.transform = `perspective(640px) rotateX(${(-ny * MAX).toFixed(2)}deg) rotateY(${(nx * MAX).toFixed(2)}deg) scale(1.02)`;
        collage.style.setProperty("--mx", mx.toFixed(1) + "%");
        collage.style.setProperty("--my", my.toFixed(1) + "%");
      });
    });
    hero.addEventListener("pointerleave", () => { cancelAnimationFrame(frame); collage.classList.remove("lit"); collage.style.transform = ""; });
  });
}
// 스크롤 등장을 "항상 표시" 방식으로 변경(숨김 고착 버그 방지).
// 구버전 버그: renderReviewList·renderNotFoundList가 각각 observeReveal을 호출하며
// IntersectionObserver를 disconnect → 앞서 관찰하던 검토 카드가 관찰 대상에서 빠져
// opacity:0에 고착 → "확인 필요" 카드가 통째로 안 보였음(헤더만 표시).
function observeReveal() {
  const sel = "#review-list .rcard, #notfound-list .rcard";
  const cards = document.querySelectorAll(sel);
  if (reduceMotion.matches) { cards.forEach((c) => c.classList.add("in")); return; }
  cards.forEach((card, i) => {
    if (card.classList.contains("reveal")) return;
    card.classList.add("reveal");
    card.style.transitionDelay = Math.min(i, 6) * 55 + "ms";
  });
  // 다음 프레임에 .in 부여 → CSS 트랜지션으로 스태거 등장(스크롤/옵서버 의존 없이 항상 표시)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll(sel).forEach((c) => c.classList.add("in"));
  }));
}
/* 목록이 다시 그려질 때마다 reveal 재관찰 */
const _origRR = renderReviewList, _origNF = renderNotFoundList;
renderReviewList = function (r) { _origRR(r); observeReveal(); };
renderNotFoundList = function (r) { _origNF(r); observeReveal(); };

/* ───────── 부팅 ───────── */
document.addEventListener("DOMContentLoaded", async () => {
  const clear = $("clear-btn");
  if (clear) clear.addEventListener("click", async () => { await send({ type: "CLEAR_CONVERT" }); window.close(); });
  const undo = $("toast-undo");
  if (undo) undo.addEventListener("click", undoResolve);

  const st = await getState();
  render(st);
  motionLayer();
  onScroll();
  if (st && st.status === "running") startPolling();
});
