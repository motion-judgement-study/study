"use strict";
// Human motion study (2AFC), static page, v3 (R1B form): Part 1 = naturalness on every pair (request hidden), Part 2 = timing on every pair
// (request + clickable timeline).  Each screen plays one pre-composed side-by-side video (left | right) so both bodies share one clock.
//   participant mode: the page is opened with ?PROLIFIC_PID=..&STUDY_ID=..&SESSION_ID=.. (and without pilot=1)
//   pilot mode:       ?pilot=1, or no PROLIFIC_PID.  Same flow; PILOT banner, debug panel, skip button, data files named pilot_*,
//                     no redirect at the end (a summary instead), never touches the participant condition counter.
// Data: one JSON file per session to DataPipe (https://pipe.jspsych.org) when the session ends, plus incremental copies every
// config.incremental_every answers; every answer is also kept in this browser (localStorage) so a reload resumes the session, and a
// "download my answers" link is offered if the upload fails.  The completion code is shown only after the final file is saved.

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const FPS = 20;
const CLS_COL = { punch: "#8E44AD", kick: "#E8A33D", jump: "#3C6DB4", throw: "#1F9AA6", hop: "#B8577E", catch: "#6A8F2E", squat_down: "#5F6B7A", squat_up: "#9A7B4F" };
const LANE_NAME = { "left arm": "left arm", "right arm": "right arm", "both arms": "both arms", "left leg": "left leg", "right leg": "right leg", "both legs": "both legs", "body": "whole body" };
const Q = { 1: "Which motion looks more like a real person naturally doing this?",
            2: "Which motion performs each requested action inside its marked time window, and not at other times? (timing only, not naturalness)" };
const PART_NAME = { 1: "Natural movement", 2: "Timing" };
const IMC_TEXT = ans => `Attention check: for this question, please select ${ans === "A" ? "Left" : "Right"}.`;
const URLP = new URLSearchParams(location.search);
const clean = (v, n = 80) => (v == null ? "" : String(v)).replace(/[^\w.\-:]/g, "").slice(0, n);
const PID = clean(URLP.get("PROLIFIC_PID"));
const PILOT = URLP.get("pilot") === "1" || !PID;
const MODE = PILOT ? "pilot" : "participant";
const LS_KEY = `motion_study_v3:${MODE}:${PID || "pilot"}`;
const DEFAULT_CFG = { minutes: 25, datapipe_url: "https://pipe.jspsych.org/api/data/", datapipe_condition_url: "https://pipe.jspsych.org/api/condition/",
  datapipe_experiment_id: "", datapipe_experiment_id_pilot: "", use_condition_assignment: true, completion_code: "",
  completion_url_base: "https://app.prolific.com/submissions/complete?cc=", redirect_seconds: 5, incremental_every: 8, contact_note: "" };

let CFG = DEFAULT_CFG, PLANS = null;
const S = { st: null, plan: null, cur: -1, vcache: new Map(), active: false, busy: false, unlocked: false, acc: 0, need: 9.7, lastCt: 0,
  tq: 0, tunlock: null, pauses: 0, steps: 0, seeks: 0, saves: { inc_ok: 0, inc_fail: 0, last: "", final: "" }, key: null };
window.__study = S;   // read by the headless checks

