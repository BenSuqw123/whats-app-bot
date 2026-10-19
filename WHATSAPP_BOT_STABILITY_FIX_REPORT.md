# WhatsApp Bot Stability Fix Report

Ngày thực hiện: 2026-10-03, Asia/Bangkok. Giữ Baileys 7.0.0-rc13 và lockfile hiện có. Đã implement và test offline; **chưa chạy bot/PM2 production, chưa gọi WhatsApp, chưa thay session/archive thực hoặc Windows settings**.

## Files changed

| File | Thay đổi |
|---|---|
| `index.js` | dotenv trước logger; đăng ký fatal handlers trước require bot; catch startup; ownership refusal exit 78 |
| `src/bot.js` | Adapter Baileys, acquire session lock trước auth load, socket-local message wrapper, health providers, shutdown hooks, revision async |
| `src/utils/socketLifecycle.js` (mới) | Lifecycle có dependency injection, generation guards, single retry timer, watchdog, classification, stable reset, async listener catches |
| `src/utils/sessionLock.js` (mới) | Exclusive lock/guard, conservative PID check, stale PID reclaim, own-token release |
| `src/utils/boundedCache.js` (mới) | TTL và hard-cap cache, oldest eviction |
| `src/utils/configValues.js` (mới), `src/config.js` | Strict numeric validation, absolute paths, config mới và legacy delay fallback |
| `src/handlers/messageHandler.js` | Bounded seenAlbums/seenIds, album buffers/items cap, cancel timers khi stop, ngừng log nội dung riêng tư |
| `src/utils/baileysWrapper.js` | Group cache có TTL/cap; early media metadata size check, stream thay base64 |
| `src/utils/mediaStream.js` (mới) | Native fetch có AbortSignal, Baileys media key helpers, streaming AES-CBC/MAC/hash verification, input error propagation |
| `src/utils/mediaQueue.js` (mới), `src/handlers/mediaHandler.js` | Bounded FIFO batch queue, deadline/cancel, skipped policy, giữ successful items trước partial album timeout |
| `src/services/storageService.js` | Stream ra `.part`, byte limit, exclusive publication và partial cleanup |
| `src/services/jsonStorageService.js` | Success/failure return + persisted timestamp; bỏ migration tự động khi import/start |
| `src/utils/healthMonitor.js` | Connection state, timestamps, queue/cache sizes, conflict counter, external/arrayBuffers; referenced health timer |
| `src/utils/shutdownManager.js` | Synchronous stop hooks, deadline từ đầu shutdown, fatal exit 1, Windows PM2 IPC shutdown |
| `ecosystem.config.cjs` (mới) | Single fork instance, no watch, controlled restart/kill/memory policy |
| `.env.example` | Defaults/config mới, giữ `.env` thực không đổi |
| `package.json` | `npm test` và `npm run test:soak`; không đổi dependencies |
| `tests/helpers.js` và 5 file `tests/*.test.js` (mới) | Fake sockets/clock/process, temporary files, localhost HTTP/decryption, resource soak |

`WHATSAPP_BOT_STABILITY_AUDIT.md` được giữ làm evidence audit trước sửa. Không commit, deploy hoặc chỉnh managed process trong task này.

## Bugs fixed

