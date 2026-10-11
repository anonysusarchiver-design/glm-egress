#!/usr/bin/env node
// agent-probe.mjs — RUNNER-IP agent-capacity probe for the GLM cross-IP experiment.
// Stage this into glm-egress/scripts/agent-probe.mjs and run via .github/workflows/glm-agent-probe.yml.
//
// Goal: from a fresh GitHub-runner egress IP, fire N minimal REAL agent turns
// against chat.z.ai and record the raw outcome (http, error code, ms). Compared
// same-moment against the local-IP arm (probe-agent-light.mjs), this settles
// H1 (capacity gate is per-IP => fresh IP adds ~2 slots) vs H0 (global/account).
//
// Pipeline per sample (mirrors glm-fleet-gateway.mjs /v1/agent/run, minimal, no retries):
//   1. mint captcha param on the runner IP   (playwright, same as glm-mint-worker.mjs)
//   2. POST /api/v1/chats/new                (flags/type general_agent, gateway:474-505,3433)
//   3. POST /api/v1/web-dev/workspaces/up     (spin, SSE until pod, gateway:3262-3292)
//   4. POST /api/agent/v2/chat/completions    (SSE; capacity shows up HERE, gateway:568-589,3578-3588)
//   5. best-effort release workspace          (gateway:3297-3307)
//
// Verdict classification per sample: ok | capacity | internal | captcha | http_<n> | stage_error.
// Prints ONE greppable line:  GLM-AGENT-PROBE-VERDICT {json}
//
// Env (required):
//   GLM_PROBE_ACCOUNT = JSON: {"token":"<fleet account bearer>","user_id":"<id>","index":<n>}
//                       supplied via repo Actions secret GLM_PROBE_ACCOUNT (masked, never printed).
// Env (optional):
//   PROBE_SAMPLES=3  PROBE_GAP_S=30  PROBE_MODEL=x-preview-l  PROBE_SPIN_TIMEOUT_S=60  PROBE_TURN_TIMEOUT_S=120
//
// SECURITY: the account token is never logged, never placed in a loggable URL,
// never written to artifacts. Request URLs are logged WITHOUT the query string.

import crypto from "node:crypto";

const SAMPLES = Math.max(1, Math.min(10, Number(process.env.PROBE_SAMPLES || 3) || 3));
const GAP_S = Math.max(2, Math.min(300, Number(process.env.PROBE_GAP_S || 30) || 30));
const MODEL = (process.env.PROBE_MODEL || "x-preview-l").slice(0, 64);
const SPIN_TIMEOUT_MS = Math.max(15, Number(process.env.PROBE_SPIN_TIMEOUT_S || 60) || 60) * 1000;
const TURN_TIMEOUT_MS = Math.max(30, Number(process.env.PROBE_TURN_TIMEOUT_S || 120) || 120) * 1000;
const TASK = process.env.PROBE_TASK || "Reply with exactly this token and nothing else: AGENT-PROBE-OK. Do not use any tools.";

// --- gateway constants (mirrored from glm-fleet-gateway.mjs, all non-secret) ---
const UPSTREAM = "https://chat.z.ai";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const X_FE_VERSION = "prod-fe-1.1.93";
const X_DEVICE_ID = "uid_2ylv0mx7gt6zpct2"; // fleet device id (gateway:18; public-source constant)
const X_REGION = "overseas";
const SALT = "key-@@@@)))()((9))-xxxx&&&%%%%%"; // gateway:528 (public source)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

// --- account (never echo token) ---
let ACCOUNT = null;
try {
  ACCOUNT = JSON.parse(process.env.GLM_PROBE_ACCOUNT || "");
} catch { /* handled below */ }
if (!ACCOUNT || typeof ACCOUNT.token !== "string" || !ACCOUNT.token) {
  console.error("GLM_PROBE_ACCOUNT missing/invalid (need JSON {token,user_id[,index]})");
  process.exit(2);
}
const USER_ID = String(ACCOUNT.user_id || "");
const ACCOUNT_LABEL = Number.isInteger(ACCOUNT.index) ? `idx=${ACCOUNT.index}` : "idx=n/a";
log(`agent-probe start samples=${SAMPLES} gap=${GAP_S}s model=${MODEL} account=${ACCOUNT_LABEL} token_len=${ACCOUNT.token.length}`);