// ------------------------------------------------------------------------------------------------ small helpers
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
function showErr(m) { $("err").textContent = m || ""; $("err").style.display = m ? "block" : "none"; }
function show(id) { for (const s of document.querySelectorAll("section")) s.classList.toggle("on", s.id === id); window.scrollTo(0, 0); }
function block(title, text) { $("blockTitle").textContent = title; $("blockText").textContent = text; show("s-block"); }
function validId(x) { return typeof x === "string" && x.length >= 4 && !/^REPLACE|^\s*$/i.test(x); }
function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
function randHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, b => b.toString(16).padStart(2, "0")).join(""); }
function newSid() { const d = new Date(), p = x => String(x).padStart(2, "0");
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}_${randHex(4)}`; }
function median(a) { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }

// ------------------------------------------------------------------------------------------------ DataPipe
function expId() { return PILOT ? (validId(CFG.datapipe_experiment_id_pilot) ? CFG.datapipe_experiment_id_pilot : (validId(CFG.datapipe_experiment_id) ? CFG.datapipe_experiment_id : "")) : CFG.datapipe_experiment_id; }
async function postJson(url, body, timeoutMs) {
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "*/*" }, body: JSON.stringify(body), signal: ctl.signal });
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    return { status: r.status, body: j };
  } catch (e) { return { status: 0, body: null, error: String(e && e.name || e) }; }
  finally { clearTimeout(tm); }
}
// -> {ok, status, why}; 201 saved, 202 queued by DataPipe (stored, upload retried on their side), FILE_EXISTS on a retry = already saved
async function dpSaveOnce(filename, dataStr) {
  const r = await postJson(CFG.datapipe_url, { experimentID: expId(), filename, data: dataStr }, 25000);
  const err = r.body && r.body.error;
  if (r.status === 201 || r.status === 202 || (r.status === 200 && !err)) return { ok: true, status: r.status };
  if (r.status === 400 && err === "FILE_EXISTS") return { ok: true, status: r.status, dup: true };
  return { ok: false, status: r.status, why: err || r.error || `HTTP ${r.status}`, retry: r.status === 0 || r.status === 429 || r.status >= 500 };
}
async function dpSave(filename, dataStr, tries, onTry) {
  let last = null;
  for (let k = 0; k < tries; k++) {
    if (onTry) onTry(k + 1);
    last = await dpSaveOnce(filename, dataStr);
    if (last.ok) return last;
    if (!last.retry && k >= 1) break;                       // a refusal by DataPipe (e.g. collection switched off): ask the user to retry later
    await sleep(Math.min(16000, 1000 * 2 ** k));
  }
  return last;
}
async function dpCondition() {
  const r = await postJson(CFG.datapipe_condition_url, { experimentID: CFG.datapipe_experiment_id }, 8000);
  return (r.status === 200 && r.body && Number.isInteger(r.body.condition)) ? r.body.condition : null;
}

// ------------------------------------------------------------------------------------------------ session state (kept in this browser)
function save() { if (S.st) { S.st.updated_at = nowIso(); lsSet(LS_KEY, S.st); } }
function nAnswered() { return Object.keys(S.st.answers).length; }
function filePrefix() { return PILOT ? "pilot" : "main"; }
function snapshot(kind) {
  const st = S.st;
  return { format: "motion-study-v3", kind, saved_at: nowIso(), build: PLANS.build,
    session: { sid: st.sid, mode: MODE, pid: st.pid, study_id: st.study_id, session_id: st.session_id, plan: st.plan, group: st.group, plan_src: st.plan_src,
      started_at: st.started_at, finished_at: st.finished_at || null, ua: navigator.userAgent.slice(0, 300), screen: st.screen, tz_offset_min: new Date().getTimezoneOffset(),
      n_trials: S.plan.trials.length, n_answers: nAnswered() },
    answers: Object.values(st.answers).sort((a, b) => a.t - b.t), comment: st.comment || "", events: st.events };
}
function event(type, info) { if (S.st) { S.st.events.push({ at: nowIso(), type, ...(info || {}) }); if (S.st.events.length > 200) S.st.events.shift(); } }
let incChain = Promise.resolve();
function queueIncremental() {
  if (!expId()) return;
  const n = nAnswered(), seq = String(Math.round(n / Math.max(1, CFG.incremental_every))).padStart(2, "0");
  const fname = `${filePrefix()}_${S.st.sid}_inc${seq}.json`, data = JSON.stringify(snapshot("incremental"));
  incChain = incChain.then(async () => {
    const r = await dpSave(fname, data, 3);
    if (r.ok) { S.saves.inc_ok++; S.st.inc_saved.push(seq); } else { S.saves.inc_fail++; event("inc_save_failed", { file: fname, why: r.why }); }
    S.saves.last = `${fname}: ${r.ok ? "ok " + r.status : "failed " + r.why}`;
    save();
  });
}

// ------------------------------------------------------------------------------------------------ videos (fetched whole into blob URLs: smooth start and exact seeking)
function getVideo(v) {
  if (!S.vcache.has(v)) {
    const p = fetch(`data/v/${v}.mp4`).then(r => { if (!r.ok) throw new Error(`video ${r.status}`); return r.blob(); })
      .then(b => URL.createObjectURL(b)).catch(e => { S.vcache.delete(v); throw e; });
    S.vcache.set(v, p);
  }
  return S.vcache.get(v);
}
function prefetch(t) { for (const k of [t, t + 1, t + 2]) { const x = S.plan.trials[k]; if (x) getVideo(x.v).catch(() => {}); } }
function trimCache(t) {
  const keep = new Set([t - 1, t, t + 1, t + 2, t + 3].map(k => S.plan.trials[k]).filter(Boolean).map(x => x.v));
  for (const [v, p] of S.vcache) if (!keep.has(v)) { S.vcache.delete(v); p.then(u => URL.revokeObjectURL(u)).catch(() => {}); }
}

// ------------------------------------------------------------------------------------------------ timeline (Part 2)
function reqOf(x) { return PLANS.requests[x.r]; }
function lanesOf(rq) { const L = []; for (const s of rq.strokes) if (!L.includes(s.lane)) L.push(s.lane); return L; }
function buildTimeline(rq) {
  const L = rq.L, lanes = lanesOf(rq);
  $("tlrows").innerHTML = lanes.map(ln => `<div class="tlrow"><div class="tllane">${esc(LANE_NAME[ln] || ln)}</div><div class="tltrack">` +
    rq.strokes.filter(s => s.lane === ln).map(s => {
      const l = (100 * s.s / L).toFixed(2), w = (100 * (s.e - s.s + 1) / L).toFixed(2), word = s.label.split(" (")[0];
      return `<div class="tlwin" style="left:${l}%;width:${w}%;background:${CLS_COL[s.cls] || "#7d9bff"}" title="${esc(s.label)}" data-word="${esc(word)}">${esc(word)}</div>`;
    }).join("") + `</div></div>`).join("");
}
function fitLabels() {           // the label inside its bar; a bar too short for it gets the label just above it, on the timeline
  for (const row of document.querySelectorAll("#tl .tlrow")) {
    for (const o of row.querySelectorAll(".tlout")) o.remove();
    row.classList.remove("out");
    const track = row.querySelector(".tltrack");
    let right = -1e9;
    for (const el of row.querySelectorAll(".tlwin")) {
      const full = el.dataset.word;
      el.textContent = full;
      if (el.scrollWidth <= el.clientWidth) continue;
      el.textContent = "";
      row.classList.add("out");
      const o = document.createElement("span");
      o.className = "tlout";
      o.innerHTML = `<i style="background:${el.style.background}"></i>${esc(full)}`;
      track.appendChild(o);
      const x = Math.max(el.offsetLeft, right + 8);
      o.style.left = `${x}px`;
      right = x + o.offsetWidth;
    }
  }
}
// the side-by-side video takes the height the other elements of the screen leave (between 560 px and 1088 px wide, aspect 1088:540)
function fitLayout() {
  if (!$("s-trial").classList.contains("on")) return;
  const wrapW = document.querySelector(".wrap").clientWidth - 32, pb = $("pilotbar") && !$("pilotbar").hidden ? $("pilotbar").offsetHeight : 0;
  const ids = ["banner", "goal", "qtext", "ctrl", "tl", "lockmsg"], extra = [document.querySelector(".pbar"), document.querySelector(".ans"), document.querySelector("#s-trial .pilotonly")];
  for (let k = 0; k < 3; k++) {
    let h = pb + 24 + 28;                                            // page padding + margins between blocks
    for (const i of ids) { const el = $(i); if (el && !el.hidden) h += el.offsetHeight; }
    for (const el of extra) if (el && !el.hidden) h += el.offsetHeight;
    const w = Math.max(560, Math.min(1088, wrapW, Math.floor((innerHeight - h) * 1088 / 540)));
    document.documentElement.style.setProperty("--vw", `${w}px`);
  }
  if (!$("tl").hidden) fitLabels();
}
function trackBox() { const tr = document.querySelector("#tl .tltrack"), tl = $("tl"); if (!tr) return null;
  const a = tr.getBoundingClientRect(), b = tl.getBoundingClientRect(); return { x0: a.left, w: a.width, off: a.left - b.left }; }

