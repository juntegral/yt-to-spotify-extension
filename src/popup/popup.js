"use strict";
/* ═══════════════════════════════════════════════════════════════
   MIXTAPE · popup.js — 진입점(프로덕션).
   영상 감지 + Spotify 연결 + 변환 시작. 진행/검토는 전용 탭(convert.html).
   팝업은 포커스를 잃으면 닫히므로 긴 작업 UI는 두지 않는다.
   Apple 변환 미구현 → 서비스는 Spotify 고정.
   ═══════════════════════════════════════════════════════════════ */

const doc = document.documentElement;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(msg) {
  if (typeof chrome === "undefined" || !chrome.runtime) return { ok: false, error: "no-chrome" };
  try { return await chrome.runtime.sendMessage(msg); } catch (e) { return { ok: false, error: String(e) }; }
}

let connected = false, profile = null, convState = null, video = null, videoId = null;

document.addEventListener("DOMContentLoaded", () => { wire(); refreshAll(); });

function wire() {
  $("connect-btn") && $("connect-btn").addEventListener("click", onConnect);
  $("disconnect-btn") && $("disconnect-btn").addEventListener("click", onDisconnect);
  $("convert-btn") && $("convert-btn").addEventListener("click", onConvert);
  $("banner-btn") && $("banner-btn").addEventListener("click", openConvertTab);
  q('[data-show="review"] .banner-row .btn-acc', (b) => b.addEventListener("click", openConvertTab));
  q('.cta[data-show="review"]', (b) => b.addEventListener("click", openConvertTab));
  q('[data-show="error"] .banner-row .btn-acc', (b) => b.addEventListener("click", onConnect));
  q('[data-show="empty"] .state-act .btn', (b) => b.addEventListener("click", () => refreshAll()));
}
function q(sel, fn) { const e = document.querySelector(sel); if (e && fn) fn(e); return e; }
function txt(el, s) { if (el) el.textContent = s == null ? "" : String(s); }

async function refreshAll() {
  const [auth, conv] = await Promise.all([
    send({ type: "GET_AUTH_STATE" }),
    send({ type: "GET_CONVERT_STATE" }),
  ]);
  connected = !!(auth && auth.connected);
  profile = auth && auth.profile;
  convState = conv && conv.ok ? conv.state : (conv && conv.state) || null;
  await loadVideo();
  renderConnect();
  renderVideo();
  renderBanners();
  applyState();
}

/* ───────── 상태 판정 ───────── */
function computeState() {
  const cs = convState;
  const pending = cs ? ((cs.review || []).length + (cs.notFound || []).length) : 0;
  if (cs && cs.status === "running") return "running";
  if (cs && cs.status === "done" && pending > 0) return "review";
  if (cs && cs.status === "error") return "error";
  if (!connected) return "disconnected";
  if (video && video.tracks && video.tracks.length) return "ready";
  return "empty";
}
function applyState() {
  const s = computeState();
  doc.setAttribute("data-state", s);
  // CTA / 라벨 텍스트
  const total = (video && video.tracks && video.tracks.length) || (convState && convState.total) || 0;
  const pending = convState ? ((convState.review || []).length + (convState.notFound || []).length) : 0;
  q('.cta[data-show="review"]', (b) => (b.innerHTML = `검토 계속 — <span class="num">${pending}곡</span> 남음`));
  q('.lbl[data-show~="ready"] span', (e) => (e.innerHTML = `트랙리스트 · <span class="num">${total}곡</span>`));
  q('.foot-note[data-show="running"]', (e) => (e.innerHTML = convState ? `완료되면 알려드릴게요 · <span class="num">${convState.processed || 0}/${convState.total || total}</span>` : ""));
}

/* ───────── 연결 상태 ───────── */
function renderConnect() {
  const name = (profile && (profile.name || profile.display_name)) || "";
  q(".connect[data-show~='ready'] .connect-txt", (e) => {
    e.innerHTML = `<b>Spotify</b> 연결됨${name ? " · " : ""}`;
    if (name) e.appendChild(document.createTextNode(name));
  });
}
async function onConnect() {
  q('.connect[data-show~="disconnected"] .connect-txt', (e) => txt(e, "연결 중…"));
  const r = await send({ type: "CONNECT_SPOTIFY" });
  if (r && r.ok) { await refreshAll(); }
  else q('.connect[data-show~="disconnected"] .connect-txt', (e) => txt(e, "연결 실패: " + ((r && r.error) || "?")));
}
async function onDisconnect() {
  await send({ type: "DISCONNECT_SPOTIFY" });
  await refreshAll();
}

