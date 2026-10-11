#!/usr/bin/env node
// glm-mint-worker.mjs — FRESH-IP Aliyun captcha minter for the GLM mint-egress lane (v2).
// Runs on a GitHub Actions ubuntu runner (its own egress IP), mints chat.z.ai
// captcha params with playwright chromium, and pushes each param to the local
// relay (cloudflared quick tunnel -> glm-fleet gateway pool).
//
// Usage: node scripts/glm-mint-worker.mjs [cycles=60] [gapS=6]
// Env:   RELAY_URL (required), MINT_RELAY_TOKEN (required),
//        FORCE=1          mint regardless of relay /need
//        TARGET_POOL=N    with FORCE=1: mint until the gateway pool holds N
//                         fresh params, then idle (0/absent = mint each cycle)
//        MINT_MODE=chromium|headful|headless
//        RUNNER_LABEL=2   matrix label for source tagging (default "1")
//        MAX_RUNTIME_S=3300  wall-clock self-exit (default 55 min)
// Logs NEVER print full params (fingerprint + length only).
//
// Failure taxonomy (counted in MINT-BRIDGE-RESULT):
//   failed      mint failures (F011 = Aliyun fatigue on THIS runner IP)
//   pushFailed  relay push failures   |  rateLimited = relay 429 (budget)
//   3 consecutive push auth/format failures (relay 400/401) -> exit 2 (config bug)
//   F011 x4 consecutive -> exit early (IP flagged; use a NEW run = new IP)
import crypto from "node:crypto";