// ------------------------------------------------------------------------------------------------ playback + unlock
function vid() { return $("vid"); }
function dur() { const v = vid(); return v.duration && isFinite(v.duration) ? v.duration : 9.8; }
function syncUI() {
  const v = vid();
  $("play").innerHTML = v.paused ? "&#9654;" : "&#10074;&#10074;";
  $("bA").disabled = $("bB").disabled = !S.unlocked || S.busy || !S.active;
  $("lockmsg").textContent = S.unlocked || !S.active ? "" : `The buttons unlock after one full play (${Math.max(0, Math.ceil(S.need - S.acc))} s)`;
}
let dbgTick = 0, lockTick = -1;
function tick(now) {
  const v = vid();
  if (S.active && v.readyState >= 2) {
    const ct = v.currentTime;
    if (!v.paused && !v.seeking) { const d = ct - S.lastCt; if (d > 0 && d < 0.5) S.acc += d; }
    S.lastCt = ct;
    const f = Math.min(1, ct / dur());
    $("vfill").style.width = `${(100 * f).toFixed(2)}%`;
    if (!$("tl").hidden) { const tb = trackBox(); if (tb) $("tlcur").style.left = `${tb.off + f * tb.w}px`; }
    if (!S.unlocked && S.acc >= S.need) { S.unlocked = true; S.tunlock = performance.now(); syncUI(); }
    else if (!S.unlocked && Math.ceil(S.need - S.acc) !== lockTick) { lockTick = Math.ceil(S.need - S.acc); syncUI(); }
  }
  if (PILOT && $("dbg") && !$("dbg").hidden && now - dbgTick > 200) { dbgTick = now; renderDebug(); }
  requestAnimationFrame(tick);
}
function togglePlay() { const v = vid(); if (!S.active) return; if (v.paused) v.play().catch(() => {}); else { v.pause(); S.pauses++; } }
function step(d) { const v = vid(); if (!S.active) return; v.pause(); S.steps++; v.currentTime = Math.max(0, Math.min(dur() - 0.001, v.currentTime + d / FPS)); S.lastCt = v.currentTime; }
function seekFrac(f) { const v = vid(); if (!S.active) return; S.seeks++; v.currentTime = Math.max(0, Math.min(dur() - 0.001, f * dur())); S.lastCt = v.currentTime; }