// --- signature (gateway:528-566) ---
function makeSignature(prompt, tsMs, requestId, userId) {
  const bucket = Math.floor(Number(tsMs) / (5 * 60 * 1000));
  const derivedKey = crypto.createHmac("sha256", SALT).update(String(bucket)).digest("hex");
  const b64 = Buffer.from(prompt, "utf8").toString("base64");
  const message = `requestId,${requestId},timestamp,${tsMs},user_id,${userId}|${b64}|${tsMs}`;
  return crypto.createHmac("sha256", derivedKey).update(message).digest("hex");
}
function signatureQuery({ token, userId, chatId, tsMs, requestId }) {
  const p = new URLSearchParams();
  p.append("timestamp", String(tsMs));
  p.append("requestId", requestId);
  p.append("user_id", userId);
  p.append("version", "0.0.1");
  p.append("platform", "web");
  p.append("token", token);
  p.append("user_agent", UA);
  p.append("language", "en-US");
  p.append("languages", "en-US,en");
  p.append("timezone", "Asia/Karachi");
  p.append("cookie_enabled", "true");
  p.append("screen_width", "1280");
  p.append("screen_height", "720");
  p.append("screen_resolution", "1280x720");
  p.append("current_url", `${UPSTREAM}/c/${chatId}`);
  p.append("pathname", `/c/${chatId}`);
  p.append("host", "chat.z.ai");
  p.append("protocol", "https:");
  p.append("browser_name", "Opera");
  p.append("os_name", "Windows");
  p.append("signature_timestamp", String(tsMs));
  return p.toString();
}
function glmHeaders(extra = {}, chatId = null) {
  return {
    "Content-Type": "application/json",
    "User-Agent": UA,
    Accept: "application/json",
    authorization: `Bearer ${ACCOUNT.token}`,
    "x-fe-version": X_FE_VERSION,
    "x-device-id": X_DEVICE_ID,
    "x-region": X_REGION,
    "accept-language": "en-US",
    Origin: UPSTREAM,
    Referer: chatId ? `${UPSTREAM}/c/${chatId}` : `${UPSTREAM}/`,
    ...extra,
  };
}

// --- body (gateway:2735-2776 + 3514-3517) ---
function buildCompletionsBody({ content, chatId, captchaParam, sessionId }) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const body = {
    stream: true,
    model: MODEL,
    messages: [{ role: "user", content }],
    signature_prompt: content,
    params: {},
    extra: {},
    features: {
      image_generation: false,
      web_search: false,
      auto_web_search: false,
      preview_mode: true,
      flags: [],
      vlm_tools_enable: false,
      vlm_web_search_enable: false,
      vlm_website_mode: false,
      enable_thinking: true,
      reasoning_effort: "max",
      mcp_tools_enable: true,
    },
    variables: {
      "{{USER_NAME}}": "Moiz",
      "{{USER_LOCATION}}": "Unknown",
      "{{CURRENT_DATETIME}}": `${dateStr} ${timeStr}`,
      "{{CURRENT_DATE}}": dateStr,
      "{{CURRENT_TIME}}": timeStr,
      "{{CURRENT_WEEKDAY}}": ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][now.getDay()],
      "{{CURRENT_TIMEZONE}}": "Asia/Karachi",
      "{{USER_LANGUAGE}}": "en-US",
    },
    chat_id: chatId,
    id: crypto.randomUUID(),
    current_user_message_id: crypto.randomUUID(),
    current_user_message_parent_id: null,
    background_tasks: { title_generation: false, tags_generation: false },
    captcha_verify_param: captchaParam,
    mcp_servers: ["advanced-search"],
  };
  if (sessionId) body.session_id = sessionId;
  return body;
}