| Finding | Fix |
|---|---|
| F01 | Conflict 440 hoặc reason conflict/replaced log riêng, chuyển AUTH_REQUIRED và đóng local socket; không tranh session bằng retry storm. Network budget chỉ reset khi READY ổn định 60 s. |
| F02 | seenAlbums chuyển sang TTL cache: mặc định 20 phút / 5000 entries, oldest eviction; áp dụng cả single-media generated IDs. |
| F03 | Queue tối đa 100 pending batches; batch deadline 120 s, AbortController hủy HTTP và file pipeline; không giữ slot vô hạn. |
| F04 | Metadata precheck + encrypted content-length guard + plaintext byte guard; stream xuống file, bỏ Buffer→base64→Buffer ở đường tải hiện tại. |
| F05 | Generation guards, socket-local callbacks, retire/await trước replacement, single factory promise, one reconnect timer; startup transient failure retry; ready watchdog. |
| F06 | connection/messages/creds listeners đều bắt sync throw và promise reject; structured operation/PID/generation/error/stack. Credentials writes serialized; auth persistence failure chọn fatal shutdown. |
| F07 | 401/403/411/500 và QR cần action, không infinite auth retry; không delete/logout session; absolute session path, ownership lock. |
| F11 | STOPPING/generation invalidation ngay lập tức; cancel retry/stable/watchdog/album timers; cancel queued/active media; await socket end + pending creds, flush logs; không reconnect do shutdown. |
| F08/F09 (liên quan memory) | Group cache TTL 15 phút / 1000 entries; seenIds hard cap 2000 / TTL 10 s. Dedup vẫn theo message ID; IDs được đánh dấu ở cùng stage nghiệp vụ như trước. |
| F10 (startup side effect/observability) | Không tự rewrite archive lúc import; persisted timestamp chỉ cập nhật sau append thành công. Migration function còn available nhưng không tự gọi. Sync NDJSON I/O chưa refactor. |
| F13/F14 | dotenv trước logger; thêm health correlation và strict numeric env checks, không parseInt chấp nhận “10abc”. |

## New lifecycle

```text
START
↓
Acquire exclusive ownership for resolved session directory
↓
CONNECTING (one factory invocation; one active local socket)
↓
READY
↓
Stable for 60 seconds → reset reconnect attempt count
↓
TRANSIENT FAILURE
↓
Invalidate generation → detach listeners → await old socket/auth teardown
↓
RECONNECTING (one referenced timer, bounded backoff, unlimited attempts)
↓
CONNECTING → READY
```

```text
loggedOut / badSession / forbidden / multideviceMismatch / QR_REQUIRED
→ AUTH_REQUIRED
→ close local socket, retain session/ownership, health continues
→ operator action; no automatic delete/logout/QR logging

connectionReplaced / conflict
→ explicit CONFLICT + possible duplicate WhatsApp session/socket
→ AUTH_REQUIRED; no retry contest

uncaught exception / truly unhandled rejection / auth write failure /
unsafe socket teardown / hung factory / invalid runtime module
→ STOPPING → cleanup with deadline → exit 1 → PM2 recovery

refused/unverifiable session ownership
→ exit 78; PM2 stop_exit_codes prevents automatic restart storm
```

Late old open/close/message callbacks are ignored even if already queued. An existing message wrapper always retains its originating socket; it never uses the replacement socket. Generation is a monotonically increasing scalar, **not** a retained history of clients. Controller guards start/stop to prevent duplicate setup.

QR output has intentionally been removed from production logs/console. If a session needs pairing, stop this collector and use a separate controlled manual pairing workflow; provisioning UI/tooling is not introduced by this patch. AUTH_REQUIRED does not auto-resume without operator restart after session remediation. Lack of message traffic alone never triggers restart.

## Reconnect behaviour

Default delays: **5 s → 10 s → 20 s → 40 s → 80 s → 120 s → 120 s …**. No attempt cutoff for transient network disconnection. A 30-minute/overnight outage keeps Node alive using the referenced retry/health timers. No busy loop or duplicate reconnect timers. No jitter by default, which makes behaviour/tests predictable.

- `RECONNECT_INITIAL_DELAY_MS=5000`
- `RECONNECT_MAX_DELAY_MS=120000`
- `STABLE_CONNECTION_MS=60000`
- `CONNECTION_READY_TIMEOUT_MS=60000`
- `SOCKET_END_TIMEOUT_MS=10000`

READY for 10 s then close does not reset attempts; a stable 60 s connection does. Startup factory/auth load rejects with transient error → same retry scheduler. If a created socket never becomes READY by 60 s, retire it and retry. If the factory itself is still unresolved, it cannot safely be overlapped: fatal restart instead of launching a second factory. FS permission/disk errors and module/type/syntax failures are also fatal rather than treated as network outages.

Legacy `RECONNECT_DELAY_MS` remains a fallback for initial delay. `RECONNECT_MAX_RETRIES` is validated if present but no longer controls transient recovery. New delay settings take precedence.

## Memory protection