// ------------------------------------------------------------------------------------------------ flow
function partTrials(p) { return S.plan.trials.filter(x => x.p === p); }
function nextOpen() { for (const x of S.plan.trials) if (!S.st.answers[x.t]) return x.t; return null; }
function route() {
  S.active = false;
  const t = nextOpen();
  if (t == null) { vid().pause(); show("s-end"); return; }
  const p = S.plan.trials[t].p;
  if (!S.st.intro[p]) { vid().pause(); show(p === 1 ? "s-intro1" : "s-intro2"); return; }
  openTrial(t);
}
async function openTrial(t) {
  S.cur = t;
  const x = S.plan.trials[t], v = vid();
  S.active = false; S.busy = true; syncUI();
  let url;
  try { url = await getVideo(x.v); }
  catch (e) {
    S.busy = false;
    showErr("A video could not be loaded. Please check your internet connection; the page will try again in a few seconds (your answers are kept).");
    setTimeout(() => openTrial(t), 4000);
    return;
  }
  showErr("");
  prefetch(t + 1); trimCache(t);
  const P = partTrials(x.p), k = P.indexOf(x) + 1;
  $("banner").innerHTML = `Part ${x.p} of 2 &middot; ${PART_NAME[x.p]} &middot; pair ${k} of ${P.length}`;
  $("seg1").classList.toggle("done", x.p === 2);
  $("seg1").querySelector(".fill").style.width = x.p === 1 ? `${(100 * (k - 1) / P.length).toFixed(1)}%` : "100%";
  $("seg2").querySelector(".fill").style.width = x.p === 2 ? `${(100 * (k - 1) / P.length).toFixed(1)}%` : "0%";
  $("qtext").textContent = x.imc ? IMC_TEXT(x.imc) : Q[x.p];
  const rq = reqOf(x);
  $("goal").hidden = false; $("tl").hidden = x.p !== 2;
  $("goallab").textContent = x.p === 1 ? "Described action" : "Requested — the timeline marks when";
  $("goaltext").textContent = `“${rq.cap}”`;
  if (x.p === 2) buildTimeline(rq);
  pilotTag();
  S.unlocked = false; S.acc = 0; S.lastCt = 0; S.pauses = 0; S.steps = 0; S.seeks = 0; S.tunlock = null; lockTick = -1;
  show("s-trial");
  fitLayout();
  if (v.src !== url) v.src = url;
  v.currentTime = 0;
  try { await v.play(); } catch (e) { /* autoplay refused: the play button starts it */ }
  S.need = Math.max(0.5, dur() - 0.1);
  S.tq = performance.now();
  S.busy = false; S.active = true;
  syncUI();
}
function record(side, skipped) {
  const x = S.plan.trials[S.cur], now = performance.now();
  const rec = { t: x.t, part: x.p, choice: side, rt_ms: Math.round(now - S.tq), unlock_ms: S.tunlock ? Math.round(S.tunlock - S.tq) : null,
    plays: +(S.acc / dur()).toFixed(2), pauses: S.pauses, steps: S.steps, seeks: S.seeks, at: nowIso() };
  if (skipped) rec.skipped = true;
  if (x.imc) rec.imc = { ans: x.imc, ok: side === x.imc };
  S.st.answers[x.t] = rec;
  save();
  if (nAnswered() % Math.max(1, CFG.incremental_every) === 0) queueIncremental();
}
function choose(side) {
  if (!S.unlocked || S.busy || !S.active) return;
  if (document.activeElement) document.activeElement.blur();
  record(side, false);
  route();
}
function skipQuestion() {      // pilot only
  if (!PILOT || !S.active) return;
  record(null, true);
  route();
}