// --- captcha mint on the runner IP (same fire-script as glm-mint-worker.mjs:52-106) ---
const MINT_FIRE = `
(async () => {
  try {
    if (!window.initAliyunCaptcha) {
      window.AliyunCaptchaConfig = { region: "sgp", prefix: "no8xfe" };
      await new Promise((res2, rej2) => {
        const SDK = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
        const r = document.querySelector('script[src="' + SDK + '"]');
        if (r && window.initAliyunCaptcha) return res2();
        if (r) { r.addEventListener("load", () => res2()); r.addEventListener("error", () => rej2(new Error("load failed"))); return; }
        const n = document.createElement("script"); n.src = SDK;
        n.onload = () => res2(); n.onerror = () => rej2(new Error("load failed"));
        document.head.appendChild(n);
      });
    }
    if (!window.initAliyunCaptcha) return JSON.stringify({ started: false, why: "initAliyunCaptcha missing" });
    const EL = "glm-probe-el", BT = "glm-probe-bt";
    if (!document.getElementById(EL)) { const d = document.createElement("div"); d.id = EL; d.style.cssText = "position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;pointer-events:none;"; document.body.appendChild(d); }
    if (!document.getElementById(BT)) { const b = document.createElement("button"); b.id = BT; b.type = "button"; b.setAttribute("aria-hidden", "true"); b.tabIndex = -1; b.style.cssText = "position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;"; document.body.appendChild(b); }
    try { const old = window.__glmProbeInst; if (old && old.destroy) old.destroy(); } catch (e) {}
    window.__glmProbe = null;
    window.initAliyunCaptcha({
      SceneId: (location.hostname === "chat.z.ai" ? "didk33e0" : "xswyjefn"),
      mode: "popup", element: "#" + EL, button: "#" + BT,
      captchaLogoImg: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
      language: "en", timeout: 10000, delayBeforeSuccess: false,
      success: (p) => { window.__glmProbe = { ok: true, param: typeof p === "string" ? p : JSON.stringify(p), elapsed: Date.now() - window.__glmProbeT0 }; },
      fail: (e) => { window.__glmProbe = { ok: false, err: "fail:" + (typeof e === "string" ? e : JSON.stringify(e ?? null)) }; },
      onError: (e) => { window.__glmProbe = { ok: false, err: "onError:" + (typeof e === "string" ? e : JSON.stringify(e ?? null)) }; },
      onClose: () => { window.__glmProbe = window.__glmProbe || { ok: false, err: "onClose" }; },
      getInstance: (i) => { window.__glmProbeInst = i; },
    });
    window.__glmProbeT0 = Date.now();
    let waits = 0;
    const iv = setInterval(() => {
      waits += 1;
      if (window.__glmProbeInst && document.getElementById(BT)) { clearInterval(iv); document.getElementById(BT).click(); }
      else if (waits > 80) { clearInterval(iv); window.__glmProbe = { ok: false, err: "getInstance never fired" }; }
    }, 100);
    return JSON.stringify({ started: true });
  } catch (e) { return JSON.stringify({ started: false, why: String((e && e.message) || e) }); }
})()`;