| Resource | Default protection |
|---|---|
| seenAlbums | 5000 entries, TTL 1200000 ms (20 min), oldest eviction |
| seenIds | 2000 entries, TTL 10000 ms |
| Group metadata | 1000 groups, TTL 900000 ms (15 min) |
| Album collection windows | 100 buffers, max 100 media items per reconstructed batch (including expanded children), one 1500 ms timer/buffer |
| Pending media queue | 100 **batches**, not 100 individual files; max 100 items/batch |
| Active media | `MEDIA_CONCURRENCY=1`; allowed config 1..16 |
| Media operation deadline | 120000 ms for the **whole admitted batch**, including all album items; each individual file is necessarily covered |
| Media size | Metadata precheck, encrypted length sanity guard, plaintext limit during streaming; `.env` currently selects 200 MB |
| Lifecycle | One active local socket, one factory invocation, one retry timer; stable/watchdog canceled on state transition |

Queue full: immediate rejection with `MEDIA_QUEUE_FULL`, explicit warning and skipped metadata records, no process crash and no waiting thousands of jobs. Album buffer/item limit also logs and increments skips. These policies trade overload data loss for bounded memory; no durable retry queue is introduced. Increase batch timeout if legitimate slow/many-image albums require more than two minutes.

Timeout aborts transport and pipeline. Queue releases the concurrency slot via its completion/finally path; next job proceeds. A late worker result cannot publish after cancellation because stream/file code checks the abort signal. For synthetic non-cooperative promises, race rejection still releases the slot; production workers use actual cancellation. Shutdown rejects waiting jobs, aborts active tasks, clears album timers and prevents new ingress/storage records. Completed files may remain when an entire batch is cancelled during process shutdown; cancellation does not rewrite/remove existing archive.

Media stays encrypted over HTTP as before; key derivation/URL helper comes from the **installed Baileys version**. Native streaming decryption verifies the trailing ten-byte HMAC and optional plaintext SHA256 before `.part` is published. This transport adapter is needed because rc13 drops AbortSignal and its input pipe does not reliably propagate network stream errors. No Baileys/node_modules edits or version upgrades were made.

Existing NDJSON fields/filename pattern/media metadata remain intact; no base64 was exported in the old NDJSON format, so replacing the in-memory payload with a stream does not change archive schema. A timeout on a later album item keeps earlier successful item paths in the exported record, marking remaining items skipped. Partial files are removed on handled failure; successful final publication never overwrites a pre-existing file.

TTL eviction is lazy on cache read/write/size (including every health summary), without extra periodic cache timers. Expired entries idle in memory for at most the health sampling interval while the process is idle, and hard caps still apply. These protections bound **application resources under test**, not all internal Baileys/protocol caches or arbitrary remote payload sizes.

## Duplicate session protection

Lock location: `<resolved AUTH_PATH>/baileys_auth/bot.lock`, next to the actual auth files. Resolve through realpath, so aliases of the same directory share ownership. Metadata: PID, random token, startedAt, cwd, canonical sessionPath, hostname. No credentials are logged/stored in lock metadata.

- Use exclusive `wx` creation on Windows/Node filesystem APIs; no new dependency.
- A short-lived exclusive `bot.lock.guard` serializes acquisition, stale cleanup and release.
- Existing live PID blocks startup, **even if identity cannot be proved**; a recycled PID therefore gives a safe false positive instead of unsafe takeover.
- Dead PID on this host → stale bot.lock removal inside guard → create new own lock.
- Malformed/unreadable metadata, foreign host or pre-existing guard → refuse; never silently delete unverifiable ownership.
- Graceful cleanup removes bot.lock only if PID/token still belong to this process. Auth/socket cleanup failure keeps the lock until process exit; next start can reclaim it once PID is gone.
- A crash in the tiny guard critical section can leave `bot.lock.guard`; this is intentionally fail-closed and requires operator inspection after verifying no owner/contender is alive. Never delete it just to force startup.

Protection applies to cooperating copies of this new implementation on one Windows host. It cannot stop an older bot with no lock, another machine using copied credentials, or a manually started external WhatsApp client. Confirm those owners during rollout. Do not point multiple hosts at a shared/network session folder.