async function assignPlan() {
  const n = PLANS.n;
  if (PILOT) {
    const q = parseInt(URLP.get("plan"), 10);
    if (Number.isInteger(q) && q >= 0 && q < n) return { plan: q, src: "url" };
    return { plan: Math.floor(Math.random() * n), src: "random" };
  }
  if (CFG.use_condition_assignment && validId(CFG.datapipe_experiment_id)) {
    const c = await dpCondition();
    if (c != null && c >= 0) return { plan: c % n, src: "condition" };
  }
  return { plan: hashStr(PID) % n, src: "hash" };
}
async function beginSession() {
  $("goStart").disabled = true;
  $("goStart").textContent = "Preparing ...";
  try {
    if (!S.st) {
      const a = await assignPlan();
      S.st = { v: 3, sid: newSid(), mode: MODE, pid: PID || null, study_id: clean(URLP.get("STUDY_ID")) || null, session_id: clean(URLP.get("SESSION_ID")) || null,
        plan: a.plan, plan_src: a.src, group: PLANS.plans[a.plan].g, started_at: nowIso(), finished_at: null, answers: {}, intro: {}, comment: "", events: [],
        inc_saved: [], final_saved: false, final_status: "", screen: `${screen.width}x${screen.height}@${window.devicePixelRatio || 1} win ${innerWidth}x${innerHeight}`,
        build: PLANS.build };
      event("start", { plan: a.plan, src: a.src });
      save();
    }
    S.plan = PLANS.plans[S.st.plan];
    prefetch(0);
    route();
  } catch (e) { $("goStart").disabled = false; $("goStart").textContent = "Continue"; showErr(e.message || String(e)); }
}
function startPart(p) { S.st.intro[p] = true; event("part_start", { part: p }); save(); route(); }
function resumeSession() {
  event("resume", { answered: nAnswered() });
  save();
  S.plan = PLANS.plans[S.st.plan];
  if (S.st.finished_at) { finalize(); return; }
  const t = nextOpen();
  if (t != null) prefetch(t);
  route();
}
function dataUrl() { return URL.createObjectURL(new Blob([JSON.stringify(snapshot("final"), null, 1)], { type: "application/json" })); }
async function finalize() {
  show("s-save");
  $("saveFail").hidden = true; $("saveHelp").hidden = true;
  const st = S.st;
  if (!st.finished_at) { st.finished_at = nowIso(); st.comment = ($("comment").value || "").slice(0, 2000); save(); }
  if (!expId()) {
    if (!PILOT) { $("saveMsg").textContent = "Saving is not configured. Please download your answers and contact us."; failUI(); return; }
    st.final_status = "not uploaded (no DataPipe experiment configured for pilots)"; save(); doneUI(); return;
  }
  if (!st.final_saved) {
    const fname = `${filePrefix()}_${st.sid}_final.json`, data = JSON.stringify(snapshot("final"));
    const r = await dpSave(fname, data, 6, k => { $("saveMsg").textContent = `Saving your answers, please keep this page open (attempt ${k}) ...`; });
    st.final_status = r.ok ? `saved (${r.status}${r.dup ? ", already there" : ""})` : `failed: ${r.why}`;
    S.saves.final = `${fname}: ${st.final_status}`;
    if (r.ok) { st.final_saved = true; st.final_file = fname; }
    event(r.ok ? "final_saved" : "final_failed", { file: fname, status: r.status, why: r.why || null });
    save();
    if (!r.ok) { $("saveMsg").textContent = "Your answers could not be saved yet."; failUI(); return; }
  }
  doneUI();
}
function failUI() {
  $("saveFail").hidden = false; $("saveHelp").hidden = false;
  const a = $("saveDl"); a.href = dataUrl(); a.download = `answers_${S.st.sid}.json`;
}
function doneUI() {
  const st = S.st;
  let h = "";
  if (!PILOT) {
    const code = CFG.completion_code, url = CFG.completion_url_base + encodeURIComponent(code);
    h += `<p>All your answers are saved. Your completion code:</p><p><span class="code">${esc(code)}</span></p>`;
    h += `<p><a id="backLink" href="${esc(url)}">Return to Prolific</a> <span class="muted small" id="redirMsg"></span></p>`;
    $("donebox").innerHTML = h;
    show("s-done");
    let left = Math.max(0, CFG.redirect_seconds | 0);
    const tickR = () => { if (left <= 0) { location.href = url; return; } $("redirMsg").textContent = `(you will be taken back automatically in ${left} s)`; left--; setTimeout(tickR, 1000); };
    if (!URLP.get("noredirect")) tickR();
    return;
  }
  h += `<p><b>Pilot session finished.</b> Nothing is sent to the recruitment platform.</p>`;
  h += `<p class="small">Upload: ${esc(st.final_status || "-")}</p>`;
  h += pilotSummaryHtml();
  h += `<p><a id="pilotDl" href="#">Download this session's data</a> &middot; <a href="?pilot=1">start another pilot session</a></p>`;
  $("donebox").innerHTML = h;
  const a = $("pilotDl"); a.href = dataUrl(); a.download = `pilot_${st.sid}.json`;
  show("s-done");
}