/* ───────── 영상/트랙리스트 ───────── */
function getVideoId(url) {
  if (!url) return null;
  try { const u = new URL(url); return /(^|\.)youtube\.com$/.test(u.hostname) ? u.searchParams.get("v") : null; }
  catch (e) { return null; }
}
async function getVideoInfo(tabId, inject) {
  try { return await chrome.tabs.sendMessage(tabId, { type: "GET_VIDEO_INFO" }); }
  catch (e) {
    if (inject && chrome.scripting) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["src/lib/parse-tracklist.js", "src/content/youtube-content.js"] });
        await sleep(150);
        return await chrome.tabs.sendMessage(tabId, { type: "GET_VIDEO_INFO" });
      } catch (e2) { /* noop */ }
    }
    return null;
  }
}
async function loadVideo() {
  video = null; videoId = null;
  if (typeof chrome === "undefined" || !chrome.tabs) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const vid = getVideoId(tab && tab.url);
  if (!vid || !tab) return;
  videoId = vid;
  for (let i = 0; i < 4; i++) {
    const info = await getVideoInfo(tab.id, i === 0);
    if (info && info.title) { video = info; if (info.tracks && info.tracks.length) break; }
    await sleep(350);
  }
}
function renderVideo() {
  const img = $("thumb-img");
  if (img && videoId) {
    img.onload = () => { img.hidden = false; };
    img.onerror = () => { img.hidden = true; };
    img.src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  }
  txt($("video-title"), (video && video.title) || (videoId ? "영상 정보를 읽는 중…" : "유튜브 영상 페이지에서 열어주세요"));
  txt($("video-channel"), (video && video.channel) || "");
  const n = (video && video.tracks && video.tracks.length) || 0;
  q(".chip", (e) => txt(e, `${n}곡 감지`));
  q(".thumb .dur", (e) => txt(e, "")); // 영상 총 길이는 미제공 — 데모 값 숨김
  q(".lbl .meta", (e) => txt(e, ""));
  renderTracks((video && video.tracks) || []);
}
function renderTracks(tracks) {
  const list = $("track-list");
  if (!list) return;
  list.innerHTML = "";
  tracks.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "tr";
    row.innerHTML =
      `<span class="tr-idx num">${t.index || i + 1}</span>` +
      `<div class="tr-main"><div class="tr-name"></div><div class="tr-artist"></div></div>` +
      `<span class="tr-st"></span><span class="tr-time num"></span>`;
    txt(row.querySelector(".tr-name"), t.titleGuess || t.label || "");
    txt(row.querySelector(".tr-artist"), t.artistGuess || "");
    txt(row.querySelector(".tr-time"), t.durationSec ? fmtSec(t.durationSec) : "");
    list.appendChild(row);
  });
}
function fmtSec(sec) { sec = Math.max(0, Math.round(sec || 0)); const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, "0")}`; }

/* ───────── 배너 ───────── */
function renderBanners() {
  const cs = convState;
  if (cs && cs.status === "running") {
    q('[data-show="running"] .banner-txt', (e) => (e.innerHTML = `<span class="num">${cs.processed || 0}</span><span style="color:var(--t3)">/${cs.total || "?"}</span> 매칭 중`));
    q("#banner-fill", (e) => (e.style.width = (cs.total ? Math.round((cs.processed / cs.total) * 100) : 0) + "%"));
  }
  const pending = cs ? ((cs.review || []).length + (cs.notFound || []).length) : 0;
  q('[data-show="review"] .banner-txt', (e) => (e.innerHTML = `<b class="num">${pending}곡</b>이 확인을 기다려요`));
  if (cs && cs.status === "error") q('[data-show="error"] .banner-txt', (e) => txt(e, "변환이 중단됐어요: " + (cs.error || "")));
}

/* ───────── 변환 시작 / 탭 열기 ───────── */
async function onConvert() {
  if (!connected) { doc.setAttribute("data-state", "disconnected"); return; }
  if (!video || !video.tracks || !video.tracks.length) return;
  const btn = $("convert-btn");
  if (btn) { btn.disabled = true; btn.textContent = "변환 시작 중…"; }
  const r = await send({ type: "CONVERT", video });
  if (!r || !r.ok) {
    if (btn) { btn.disabled = false; btn.textContent = "재생목록으로 변환"; }
    q('.foot-note[data-show="ready"]', (e) => txt(e, (r && r.error) || "변환 시작 실패"));
    return;
  }
  await openConvertTab(); // 탭이 열리면 팝업은 자연히 닫힘
}
async function openConvertTab() {
  if (!chrome.tabs) return;
  const url = chrome.runtime.getURL("src/pages/convert.html");
  const { convertTabId } = await chrome.storage.local.get("convertTabId");
  if (convertTabId != null) {
    try { await chrome.tabs.update(convertTabId, { active: true }); return; } catch (e) { /* 닫힘 */ }
  }
  const tab = await chrome.tabs.create({ url });
  await chrome.storage.local.set({ convertTabId: tab.id });
}