## PM2 configuration

Created `ecosystem.config.cjs` for app **whatsappbot**:

- `script: index.js`, `cwd: __dirname`, `instances: 1`, `exec_mode: fork`, `watch: false`.
- `autorestart: true`, `restart_delay: 5000`, `time: true`.
- `shutdown_with_message: true` for the Windows IPC graceful path; `kill_timeout: 20000` gives the app its 15 s shutdown budget.
- `stop_exit_codes: [78]` prevents ownership-refusal loops.
- `min_uptime: 10000`, `max_restarts: 50` only for rapid genuine startup/fatal failures. **Network outage does not exit**, so it cannot consume that PM2 unstable-restart budget. Persistent configuration/programming errors deliberately require intervention instead of retrying forever.
- `max_memory_restart: 1G`: defensive Node RSS ceiling, leaving headroom for the configured 200 MB media workload while streaming avoids full-size RAM copies. This is an initial guardrail, not a measured long-run requirement; adjust based on observed concurrency/RSS. PM2 memory checks are periodic and cannot prevent every OOM spike.

No production PM2 commands were run. No Windows startup service/task or power settings were changed. Existing production PM2 configuration and reboot persistence still need independent verification. Config does not hard-code numeric env overrides, so `.env`/inherited production env remain authoritative after strict validation.

## Tests

Run on Windows with Node **v24.13.0** using built-in `node:test`:

```text
npm test
total: 35
passed: 35
failed: 0
skipped: 0
cancelled: 0
```

Coverage includes required network outage beyond 10 attempts, reconnect race/stale events, duplicate close triggers, stable reset, startup failures, auth/conflict classification, ready watchdog/hung factory, serialized creds writes, rejected async callbacks, unsafe teardown, shutdown during retry/media, Windows PM2 shutdown IPC, strict numeric config, health states, TTL/cap, queue overflow/FIFO/stalled jobs, session ownership and stale reclaim.

Integration uses **only localhost HTTP**, synthetic encrypted media and temporary directories outside the real archive/auth/logs. It tests valid AES/MAC payloads with Baileys-derived keys, early oversize rejection, streaming byte limits, stalled headers/body, network break mid-body, corrupt MAC, partial file cleanup, no overwrite, partial-album deadline and unchanged NDJSON schema. Fatal policy uses a fake process exit; tests do not kill a process. Importing storage no longer triggers historical migration.

Offline soak (part of `npm test`, also available as `npm run test:soak`):

- **16000 lifecycle events**, 4000 reconnect cycles / 4001 fake sockets.
- Maximum **1 live local socket**; old application listeners removed; no live lifecycle timers after stop. Fake-clock peak ≤2 timers including short teardown deadlines.
- **100000 album IDs** inserted; cache never above 5000, expired to zero.
- **10000 simultaneous synthetic media jobs**: with concurrency 2, 100 queued admitted plus 2 active; 102 completed and 9898 explicitly rejected as full; queue returned to zero.

This simulation demonstrates resource bounds in application control flow, not real WhatsApp uptime for 14 days. Node test runner reported no unhandled promise/stream errors.

## Remaining risks

1. **Production stability after 1–2 weeks is not yet proven.** Real session/protocol behaviour, throughput and Windows operational state need rollout observation.
2. AUTH_REQUIRED/CONFLICT intentionally remain alive but inactive; monitor the health state, not just PM2 online. Session provisioning/re-pairing requires a separate trusted manual workflow; this patch does not emit QR contents or automatically clear credentials.
3. Existing live bots without this lock and remote copied sessions can still cause conflict. Before rollout verify no second owner; do not delete live-owner locks.
4. Baileys rc13 multi-file auth implementation still has its own file-path→mutex Map and other internal state. This patch bounds app caches/queue/socket resources; it does not prove every dependency allocation bounded. Track RSS/external over weeks and investigate library retention if growth remains.
5. No durable media retry/backfill: overload, timeout, expired CDN URLs and auth interruption may skip media. Previously supported ingestion/filter/archive schema remains, but receipt/saved timestamps do not guarantee lossless delivery.
6. Album grouping remains heuristic (same sender/chat/time window); this patch does not redesign grouping semantics. Group metadata TTL means names may be briefly stale.
7. NDJSON append and explicit migration functions still use synchronous I/O; large/slow disks can block the event loop. Real archive has no retention policy here.
8. Atomic media publication currently uses same-directory hard links (`fs.link`) and assumes NTFS/local filesystem support. Unsupported filesystems or insufficient permissions cause a caught skipped-media error. Abrupt power loss can leave `.part` files; automated deletion of pre-existing files is not introduced.
9. Media crypto/transport adapter is covered by synthetic valid/broken/corrupt fixtures, not live CDN/version drift. CDN reupload/retry tooling and arbitrary protocol variants still require real workload verification; dependency was not upgraded.
10. PM2 memory policy is a recovery limit, not memory safety. Reboot/sleep/Windows Update/service account/startup persistence are outside this implementation.