// ------------------------------------------------------------------------------------------------ pilot: debug panel, unblinding, summary
function keyRow(t) {
  if (!S.key || !S.plan) return null;
  const rows = S.key.plans[String(S.plan.id)];
  if (!rows || !rows[t]) return null;
  const o = {}; S.key.fields.forEach((f, i) => { o[f] = rows[t][i]; });
  return o;
}
// pilot only: once the key is loaded (local dashboard: automatically; elsewhere: unblind + passphrase), name the target side under the buttons
function pilotTag() {
  if (!PILOT || !$("pilotTag")) return;
  const kr = S.plan ? keyRow(S.cur) : null;
  if (!kr || URLP.get("blind") === "1") { $("pilotTag").textContent = ""; return; }
  $("pilotTag").textContent = kr.kind === "test" ? `pilot key: ${(S.key.labels || {}).target || "target"} = ${kr.target_side === "A" ? "Left" : "Right"} (vs ${kr.cond})`
    : `pilot key: attention check (${kr.A_label} | ${kr.B_label})`;
}
function renderDebug() {
  const st = S.st, x = S.plan && S.plan.trials[S.cur];
  const lines = [];
  lines.push(`mode ${MODE}  build ${PLANS ? PLANS.build : "-"}  page ${location.pathname}`);
  if (st) lines.push(`session ${st.sid}  plan ${st.plan} (group ${st.group}, ${st.plan_src})  answered ${nAnswered()} / ${S.plan ? S.plan.trials.length : "-"}`);
  if (x) {
    lines.push(`screen t=${S.cur}  part ${x.p}${x.imc ? `  attention check, answer ${x.imc === "A" ? "Left" : "Right"}` : ""}  video ${x.v}`);
    lines.push(`clips  left ${x.A}   right ${x.B}   request #${x.r}`);
    const kr = keyRow(S.cur);
    lines.push(kr ? `key    ${Object.entries(kr).map(([a, b]) => `${a}=${b}`).join("  ")}` : `key    (blinded: press unblind)`);
    lines.push(`timers on screen ${((performance.now() - S.tq) / 1000).toFixed(1)} s  played ${(S.acc / dur()).toFixed(2)} loops  unlock ${S.tunlock ? ((S.tunlock - S.tq) / 1000).toFixed(1) + " s" : "-"}  pauses ${S.pauses} steps ${S.steps} seeks ${S.seeks}`);
  }
  lines.push(`saves  incremental ok ${S.saves.inc_ok} failed ${S.saves.inc_fail}  last: ${S.saves.last || "-"}`);
  lines.push(`       final: ${S.saves.final || (st && st.final_status) || "-"}   target experiment: ${expId() ? "configured" : "none (data stays in this browser)"}`);
  $("dbgText").textContent = lines.join("\n");
}
async function unblind() {
  $("dbgKeyMsg").textContent = "";
  try {                                                            // served only by the local dashboard mount, never published
    const r = await fetch("pilot_key.json", { cache: "no-store" });
    if (r.ok) { const k = await r.json(); if (k.build === PLANS.build) { S.key = k; $("dbgKeyMsg").textContent = "key loaded (local)"; pilotTag(); return; } }
  } catch (e) { /* not on this host */ }
  $("dbgPw").hidden = false; $("dbgPass").focus();
}
async function decryptKey() {
  try {
    const e = await (await fetch("data/pilot_key.enc.json", { cache: "no-store" })).json();
    const b = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode($("dbgPass").value.trim()), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: b(e.salt), iterations: e.iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b(e.iv) }, key, b(e.ct));
    const k = JSON.parse(new TextDecoder().decode(plain));
    if (k.build !== PLANS.build) { $("dbgKeyMsg").textContent = "key is for another build"; return; }
    S.key = k;
    $("dbgPw").hidden = true; $("dbgKeyMsg").textContent = "key decrypted";
    pilotTag();
  } catch (err) { $("dbgKeyMsg").textContent = "wrong passphrase or no key file"; }
}
function pilotSummaryHtml() {
  const A = Object.values(S.st.answers);
  const real = A.filter(a => !a.skipped);
  const imc = A.filter(a => a.imc);
  const rts = real.map(a => a.rt_ms);
  const mins = S.st.finished_at ? (new Date(S.st.finished_at) - new Date(S.st.started_at)) / 60000 : null;
  let h = `<table class="sum"><tr><th>answered</th><td>${real.length}</td><th>skipped</th><td>${A.length - real.length}</td></tr>`;
  h += `<tr><th>attention checks correct</th><td>${imc.filter(a => a.imc.ok).length} / ${imc.length}</td><th>median time per screen</th><td>${rts.length ? (median(rts) / 1000).toFixed(1) + " s" : "-"}</td></tr>`;
  h += `<tr><th>session length</th><td>${mins != null ? mins.toFixed(1) + " min" : "-"}</td><th>plan</th><td>${S.st.plan} (${esc(S.st.group)})</td></tr></table>`;
  if (!S.key) return h + `<p class="muted small">Unblind in the debug panel to see choices per compared condition.</p>`;
  const L = S.key.labels || {}, cells = {};
  for (const a of real) {
    const k = keyRow(a.t); if (!k || k.kind !== "test" || !a.choice) continue;
    const c = `${k.cond}|${a.part}`; cells[c] = cells[c] || [0, 0]; cells[c][0]++; if (a.choice === k.target_side) cells[c][1]++;
  }
  h += `<table class="sum"><tr><th>${esc(L.cond || "condition")}</th><th>part</th><th>pairs</th><th>${esc(L.target || "target")} chosen</th></tr>`;
  for (const c of Object.keys(cells).sort()) { const [cond, p] = c.split("|"); h += `<tr><td>${esc(cond)}</td><td>${p}</td><td>${cells[c][0]}</td><td>${cells[c][1]}</td></tr>`; }
  return h + `</table>`;
}