async function mintOnce(page) {
  const t0 = Date.now();
  try {
    await page.goto("https://chat.z.ai/robots.txt", { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(900 + Math.floor(Math.random() * 500));
    await page.evaluate("window.__glmProbe = null; window.__glmProbeInst = null;");
    const fire = await page.evaluate(MINT_FIRE);
    const st = JSON.parse(typeof fire === "string" ? fire : "{}");
    if (!st.started) return { ok: false, err: `start failed: ${st.why}` };
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await sleep(400);
      const v = await page.evaluate("window.__glmProbe ? JSON.stringify(window.__glmProbe) : null").catch(() => null);
      if (v) {
        const m = JSON.parse(v);
        if (m.ok) return { ok: true, param: m.param, ms: m.elapsed ?? Date.now() - t0 };
        return { ok: false, err: String(m.err || "unknown").slice(0, 200) };
      }
    }
    return { ok: false, err: "mint timeout 25s" };
  } catch (e) {
    return { ok: false, err: `nav/eval: ${String(e.message || e).slice(0, 160)}` };
  }
}

// --- upstream calls (plain fetch; URLs logged WITHOUT query-string) ---
async function fetchJson(pathname, { method = "POST", body, ms = 30000, chatId = null, accept = "application/json" } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${UPSTREAM}${pathname}`, {
      method,
      headers: glmHeaders(accept !== "application/json" ? { Accept: accept } : {}, chatId),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* keep raw */ }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}

async function createAgentChat() {
  const body = { chat: { id: "", title: "New Chat", models: [MODEL], flags: ["general_agent"], type: "general_agent" } };
  const r = await fetchJson("/api/v1/chats/new", { body, ms: 30000 });
  if (r.status !== 200) return { ok: false, status: r.status, err: r.text.slice(0, 160) };
  const id = r.json?.id ?? null;
  return { ok: !!id, status: r.status, chatId: id, sessionId: r.json?.im_context?.session_id ?? null, err: id ? null : "no id in response" };
}

async function spinWorkspace(chatId) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), SPIN_TIMEOUT_MS);
  try {
    const r = await fetch(`${UPSTREAM}/api/v1/web-dev/workspaces/up`, {
      method: "POST",
      headers: glmHeaders({ Accept: "text/event-stream" }, chatId),
      body: JSON.stringify({ chatId, flags: ["general_agent"] }),
      signal: ctl.signal,
    });
    if (r.status !== 200) {
      const tx = await r.text().catch(() => "");
      return { ok: false, status: r.status, err: tx.slice(0, 160) };
    }
    // read SSE until success/existing/error/timeout (gateway:3278-3290)
    const deadline = Date.now() + SPIN_TIMEOUT_MS;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let status = "unknown"; let pod = null; let lastErr = null;
    for (;;) {
      const n = await Promise.race([reader.read(), sleep(Math.max(0, deadline - Date.now())).then(() => ({ timeout: true }))]);
      if (n?.timeout || n?.done) break;
      buf += dec.decode(n.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev = null; try { ev = JSON.parse(payload); } catch { continue; }
        const st = typeof ev?.status === "string" ? ev.status : "";
        if (ev?.status === "success" || ev?.status === "existing") { status = "success"; pod = ev?.data?.pod?.name ?? null; }
        else if (/error|fail/i.test(st)) { status = st; lastErr = String(ev?.message ?? st).slice(0, 200); }
      }
      if (status === "success" || lastErr) break;
    }
    try { reader.releaseLock(); } catch { /* noop */ }
    try { await r.body.cancel(); } catch { /* noop */ }
    return { ok: status === "success", status, pod, err: lastErr };
  } catch (e) {
    return { ok: false, status: "fetch_failed", err: String(e.message || e).slice(0, 160) };
  } finally { clearTimeout(t); }
}

async function agentTurn(chatId, captchaParam, sessionId) {
  const tsMs = Date.now();
  const requestId = crypto.randomUUID();
  const sig = makeSignature(TASK, tsMs, requestId, USER_ID);
  const q = signatureQuery({ token: ACCOUNT.token, userId: USER_ID, chatId, tsMs, requestId });
  const body = buildCompletionsBody({ content: TASK, chatId, captchaParam, sessionId });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TURN_TIMEOUT_MS);
  try {
    const r = await fetch(`${UPSTREAM}/api/agent/v2/chat/completions?${q}`, {
      method: "POST",
      headers: glmHeaders({ Accept: "text/event-stream", "x-signature": sig }, chatId),
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const raw = await r.text();
    if (r.status !== 200) {
      return { http: r.status, category: `http_${r.status}`, raw_head: raw.slice(0, 200) };
    }
    // parse SSE frames
    const errors = [];
    let answer = "";
    let done = false;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") { if (payload === "[DONE]") done = true; continue; }
      let ev = null; try { ev = JSON.parse(payload); } catch { continue; }
      if (Array.isArray(ev?.errors)) for (const e of ev.errors) errors.push({ code: String(e?.code ?? ""), message: String(e?.message ?? "").slice(0, 300) });
      if (ev?.error) errors.push({ code: String(ev.error?.code ?? "error"), message: String(ev.error?.message ?? "").slice(0, 300) });
      const d = ev?.data;
      if (d?.phase === "answer" && typeof d?.delta_content === "string") answer += d.delta_content;
      if (d?.done === true || d?.phase === "done") done = true;
    }
    const allErr = JSON.stringify(errors);
    let category = "ok";
    if (errors.length) {
      if (/MODEL_CONCURRENCY_LIMIT/i.test(allErr)) category = "capacity";
      else if (/INTERNAL_ERROR/i.test(allErr)) category = "internal";
      else if (/verify_failed|captcha|FRONTEND_CAPTCHA|F018|F019/i.test(allErr)) category = "captcha";
      else category = "upstream_error";
    } else if (!answer && !done) {
      category = "empty_stream";
    }
    return { http: 200, category, err_code: errors[0]?.code ?? null, err_msg: (errors[0]?.message ?? "").slice(0, 300), answer_len: answer.length, answer_head: answer.slice(0, 80), done };
  } catch (e) {
    return { http: 0, category: "fetch_failed", err_msg: String(e.message || e).slice(0, 200) };
  } finally { clearTimeout(t); }
}

async function releaseWorkspace(chatId) {
  try {
    const id = String(chatId).replace(/^chat-/, "");
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(`${UPSTREAM}/api/v1/web-dev/workspaces/${encodeURIComponent(id)}`, { method: "DELETE", headers: glmHeaders({}, chatId), signal: ctl.signal });
    clearTimeout(t);
    return r.status;
  } catch { return 0; }
}

// --- runner IP (evidence only; best-effort, 5s timeout) ---
async function runnerIp() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch("https://api.ipify.org?format=json", { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    return j?.ip ?? null;
  } catch { return null; }
}

// --- main ---
(async () => {
  const ip = await runnerIp();
  log(`runner egress ip=${ip ?? "unknown"}`);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--lang=en-US"] });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
    timezoneId: "Asia/Singapore",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      if (!window.chrome) window.chrome = { runtime: {} };
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    } catch { /* best-effort stealth */ }
  });
  const page = await context.newPage();

  const samples = [];
  for (let i = 1; i <= SAMPLES; i++) {
    const s0 = Date.now();
    const rec = { sample: i, ts: new Date().toISOString(), stage: null };
    // 1. mint on runner IP
    const m = await mintOnce(page);
    if (!m.ok) {
      rec.category = "mint_failed"; rec.stage = "mint"; rec.err_msg = String(m.err).slice(0, 200); rec.ms = Date.now() - s0;
      samples.push(rec); log(`[${i}] mint FAIL: ${rec.err_msg}`);
      if (i < SAMPLES) await sleep(GAP_S * 1000);
      continue;
    }
    rec.mint_ms = m.ms;
    // 2. create agent chat
    const cc = await createAgentChat();
    if (!cc.ok) {
      rec.category = "stage_error"; rec.stage = "chat_new"; rec.http = cc.status; rec.err_msg = String(cc.err ?? "").slice(0, 160); rec.ms = Date.now() - s0;
      samples.push(rec); log(`[${i}] chat_new FAIL http=${cc.status}`);
      if (i < SAMPLES) await sleep(GAP_S * 1000);
      continue;
    }
    rec.chat_id_tail = String(cc.chatId).slice(-8);
    // 3. spin workspace
    const sp = await spinWorkspace(cc.chatId);
    rec.spin = { ok: sp.ok, status: sp.status };
    if (!sp.ok) {
      rec.category = "stage_error"; rec.stage = "spin"; rec.err_msg = String(sp.err ?? "").slice(0, 160); rec.ms = Date.now() - s0;
      await releaseWorkspace(cc.chatId);
      samples.push(rec); log(`[${i}] spin FAIL: ${sp.status} ${rec.err_msg ?? ""}`);
      if (i < SAMPLES) await sleep(GAP_S * 1000);
      continue;
    }
    // 4. THE decisive call
    const turn = await agentTurn(cc.chatId, m.param, cc.sessionId);
    Object.assign(rec, turn, { stage: "completions", ms: Date.now() - s0 });
    // 5. hygiene
    rec.release_http = await releaseWorkspace(cc.chatId);
    samples.push(rec);
    log(`[${i}] turn http=${turn.http} category=${turn.category} err=${turn.err_code ?? "-"} answer_len=${turn.answer_len ?? 0} ms=${rec.ms}`);
    if (i < SAMPLES) await sleep(GAP_S * 1000);
  }
  await browser.close().catch(() => {});

  const counts = { ok: 0, capacity: 0, internal: 0, captcha: 0, mint_failed: 0, stage_error: 0, other: 0 };
  for (const s of samples) {
    if (counts[s.category] !== undefined) counts[s.category]++; else counts.other++;
  }
  const verdict = { kind: "agent-probe", runner_ip: ip, model: MODEL, account: ACCOUNT_LABEL, samples_requested: SAMPLES, counts, samples };
  console.log(`GLM-AGENT-PROBE-VERDICT ${JSON.stringify(verdict)}`);
  process.exit(counts.capacity > 0 ? 3 : counts.ok === 0 ? 1 : 0);
})().catch((e) => { console.error("probe fatal:", e); process.exit(1); });