const CYCLES = Math.max(1, Math.min(1000, Number(process.argv[2] || 60) || 60));
const GAP_S = Math.max(2, Math.min(600, Number(process.argv[3] || 6) || 6));
const RELAY = (process.env.RELAY_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.MINT_RELAY_TOKEN || "";
const FORCE = process.env.FORCE === "1";
const TARGET_POOL = Math.max(0, Number(process.env.TARGET_POOL || 0) || 0);
const MAX_RUNTIME_MS = Math.max(60, Number(process.env.MAX_RUNTIME_S || 3300) || 3300) * 1000;
const T0 = Date.now();
const SRC = `gh-${process.env.GITHUB_RUN_ID || "local"}-${process.env.RUNNER_LABEL || "1"}-${process.env.MINT_MODE || "chromium"}`;

if (!RELAY || !TOKEN) {
  console.error("RELAY_URL and MINT_RELAY_TOKEN are required");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fp = (p) => crypto.createHash("sha256").update(String(p)).digest("hex").slice(0, 10);
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

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
    const EL = "glm-mint-element2", BT = "glm-mint-trigger2";
    if (!document.getElementById(EL)) {
      const d = document.createElement("div"); d.id = EL;
      d.style.cssText = "position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;pointer-events:none;";
      document.body.appendChild(d);
    }
    if (!document.getElementById(BT)) {
      const b = document.createElement("button"); b.id = BT; b.type = "button";
      b.setAttribute("aria-hidden", "true"); b.tabIndex = -1;
      b.style.cssText = "position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;";
      document.body.appendChild(b);
    }
    try { const old = window.__glmMintInst2; if (old && old.destroy) old.destroy(); } catch (e) {}
    window.__glmMint = null;
    window.initAliyunCaptcha({
      SceneId: (location.hostname === "chat.z.ai" ? "didk33e0" : "xswyjefn"),
      mode: "popup",
      element: "#" + EL,
      button: "#" + BT,
      captchaLogoImg: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
      language: "en",
      timeout: 10000,
      delayBeforeSuccess: false,
      success: (p) => { window.__glmMint = { ok: true, param: typeof p === "string" ? p : JSON.stringify(p), elapsed: Date.now() - window.__glmMintT0 }; },
      fail: (e) => { window.__glmMint = { ok: false, err: "fail:" + (typeof e === "string" ? e : JSON.stringify(e ?? null)) }; },
      onError: (e) => { window.__glmMint = { ok: false, err: "onError:" + (typeof e === "string" ? e : JSON.stringify(e ?? null)) }; },
      onClose: () => { window.__glmMint = window.__glmMint || { ok: false, err: "onClose" }; },
      getInstance: (i) => { window.__glmMintInst2 = i; },
    });
    window.__glmMintT0 = Date.now();
    let waits = 0;
    const iv = setInterval(() => {
      waits += 1;
      if (window.__glmMintInst2 && document.getElementById(BT)) { clearInterval(iv); document.getElementById(BT).click(); }
      else if (waits > 80) { clearInterval(iv); window.__glmMint = { ok: false, err: "getInstance never fired" }; }
    }, 100);
    return JSON.stringify({ started: true });
  } catch (e) { return JSON.stringify({ started: false, why: String((e && e.message) || e) }); }
})()`;

async function getNeed() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(`${RELAY}/need`, { headers: { "x-relay-token": TOKEN }, signal: ctl.signal });
    clearTimeout(t);
    if (r.status !== 200) return { need: true, http: r.status };
    return await r.json();
  } catch (e) {
    return { need: true, error: String(e.cause || e).slice(0, 120) };
  }
}

async function pushParam(param) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(`${RELAY}/push`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-relay-token": TOKEN },
        body: JSON.stringify({ param, ts: Date.now(), src: SRC }),
        signal: ctl.signal,
      });
      clearTimeout(t);
      const j = await r.json().catch(() => ({}));
      if (r.status === 200) return { ok: true, pool_size: j.pool_size };
      if (r.status === 429 && attempt === 1) {
        await sleep(5000 + Math.floor(Math.random() * 5000)); // rate budget: one paced retry
        continue;
      }
      return { ok: false, rateLimited: r.status === 429, error: `relay ${r.status} ${JSON.stringify(j).slice(0, 120)}` };
    } catch (e) {
      if (attempt === 1) { await sleep(2000); continue; } // transient tunnel blip: one retry
      return { ok: false, error: String(e.cause || e).slice(0, 120) };
    }
  }
  return { ok: false, error: "unreachable" };
}

async function mintOnce(page) {
  const t0 = Date.now();
  try {
    await page.goto("https://chat.z.ai/robots.txt", { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(900 + Math.floor(Math.random() * 500));
    // fresh page session each mint (freshness law: one reliable solve per session)
    await page.evaluate("window.__glmMint = null; window.__glmMintInst2 = null;");
    const fire = await page.evaluate(MINT_FIRE);
    const st = JSON.parse(typeof fire === "string" ? fire : "{}");
    if (!st.started) return { ok: false, err: `start failed: ${st.why}` };
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await sleep(400);
      const v = await page.evaluate("window.__glmMint ? JSON.stringify(window.__glmMint) : null").catch(() => null);
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

(async () => {
  log(`glm-mint-worker start relay=${RELAY} cycles=${CYCLES} gap=${GAP_S}s force=${FORCE} target_pool=${TARGET_POOL} max_runtime=${MAX_RUNTIME_MS / 1000}s src=${SRC}`);
  const { chromium } = await import("playwright");
  // MINT_MODE: chromium (full build, new headless) | headful (xvfb) | headless (shell)
  const mode = process.env.MINT_MODE || (process.env.HEADFUL === "1" ? "headful" : "chromium");
  const baseArgs = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--lang=en-US"];
  const launchOpts = mode === "headful"
    ? { headless: false, args: baseArgs }
    : mode === "headless"
      ? { headless: true, args: baseArgs }
      : { headless: true, channel: "chromium", args: baseArgs };
  log(`launch mode=${mode}`);
  const browser = await chromium.launch(launchOpts);
  const ver = browser.version();
  const chromeVer = (ver.match(/(\d+\.\d+\.\d+\.\d+)/) || [, "131.0.0.0"])[1];
  const UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
    timezoneId: "Asia/Singapore",
    userAgent: UA,
  });
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      if (!window.chrome) window.chrome = { runtime: {} };
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5].map((i) => ({ name: `Plugin ${i}`, filename: `plugin${i}.so` })) });
    } catch { /* best-effort stealth */ }
  });
  const page = await context.newPage();
  let minted = 0, pushed = 0, failed = 0, f011 = 0, idleSkips = 0, rateLimited = 0, pushFailed = 0;
  let pushAuthFail = 0;
  const finish = async () => {
    await browser.close().catch(() => {});
    const summary = { minted, pushed, failed, f011, idleSkips, rateLimited, pushFailed, cycles: CYCLES, target_pool: TARGET_POOL, src: SRC, wall_s: Math.round((Date.now() - T0) / 1000) };
    log(`MINT-BRIDGE-RESULT ${JSON.stringify(summary)}`);
  };
  for (let i = 1; i <= CYCLES; i++) {
    if (Date.now() - T0 > MAX_RUNTIME_MS) { log("wall-clock deadline reached — exiting cleanly"); break; }
    if (f011 >= 4) { log("F011 x4 consecutive — runner IP looks flagged, exiting early"); break; }
    if (FORCE) {
      if (TARGET_POOL > 0) {
        const n = await getNeed();
        if (n && Number(n.pool_size) >= TARGET_POOL) {
          idleSkips++;
          const w = Math.min(GAP_S * 4000, 60000);
          log(`[${i}] pool at target (${n.pool_size}/${TARGET_POOL}) — idling ${Math.round(w / 1000)}s`);
          await sleep(w);
          continue;
        }
      }
    } else {
      const need = await getNeed();
      if (need && need.need === false) {
        idleSkips++;
        const w = Math.min(GAP_S * 4000, 60000);
        log(`[${i}] pool satisfied (size=${need.pool_size}) — idling ${Math.round(w / 1000)}s`);
        await sleep(w);
        continue;
      }
    }
    const res = await mintOnce(page);
    if (res.ok) {
      minted++;
      f011 = 0;
      const p = await pushParam(res.param);
      if (p.ok) {
        pushed++;
        pushAuthFail = 0;
        log(`[${i}] mint ok solve_ms=${res.ms} len=${res.param.length} fp=${fp(res.param)} -> push ok pool=${p.pool_size}`);
      } else {
        pushFailed++;
        if (p.rateLimited) rateLimited++;
        if (/relay 40[01]/.test(p.error || "")) {
          pushAuthFail++;
          log(`[${i}] PUSH AUTH/FORMAT FAIL (${pushAuthFail}/3): ${p.error}`);
          if (pushAuthFail >= 3) { log("3 consecutive push auth/format failures — relay token or contract mismatch; exiting"); await finish(); process.exit(2); }
        } else pushAuthFail = 0;
        log(`[${i}] mint ok fp=${fp(res.param)} but PUSH FAILED: ${p.error}`);
      }
    } else {
      failed++;
      if (/F011/.test(res.err)) { f011++; log(`[${i}] mint FAIL (F011 streak ${f011}): ${res.err.slice(0, 140)}`); }
      else log(`[${i}] mint FAIL: ${res.err.slice(0, 140)}`);
    }
    await sleep(Math.floor(GAP_S * 1000 * (0.6 + Math.random() * 0.8)));
  }
  await finish();
})().catch((e) => { console.error("worker fatal:", e); process.exit(1); });