// ------------------------------------------------------------------------------------------------ static drawing, keys, wiring
function drawExample() {
  const X = s => 104 + s * 52, g = [];
  const lane = (y, name) => g.push(`<text x="4" y="${y + 14}">${name}</text><rect x="104" y="${y}" width="520" height="20" rx="3" fill="rgba(255,255,255,0.05)"/>`);
  lane(4, "both legs"); lane(28, "right arm");
  g.push(`<rect x="${X(1.0)}" y="4" width="${X(1.9) - X(1.0)}" height="20" rx="3" fill="${CLS_COL.jump}"/><text x="${X(1.0) + 4}" y="18">jump</text>`);
  g.push(`<rect x="${X(5.0)}" y="28" width="${X(5.8) - X(5.0)}" height="20" rx="3" fill="${CLS_COL.punch}"/><text x="${X(5.0) + 4}" y="42">punch</text>`);
  const row = (y, name, jumps, punches) => {
    g.push(`<text x="4" y="${y + 5}">${name}</text><line x1="104" x2="624" y1="${y}" y2="${y}" stroke="#2c3a55"/>`);
    for (const s of jumps) g.push(`<path d="M ${X(s) - 7} ${y + 6} L ${X(s) + 7} ${y + 6} L ${X(s)} ${y - 7} Z" fill="${CLS_COL.jump}"/>`);
    for (const s of punches) g.push(`<circle cx="${X(s)}" cy="${y}" r="6" fill="${CLS_COL.punch}"/>`);
  };
  row(70, "Left does", [1.4], [5.4]);
  row(96, "Right does", [1.4], [3.0, 5.4]);
  g.push(`<text x="${X(3.0) + 10}" y="110" style="font-size:11px;fill:#ffc35a">outside the bar</text>`);
  $("exg").innerHTML = g.join("");
}
function isTextTarget(t) {
  if (!t || !t.tagName) return false;
  const n = t.tagName;
  if (n === "TEXTAREA" || n === "SELECT" || t.isContentEditable) return true;
  return n === "INPUT" && !["range", "button", "checkbox", "radio", "submit"].includes(t.type);
}
function wire() {
  $("consent").onchange = () => { $("goStart").disabled = !$("consent").checked; };
  $("goStart").onclick = beginSession;
  $("goPart1").onclick = () => startPart(1);
  $("goPart2").onclick = () => startPart(2);
  $("goResume").onclick = resumeSession;
  $("goNewPilot").onclick = () => { S.st = null; try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ } show("s-welcome"); };
  $("play").onclick = () => { togglePlay(); $("play").blur(); };
  $("vbar").onclick = e => { const r = $("vbar").getBoundingClientRect(); seekFrac((e.clientX - r.left) / r.width); };
  $("tl").onclick = e => { const tb = trackBox(); if (tb) seekFrac((e.clientX - tb.x0) / tb.w); };
  const v = vid();
  v.addEventListener("play", syncUI); v.addEventListener("pause", syncUI);
  $("bA").onclick = () => choose("A");
  $("bB").onclick = () => choose("B");
  $("submit").onclick = () => { $("submit").disabled = true; finalize(); };
  $("saveRetry").onclick = () => finalize();
  // Space = play / pause (capture phase, preventDefault so the page never scrolls, a focused button is blurred so it is not clicked as well),
  // left / right = one frame; ignored while typing in a text field
  window.addEventListener("keydown", e => {
    if (isTextTarget(e.target)) return;
    if (e.code === "Space" || e.key === " ") {
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return;
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      togglePlay();
    } else if (S.active && e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); step(1); }
    else if (S.active && e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); step(-1); }
  }, true);
  window.addEventListener("resize", fitLayout);
  window.addEventListener("keyup", e => { if ((e.code === "Space" || e.key === " ") && !isTextTarget(e.target)) { e.preventDefault(); e.stopPropagation(); } }, true);
  if (PILOT) {
    $("pilotbar").hidden = false;
    for (const el of document.querySelectorAll(".pilotonly")) el.hidden = false;
    $("skipBtn").onclick = skipQuestion;
    $("dbgToggle").onclick = () => { $("dbg").hidden = !$("dbg").hidden; renderDebug(); };
    $("dbgClose").onclick = () => { $("dbg").hidden = true; };
    $("dbgUnblind").onclick = unblind;
    $("dbgPwGo").onclick = decryptKey;
    $("dbgPass").addEventListener("keydown", e => { if (e.key === "Enter") decryptKey(); });
    $("dbgSkip").onclick = skipQuestion;
    $("dbgUnlock").onclick = () => { if (S.active) { S.unlocked = true; S.tunlock = performance.now(); syncUI(); } };
    $("dbgDl").onclick = () => { if (!S.st) return; const a = document.createElement("a"); a.href = dataUrl(); a.download = `pilot_${S.st.sid}.json`; a.click(); };
  } else {
    for (const el of document.querySelectorAll(".pilotonly")) el.remove();
    $("dbg").remove(); $("pilotbar").remove();
  }
}
async function init() {
  wire(); drawExample(); syncUI();
  requestAnimationFrame(tick);
  try {
    const [c, p] = await Promise.all([fetch("config.json", { cache: "no-store" }).then(r => r.json()), fetch("data/plans.json").then(r => r.json())]);
    CFG = Object.assign({}, DEFAULT_CFG, c); PLANS = p;
  } catch (e) { block("This study could not be loaded", "Please check your internet connection and reload the page."); return; }
  $("minutes").textContent = String(CFG.minutes);
  if (CFG.contact_note) $("contact").textContent = CFG.contact_note;
  if (innerWidth < 1000 || (window.matchMedia && matchMedia("(pointer: coarse)").matches)) $("narrowWarn").hidden = false;
  if (!PILOT && (!validId(CFG.datapipe_experiment_id) || !validId(CFG.completion_code))) {
    block("This study is not available right now", "The study is not configured yet. Please return it on Prolific; we are sorry for the trouble.");
    return;
  }
  if (PILOT && URLP.get("blind") !== "1") unblind().then(() => { $("dbgPw").hidden = true; }).catch(() => {});   // local mount only; silent elsewhere
  const old = lsGet(LS_KEY);
  if (old && old.v === 3 && old.build === PLANS.build && PLANS.plans[old.plan]) {
    S.st = old;
    if (old.finished_at) { S.plan = PLANS.plans[old.plan]; finalize(); return; }
    $("goNewPilot").hidden = !PILOT;
    show("s-resume");
    return;
  }
  show("s-welcome");
}
init();