## Production rollout commands

**Commands only; not run by Codex.** Run on the actual production host in this repository. First inspect current PM2 ownership/config/logs and ensure the correct session path/account. If `.env` or PM2 inherited env contain obsolete/invalid numeric values, reconcile them with `.env.example`; keep existing auth directory and archive. Back up sensitive session/archive using your existing secure process before deployment.

```powershell
Set-Location -LiteralPath 'C:\Users\User\Desktop\Làm cho bác Khánh\whats_app_bot'
node --version
npm test
pm2 status
pm2 describe whatsappbot
pm2 logs whatsappbot --lines 300 --nostream

pm2 stop whatsappbot
pm2 delete whatsappbot
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
pm2 logs whatsappbot --lines 100 --nostream
pm2 describe whatsappbot
```

Only stop/delete the verified app name. If it differs, use its actual name for the first stop/delete; new config creates whatsappbot. If old shutdown was forced, confirm its PID has ended; a dead-PID bot.lock can be reclaimed automatically. Ownership refusal exit 78 requires inspection and an intentional restart after resolving it; never loop starts or remove another owner's lock.

Read logs for `connection-open`/`connection-stable`/health READY. If AUTH_REQUIRED or CONFLICT appears, inspect session/other owners first. Do not auto-delete auth or scan QR as part of these rollout commands. `pm2 save` saves the process list but is **not** a complete Windows reboot-startup installation.

## Verification checklist

Use these read-only checks after deployment:

```powershell
pm2 status
pm2 describe whatsappbot
pm2 logs whatsappbot --lines 300 --nostream
Select-String -Path '.\logs\combined*.log' -Pattern 'health|connection-close|reconnect-scheduled|CONFLICT|AUTH_REQUIRES_ACTION|QR_REQUIRED|Media queue|Media batch skipped'
```

Record process PID/uptime and PM2 restart count; compare with health connectionState, reconnectAttempt + cumulative reconnects, conflictEvents, lastConnectionOpenAt, lastMessageReceivedAt, lastMessagePersistedAt, heap/RSS/external/arrayBuffers, seenAlbumsSize/seenIdsSize/groupCacheSize, albumBuffers/pendingBatches, mediaActive/mediaQueued/mediaQueueOldestAge. Persisted timestamp only changes after actual successful NDJSON append.

| Window | Verification |
|---|---|
| **1 hour** | Correct cwd/auth path/revision/PID; one owner; READY and stable reset; expected test messages/media received and persisted; no conflict/fatal loop. Check skipped/timeout policy with approved test workload. |
| **24 hours** | Uptime/restart count explained; retry delay bounded and recovery visible after a real/controlled outage; queue drains, oldest age does not continually increase; cache sizes stay under caps. |
| **7 days** | Plot RSS/external/heap against traffic and media, distinguish GC plateau from growth; conflictEvents should remain zero in normal single-owner operation; identify every restart reason and Windows event. |
| **14 days** | Review full uptime/reconnect/restart timeline, bounded caches/queue and message persistence; if trend still rises, capture targeted evidence for dependency/auth retention before changing code further. |

No-traffic groups may have old lastReceived/lastPersisted while health is READY; do not restart solely for that. AUTH_REQUIRED, repeated conflict, unbounded queue age, repeated storage failure or unexplained restart require action even if PM2 remains online.
