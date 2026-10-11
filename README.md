# glm-egress — fresh-IP mint lane for the GLM fleet

Public by design (free GitHub Actions minutes). Hosts a scale-ready worker that mints
chat.z.ai Aliyun captcha params on fresh runner IPs and pushes them to the operator's
local relay (`127.0.0.1:9730`, token-gated) which feeds the glm-fleet gateway pool
(`127.0.0.1:9721`, TTL 150s, max 8, freshest-first).

**No secrets live in this repo.** The relay push endpoint is gated by a repo Actions
secret (`MINT_RELAY_TOKEN`) that is masked in logs; the relay itself binds loopback and
is exposed only through an on-demand cloudflared quick tunnel. Worker logs redact params
(sha256 fingerprint + length only).

## Dispatch contract

`workflow_dispatch` inputs: `relay_url` (required, current tunnel), `cycles`, `gap_s`,
`force` (`1` = ignore pool demand), `target_pool` (with force: fill to N then idle),
`mode` (`chromium` default — the only mode that reliably passes Aliyun), `runners`
(JSON array of labels; K entries = K parallel runners = K fresh egress IPs).

```powershell
# local orchestrator (recommended)
node ..\mint-bridge.mjs start                     # steady-state: dispatch when pool < 2
node ..\mint-bridge.mjs mint --k 4 --target 8     # burst: 4 fresh IPs fill pool to 8
node ..\mint-bridge.mjs status                    # relay stats + tunnel + pool + runs
```

## Scale laws (measured)

- Runner lifecycle: one runner drains its cycles, then dies — fresh work = fresh run = fresh IP
  (per-IP F011 fatigue pools are independent).
- Per-runner supply ≈ `60 / (nav 2-5s + solve 1-2s + gap_s)` params/min.
- Relay global budget: **20 pushes/min** → size K · rate ≤ 20/min (e.g. K=4 @ gap 8 ≈ 18/min).
  Workers get one paced retry on 429; sustained overflow is a planner error, not a worker error.
- `target_pool` makes bursts self-limiting: workers idle once the pool hits the target.
- GitHub concurrency: dispatches do not queue (group is per-run); matrix `max-parallel: 16`.
- Wall-clock self-exit at 55 min (job timeout 70) so runs end cleanly even while idling.

## Failure taxonomy (worker counts -> MINT-BRIDGE-RESULT)

`mint FAIL` F011×4 → exit (runner IP flagged; get a new run) · `nav/eval` timeouts → retry next
cycle · push `relay 429` → paced retry once, else counted `rateLimited` · push `relay 400/401`
×3 consecutive → exit 2 (token/contract mismatch) · run wall-clock → clean exit.
