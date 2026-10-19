# WhatsApp Bot Stability Audit

Ngày audit: 2026-10-03 (Asia/Bangkok). Checkout: `a6cd180`. **Chỉ audit; không sửa production code, dependency, PM2, session hay chạy bot.**

**ROOT CAUSE NOT YET PROVEN** cho sự cố được mô tả xảy ra sau 1–2 tuần. Có bằng chứng trực tiếp về vòng mất kết nối/reconnect do `conflict`, có lỗi giữ bộ nhớ không giới hạn trong source, nhưng không có log bao phủ lần lỗi dài ngày hay trạng thái PM2 tại thời điểm đó.

## Current architecture

Project hiện tại dùng **Baileys 7.0.0-rc13**, không dùng whatsapp-web.js/Puppeteer. `package.json` khai báo `^7.0.0-rc13`; lockfile và package cài tại máy đều là rc13. Không có database, HTTP server, scheduler/cron hoặc API nghiệp vụ khác. Kết nối bên ngoài là WhatsApp WebSocket, truy vấn group metadata và HTTP tải media qua Baileys.

`index.js` → logger/shutdown manager → `bot.start()` → `useMultiFileAuthState()` → `makeWASocket()` → events → wrapper → message handler → album batching/media queue → file media và NDJSON.

Đã đọc toàn bộ 14 file JS của project, package/lock/config mẫu, các giá trị cấu hình vận hành liên quan trong `.env` (không xuất secret), toàn bộ các phần lifecycle/error/health của ba file log, và source dependency cài tại máy cho socket cleanup, event emitter, auth, media và timeouts. Đã search exit/abort/throw/signals/logout/destroy/kill/disconnect/timers/caches trên toàn source. Không có `AGENTS.md`, ecosystem config hoặc startup `.bat/.cmd/.ps1` trong project; không tìm được AGENTS ở các thư mục cha đã kiểm tra.

Không import/chạy application để kiểm tra: chỉ `require('./src/bot')` cũng tự chạy migration và có thể ghi lại archive. Không chạy `test-runtime.js` vì nó ghi log và chỉ kiểm tra loader, không kiểm chứng độ ổn định.

| Thành phần | Source / chức năng |
|---|---|
| Entry | `index.js:3–10`; đăng ký process handler sau khi require bot |
| Socket + reconnect | `src/bot.js:25–135` |
| Auth | `src/bot.js:80–91`, file auth Baileys |
| Message/album/dedup | `src/handlers/messageHandler.js:11–278` |
| Media queue | `src/handlers/mediaHandler.js:11–30,89–158,172–234` |
| Wrapper/network | `src/utils/baileysWrapper.js:7–20,119–148` |
| Storage | `src/services/storageService.js`, `jsonStorageService.js` |
| Logging/health/shutdown | `src/utils/logger.js`, `healthMonitor.js`, `shutdownManager.js` |
| Filtering/JID | `src/utils/groupFilter.js`, `jidUtils.js`; không quản lý connection |

Bot là **collector**, không có handler trả lời hay `sendMessage` trong application source. “Không phản hồi” phải được kiểm tra bằng việc nhận message và cập nhật archive; không thể coi thiếu tin nhắn trả lời tự động là bằng chứng crash.

Cấu hình `.env` tại checkout: thu groups/DMs/broadcasts bật; log info; media concurrency 1; giới hạn media 200 MB. Retry/delay/health/auth/archive không được override trong `.env`, nên mặc định lần lượt là 10, 5000 ms, 300000 ms, `./.baileys_auth`, `./archive`. **Environment do PM2 inject ở máy production chưa biết** và có thể khác.

## WhatsApp lifecycle

```text
START
↓
Require logger → shutdown manager → bot + handlers
↓
dotenv/config; tự migrate toàn archive NDJSON (sync, trước register signal)
↓
shutdown.register() → bot.start() → ensureDirectories + health timer
↓
mkdir AUTH_PATH/baileys_auth → await useMultiFileAuthState
↓
makeWASocket(auth) → đăng ký creds.update / connection.update / messages.upsert
↓
Nếu chưa có auth hợp lệ: QR → chờ người scan
↓
creds.update → saveCreds (async, không có catch tại app listener)
↓
connection=open → READY; reset reconnectCount=0, isReconnecting=false
↓
messages.upsert(type=notify) → wrapper → filter → text save / album timer 1500 ms
↓
Media acquire → download buffer → base64 → size check → sync file write → NDJSON
↓
connection=close
├─ status=loggedOut(401) → process.exit(1), không cleanup/flush chủ động
└─ tất cả status khác → scheduleReconnect
   ├─ isReconnecting=true → bỏ trigger
   ├─ đủ 10 attempts liên tiếp chưa open → process.exit(1)
   └─ sleep backoff → build socket mới (không đợi open)
      ├─ build reject → recursively retry
      └─ build resolve → nhả flag; chờ connection event sau đó
```

Không có `initialize()`, `authenticated`, `ready`, `disconnected`, `auth_failure`, `change_state`, `loading_screen` theo API whatsapp-web.js trong source hiện tại. Tương đương readiness là `connection.update:open`, QR là trường `qr`, disconnect là `close`; `creds.update` không tự chứng minh auth thành công. Log “initialize() error” ở reconnect catch là tên cũ, không phải API thực được gọi.

| Sự kiện | Hành vi thực tế | Loại A–F theo yêu cầu |
|---|---|---|
| Internet mất, WebSocket close/lost | Dependency đóng socket, app retry nếu không 401; tối đa budget hiện tại | A; có thể D rồi E tùy PM2 |
| Internet trở lại | Socket mới có thể open, reset budget; không có Windows/network restored listener riêng | A nếu retry còn hoạt động |
| Auth loggedOut 401 | Exit 1, giữ thư mục auth | D; E phụ thuộc PM2 |
| badSession 500 / forbidden 403 / mismatch 411 / connectionReplaced 440 | Retry chung như network; không phân loại terminal/requires-action | A; nguy cơ loop/D |
| Restart required 515 | Tạo socket mới; đây là reconnect có thể hợp lý sau pairing | A |
| QR chưa scan/hết hạn | Log QR, chưa ready; close do QR expiry có thể lại retry | A/B đối với service chưa hoạt động |
| `_buildClient` thất bại ở startup | Chỉ log, không retry/exit chủ động | F về phục hồi; có thể B hoặc exit tự nhiên |
| Socket chưa ready nhưng không phát close | App không có ready deadline/watchdog | F; B nếu còn handle giữ Node sống |
| Browser crash | Không có browser trong kiến trúc hiện tại | Không áp dụng |
| Async listener reject | Có thể unhandledRejection; global handler chỉ log | C theo nghĩa promise reject, thường không D do handler hiện tại |

Baileys cài tại máy có keepalive 30 s, connect timeout 20 s, query timeout 60 s (`lib/Defaults/index.js:52–56`). Socket `startKeepAliveRequest()` kiểm tra thời gian không nhận dữ liệu và gọi end nếu quá `keepAliveIntervalMs + 5000`; có close/error handlers. Vì vậy không đúng nếu kết luận “hoàn toàn không có heartbeat/network timeout”. App thiếu kiểm tra readiness/ingestion và deadline tải media toàn tác vụ.

## PM2 lifecycle

Chỉ xác nhận được `npm start` → `node index.js`; `npm run dev` dùng `node --watch index.js`. **Không tìm được command PM2 thực tế hoặc app name**; `whatsappbot` ở phần lệnh bên dưới chỉ là ví dụ.

Không có ecosystem config, dump.pm2, startup script trong repository. Tại máy audit, `C:\Users\User\.pm2\pm2.log` có 1321 bytes, chỉ ghi daemon start ngày 2026-05-27 21:29:11, PM2 7.0.1, Node 24.13.0, “SIGTERM timeout: 1600”. Đây không chứng minh kill_timeout hiệu lực của app. Thư mục PM2 logs không có file, không có dump.pm2; pid file chứa 14060 nhưng không tìm thấy process đó. `pm2` không có trong PATH; node là v24.13.0. Ba process node hiện thấy đều thuộc runtime Codex, không phải bot/PM2 theo command line.

Không gọi PM2 CLI để tránh tự khởi động daemon hoặc tạo trạng thái quản lý mới. **Không thể xác nhận production đang online, restart count, exit code, autorestart, restart_delay, max_restarts, min_uptime, max_memory_restart, NODE_OPTIONS, cwd hoặc startup persistence từ snapshot này.** Không mặc định production có cùng môi trường với máy audit.

```text
PM2 start (command/cwd/env chưa biết)
→ Node require/start
→ process tồn tại: PM2 có thể online dù WhatsApp chưa ready
→ Node exit/crash/OS kill
→ nếu autorestart và budget PM2 cho phép: restart
→ nhiều exit khi min_uptime chưa đạt: có thể errored khi vượt max_restarts
→ nếu process vẫn sống nhưng socket/queue hỏng: PM2 không tự nhận biết nghiệp vụ
```

Crash loop chỉ là khả năng cần kiểm tra. Retry app kéo dài nhiều phút có thể vượt min_uptime nên PM2 không nhất thiết tính là unstable restart; không thể nói cứ exit nhiều lần thì PM2 chắc chắn bỏ cuộc.

## Findings

### F01 — Vòng conflict/reconnect được ghi nhận; budget reset ngay open

- **Severity:** HIGH
- **File / Line/function:** `src/bot.js:100–115`, `scheduleReconnect:29–60`; `logs/combined.log:268–547`.
- **Evidence:** 45 dòng **Connection closed** do `Stream Errored (conflict)` từ 2026-06-06 07:28:14 đến 07:32:53; các reconnect tương ứng đều `5000ms (attempt 1/10)`. Có hai dòng application start lúc 07:25:24 và 07:26:20 (`:221,:223`); health 07:30:24 và 07:31:20 đều khoảng uptime 5 phút nhưng khác counters (`:400,:476`). Socket dependency phát close từ stream error (`lib/Socket/socket.js:788–797`).
- **What happens:** open ngắn reset số lần thử; close lại bắt đầu 1/10. Guard không bảo vệ qua nhiều OS process. Dấu hiệu log hỗ trợ nghi vấn nhiều instance tranh session; **không chứng minh được số process, session dùng chung hay nguồn conflict**, vì thiếu PID/socket ID. Những open xuất hiện trước deadline retry một số lần cũng có thể là log nhiều process xen kẽ.
- **Could this explain 1–2 week failure?** Có thể giải thích mất kết nối/reconnect liên tục, là bằng chứng vận hành mạnh nhất; chưa gắn được với mốc 1–2 tuần.

### F02 — `seenAlbums` tăng vĩnh viễn, kể cả ảnh đơn

- **Severity:** HIGH
- **File / Line/function:** `src/handlers/messageHandler.js:35–36,86–90,229–267`.
- **Evidence:** `seenAlbums = new Set()`; mọi batch finalized gọi `seenAlbums.add(groupId)`, không có delete/clear/TTL/limit. Mọi `hasMedia` đi qua album candidate; ID nhóm tự sinh có random nên ảnh đơn cũng thêm ID mới.
- **What happens:** retained strings/Set entries tăng suốt đời process, bao gồm batch tải lỗi hoặc không có item. Đây là **unbounded retention được xác nhận bằng code**, không phải suy đoán leak Chromium.
- **Could this explain 1–2 week failure?** Phù hợp tích lũy dài ngày nếu throughput đủ lớn; chưa có heap dài ngày/heap snapshot để xác nhận OOM hay lượng bộ nhớ thực tế.

### F03 — Media queue không giới hạn và thiếu deadline tải

- **Severity:** HIGH
- **File / Line/function:** `src/handlers/mediaHandler.js:11–30,89–93,120–133,172–175`; `src/utils/baileysWrapper.js:133–139`; dependency `lib/Utils/messages-media.js:296–305`, `lib/Utils/messages.js:869–875`.
- **Evidence:** `_queue.push()` không giới hạn; release chỉ sau await download hoàn thành; concurrency tại checkout =1. Wrapper truyền options `{}`; dependency HTTP fetch không gắn AbortSignal/request deadline ở đường này.
- **What happens:** một download kéo dài giữ slot; pending batches giữ raw messages/wrappers/socket trong closure, queue có thể tăng khi arrival rate vượt completion rate. Concurrency limit chỉ giới hạn active download, không giới hạn backlog. Timeout mặc định của tầng fetch không thay thế deadline toàn tác vụ được app bảo đảm.
- **Could this explain 1–2 week failure?** Có thể làm media/archive đứng trong khi Node online hoặc tăng RAM; chưa có queue/download duration log để chứng minh đã xảy ra.

### F04 — Size limit kiểm tra sau khi đã tải toàn media và chuyển base64

- **Severity:** HIGH
- **File / Line/function:** `src/utils/baileysWrapper.js:134–147`, `mediaHandler.js:175–197`, `storageService.js:63–66`.
- **Evidence:** Baileys ghép các chunk thành Buffer; wrapper chuyển buffer thành base64; sau đó mới estimatedBytes/limit; save lại `Buffer.from(base64)` và write sync. `.env` limit 200 MB.
- **What happens:** media quá lớn đã tiêu tốn RAM trước khi bị reject. Có chunk buffers, buffer ghép/base64 và buffer decode ở các giai đoạn; không giả định tất cả luôn cùng tồn tại hoặc một hệ số peak cố định. Có thể external-memory/RSS spike hoặc OOM; đây không tự nó chứng minh permanent leak.
- **Could this explain 1–2 week failure?** Có thể crash khi tình cờ gặp file lớn; không có log OOM hiện có. Log cũ 2026-05-15 23:49:51 chỉ chứng minh oversize skip ở bản cũ, không chứng minh current code đã OOM.

### F05 — Startup fail không retry; lifecycle guard chưa gắn socket generation

- **Severity:** HIGH
- **File / Line/function:** `src/bot.js:29–60,74–91,93–134`.
- **Evidence:** initial `_buildClient().catch()` chỉ log; global `client` bị gán lại; callback message dùng biến global `client` thay vì socket-local; không end socket cũ/cancel pending retry/check current socket trước build; `_buildClient()` resolve sau đăng ký listener, không sau open.
- **What happens:** startup thất bại không được phục hồi bởi app. Nếu còn referenced handles thì có thể online nhưng chết nghiệp vụ; nếu không còn handle thì Node tự exit (health timer unref). Trong race, socket cũ open đặt flag false trong khi retry đang sleep; timeout vẫn build thêm socket và có thể overwrite client đang sống. Stale close có thể lên lịch retry cho socket mới; close phát trong khoảng flag true có thể bị bỏ. Đó là **đường có thể xảy ra theo cấu trúc**, không kết luận đã tái hiện trong log. Message từ socket cũ có thể truy vấn qua client mới.
- **Could this explain 1–2 week failure?** Có thể sau connection churn; duplicate live socket chưa được chứng minh. Close bình thường được dependency cleanup (xem F12), nên không kết luận mỗi retry đều leak socket.

### F06 — Async auth/message listener có thể reject; global rejection chỉ log

- **Severity:** HIGH
- **File / Line/function:** `src/bot.js:91,93–126,128–134`; `src/utils/shutdownManager.js:63–65`; dependency `lib/Utils/event-buffer.js:26,36–39`.
- **Evidence:** `creds.update` gắn trực tiếp async saveCreds; `messages.upsert` tạo wrapper trước handle try/catch; event emitter dependency không await returned promises/captureRejections. Auth writeFile rejection không được catch trong writeData (`use-multi-file-auth-state.js:28–41`).
- **What happens:** auth write lỗi có thể thành unhandledRejection; malformed msg tại constructor `msg.key.remoteJid` cũng vậy. Global handler log rồi tiếp tục; promise thất bại không được replay/retry, có thể auth không persist hoặc batch ngừng giữa chừng. Network errors được xử lý trong dependency không đồng nghĩa mọi lỗi async đều bị catch. Process chưa nhất thiết crash từ rejection khi có handler này; runtime flags production có thể khác.
- **Could this explain 1–2 week failure?** Có thể contributor qua auth/storage/event failure; không có unhandled rejection evidence trong log supplied.

### F07 — Auth terminal errors bị retry chung; CWD quyết định session

- **Severity:** HIGH
- **File / Line/function:** `src/bot.js:80,100–111`, `src/config.js:3,29–34`; dependency auth `:43–57,87`.
- **Evidence:** chỉ 401 được phân biệt. Session thực ở `.baileys_auth/baileys_auth` (857 file tại snapshot, không đọc nội dung khóa). Paths/dotenv relative CWD; dependency read/parse auth lỗi trả null rồi có thể initAuthCreds mới.
- **What happens:** badSession/forbidden/replaced không được phân biệt với network; PM2 restart khi 401 không tự sửa session. Sai cwd/auth read failure có thể đòi QR. QR chỉ hiển thị console, file logger chỉ ghi “QR received”, không có alert. App không delete auth hoặc gọi logout; reconnect không chủ động logout. Mutex auth dependency chỉ ở trong process, không khóa giữa nhiều OS process.
- **Could this explain 1–2 week failure?** Có thể, nhất là restart/collision/disk failure; không có bằng chứng session revoked hay 401 tại lần lỗi dài ngày.

### F08 — Group metadata cache không TTL/limit

- **Severity:** MEDIUM
- **File / Line/function:** `src/utils/baileysWrapper.js:7–20,97–99`.
- **Evidence:** module-global Map groupId→metadata chỉ set, không xóa; tồn tại qua reconnect.
- **What happens:** bộ nhớ tăng theo số group khác nhau và participant metadata. Với tập group cố định thì có thể plateau; group subject cũ không refresh khiến filter sai sau đổi tên. Metadata fetch fail trả null → tên Unknown → keyword filter có thể skip.
- **Could this explain 1–2 week failure?** Có thể contributor, yếu hơn seenAlbums; không chứng minh cache volume.

### F09 — Dedup không hard cap/TTL thực và đánh dấu trước khi lưu

- **Severity:** MEDIUM
- **File / Line/function:** `src/handlers/messageHandler.js:11–24,127–133,169–176`.
- **Evidence:** cleanup chỉ chạy khi `isDuplicate` thấy size>=2000; không xóa entries trẻ; finalization tự set IDs bypass cleanup.
- **What happens:** 2000 là ngưỡng sweep, không hard max. Traffic rất cao trong 10 s/album finalize có thể vượt; nếu không có message mới thì IDs giữ lại. Retry cùng ID bị skip dù save/download đã fail. Không đồng nhất với Set tăng vĩnh viễn: seenIds có cơ chế pruning khi có traffic tiếp.
- **Could this explain 1–2 week failure?** Có thể làm mất message/cộng thêm RAM; chưa đủ để kết luận leak tăng tuyến tính mãi.

### F10 — Synchronous I/O và migration toàn archive mỗi startup

- **Severity:** MEDIUM
- **File / Line/function:** `src/services/jsonStorageService.js:108–125,128–206`; `storageService.js:45–66`; `index.js:5–7`.
- **Evidence:** append/write sync; migration read toàn file, split lines/newLines/JSON, walk sync rồi write lại nếu đổi; `runMigration()` ngay module load trước shutdown.register.
- **What happens:** archive tăng theo ngày không có retention. Restart về sau có thể tốn RAM/CPU/I/O và trì hoãn socket start/signal setup. Disk full/permission errors của save được catch; `save()` không trả failure cho handler nên msgsProcessed vẫn tăng dù jsonFailed. Event-loop blocking có thể trì hoãn keepalive; metric lag chỉ một setImmediate không đảm bảo bắt block đã xảy ra trước sample.
- **Could this explain 1–2 week failure?** Có thể lúc restart/file lớn/disk chậm hoặc hết chỗ; không có duration/disk log chứng minh. Không có DB pool/connection leak.

### F11 — Exit bypass cleanup, shutdown không await socket end

- **Severity:** MEDIUM
- **File / Line/function:** `src/bot.js:41,67–71,111`; `shutdownManager.js:16–51,55–65`.
- **Evidence:** retry exhausted/logout gọi process.exit trực tiếp; cleanup `try { client.end(); }` không await, trong dependency end async. Không hủy reconnect/album/queue và không tắt reconnect khi shutdown.
- **What happens:** async end reject không được sync catch; shutdown có thể finish trước socket teardown/auth writes/media. Closing socket có thể kích hoạt retry trong cửa sổ shutdown. Chỉ latest global client được end. Direct exit có thể mất log chưa flush. Timeout 15 s được cài sau await healthSummary, nên không bao phủ phần health bị kẹt.
- **Could this explain 1–2 week failure?** Contributor khi stop/restart, không có lịch tự shutdown sau 1–2 tuần. PM2 shutdown timeout hiệu lực cần đo/config thực tế.

### F12 — Không có Chromium hiện tại; log lịch sử xác nhận browser profile conflict

- **Severity:** INFO (lịch sử lỗi vận hành HIGH)
- **File / Line/function:** `package.json`; `src/bot.js:3,85–89`; `logs/error.log:1–9`; Baileys `lib/Socket/socket.js:469–505`, event-buffer destroy.
- **Evidence:** error log 2026-05-12 20:29:06–20:38:22 có 9 lỗi browser already running cho `.wwebjs_auth/session`; current app không import Puppeteer. Baileys end clear keepalive/QR timers, close ws, gọi end handlers và destroy emitter.
- **What happens:** profile bị một browser chiếm ở bản trước là confirmed historical symptom. Không biết browser orphan hay instance thứ hai. Không có headless/flags/pages/browser-disconnected handler để audit trong bản hiện tại. Normal closed socket có dependency cleanup; không có bằng chứng listeners/timers tăng sau mỗi normal reconnect.
- **Could this explain 1–2 week failure?** Chỉ nếu production thực tế vẫn chạy bản cũ; cần xác nhận deployed revision/path. Không áp lỗi Chromium lịch sử lên Baileys hiện tại.

### F13 — Logger load trước dotenv; thiếu correlation và vận hành PM2

- **Severity:** MEDIUM
- **File / Line/function:** `index.js:3–5`, `logger.js:7–8,44–55,62–66`, `config.js:3`, `healthMonitor.js:9–34,64–91`.
- **Evidence:** logger chốt env trước config load dotenv. Pino của socket và wrapper đều silent; log không PID/client generation/status code/stack structured disconnect. Health có uptime/heap/RSS/lag/counters nhưng authFailures không được inc ở bot; reconnects tăng khi close kể cả loggedOut.
- **What happens:** LOG_PATH/LEVEL chỉ trong `.env` có thể bị bỏ qua, khác env inject sẵn bởi PM2. Memory/uptime **đã có log**, không phải hoàn toàn thiếu; queue/cache/last-message/readiness không có. Combined log có thể chứa nhiều process và test/migration. Winston rotation có maxsize/maxFiles, không unbounded log growth theo cấu hình. `exitOnError:false` không bảo đảm mọi transport error bị catch; app không có logger error listener.
- **Could this explain 1–2 week failure?** Mainly làm diagnosis khó; transport I/O error có thể contributor nhưng chưa có evidence.

### F14 — Một số env số không validate

- **Severity:** MEDIUM
- **File / Line/function:** `src/config.js:12–20,39–41`; `mediaHandler.js:14–20`.
- **Evidence:** chỉ retry/delay validate; mediaConcurrency, maxMediaSizeMb, healthIntervalMs parseInt trực tiếp.
- **What happens:** concurrency 0/negative/NaN làm mọi media acquire vào queue mà không có active task để release; max size NaN làm comparison không chặn; interval sai có thể timer quá nhanh. Giá trị trong `.env` hiện tại concurrency=1 hợp lệ, không có bằng chứng lỗi này đang xảy ra. parseInt cũng chấp nhận hậu tố, không kiểm tra strict integer.
- **Could this explain 1–2 week failure?** Không phải ứng viên mạnh với cấu hình hiện có; có thể nếu env PM2 khác.

## Root cause candidates

### ROOT CAUSE CANDIDATE 1 — Conflict/session contention và reconnect churn

**Evidence:** F01 có 45 disconnect do conflict trong 4 phút 39 giây, attempt luôn 1/10; hai startup và health uptime hỗ trợ nghi vấn overlapping instances. F05 không có socket generation protection/cross-process lock. **Confirmed:** có conflict storm trong log. **Chưa proven:** process nào tranh session, nguồn conflict cụ thể, current implementation là code chính xác tại mọi timestamp, và liên hệ với failure dài ngày. Để xác nhận cần PID/cwd/script/revision của mọi bot, PM2 jlist/daemon log, disconnect status code và session path.

### ROOT CAUSE CANDIDATE 2 — RAM tích lũy do seenAlbums, cộng cache/queue

**Evidence:** F02 là retention không giới hạn chắc chắn; F03/F08 là backlog/cache không giới hạn; auth dependency còn giữ file mutex Map (xem memory section). Phù hợp thời gian dài nhưng log current Baileys cuối chỉ 50 phút: heap 32.5–34.6 MB ở đoạn ổn định, RSS giảm khoảng 91 xuống 74 MB; không thể suy ra leak rate/OOM sau tuần. Cần memory trend, volume và heap comparison.

### ROOT CAUSE CANDIDATE 3 — Media stuck hoặc peak allocation/I/O

**Evidence:** F03 thiếu deadline toàn download, concurrency=1, queue unlimited; F04 limit sau download; F10 I/O sync. Có thể online nhưng media không hoàn tất, hoặc OOM. Cần active/queued/duration/external memory và mẫu failed media; không có lỗi media/OOM chứng minh trong đoạn Baileys cung cấp.

### ROOT CAUSE CANDIDATE 4 — Session/terminal failure hoặc restart/startup không phục hồi

**Evidence:** F05/F07/F11, các exit path rõ ràng. Cần logs 401/badSession/max retries/initial failure, PM2 exit codes và cwd. Chưa thấy các terminal markers này trong current supplied log.

Windows sleep/reboot/startup failure là ứng viên bên ngoài chưa xếp trên các bằng chứng code/log: **NOT VERIFIABLE FROM CODE**.

## PM2 online but bot dead scenarios

1. QR chưa scan/session không load đúng: socket/process sống nhưng chưa open; không có alert.
2. Conflict storm: readiness chỉ thoáng qua rồi reconnect; PM2 không đánh giá ingestion.
3. Media download giữ slot → queue tăng; text có thể vẫn thu được. Cần phân biệt chết toàn bot với chết pipeline media.
4. Socket open nhưng không nhận/giải mã message, hay async listener reject: global rejection log không phục hồi chức năng; không có last successful message watchdog.
5. Startup build fail/hang hoặc close trigger bị bỏ trong race; **online chỉ nếu còn referenced handles**, không coi health unref là thứ giữ Node sống.
6. Event loop bị block bởi sync I/O/CPU: process còn tồn tại nhưng callbacks không chạy kịp.
7. Archive write lỗi: handler vẫn incMessage/log processed nhưng jsonFailed tăng; người đọc archive tưởng không nhận message.
8. Metadata cache cũ hoặc fetch lỗi + keyword filter; messages bị skip trong khi connection còn sống.
9. Env mediaConcurrency không hợp lệ: media queue đứng ngay từ đầu; chưa có ở checkout hiện tại.
10. PM2 đang quản lý script/cwd/session cũ hoặc một process khác: trạng thái online không xác nhận instance người dùng đang quan sát.

Chromium chết trong khi Node sống là khả năng của bản cũ; **không áp dụng current Baileys source**. Máy sleep/hibernate thì process có thể vẫn tồn tại nhưng không thực thi; phải đối chiếu Windows events.

## Process actually exits scenarios

| Code path / search hit | Trigger và ảnh hưởng | PM2 restart / loop / online |
|---|---|---|
| `src/bot.js:41` process.exit(1) | scheduleReconnect được gọi khi count>=10; direct exit | Có thể restart nếu policy cho phép; tái lỗi có thể loop; instance đã exit không còn online, trừ trạng thái/race hoặc instance khác |
| `src/bot.js:111` process.exit(1) | close status 401 loggedOut | Restart không tự sửa auth; loop/QR tùy session; chưa có evidence occurrence |
| `shutdownManager.js:29` | Cleanup quá 15 s sau health phase; code 1 nếu ban đầu 0 | Restart phụ thuộc PM2 đang chủ động stop hay lỗi; mất cleanup |
| `shutdownManager.js:51` | SIGINT/SIGTERM cleanup xong exit 0; uncaughtException exit 1 | PM2 chủ động stop khác autorestart khi crash; phải đọc daemon log |
| `shutdownManager.js:55–60` | Signals và uncaughtException gọi shutdown | Node còn sống trong cleanup ngắn nhưng không có bảo đảm WhatsApp hoạt động |
| `config.js:16,19` throw | Env retry/delay invalid khi require bot; xảy ra trước register | Exception không qua app handler, Node fail startup; có thể fast crash loop |
| `index.js:3–5` requires | Missing dependency/incompatible Node/module-load error; trước register | Fail startup; PM2 tùy policy |
| `test-runtime.js:13,17` throw/exit | Loader validation failure, chỉ khi chạy script test | Không nằm trên npm start/current bot path; PM2 chỉ liên quan nếu chạy sai script |
| Node runtime/native fatal/OOM/OS termination | Không phải app process.exit; fatal heap exhaustion không bảo đảm đi qua JS handler | PM2 restart chỉ khi daemon sống và policy cho phép |
| Tự exit event loop hết handles | initial build thất bại, socket cleanup xong không còn handles; health unref | Không có process.exit marker; PM2 có thể restart |

Search application **không tìm thấy** process.abort, client.destroy, client.logout, browser.close hoặc `.kill()`. `client.end()` duy nhất ở cleanup `bot.js:70` là async socket close, không trực tiếp exit; socket emits close có thể lại kích hoạt scheduleReconnect. `unhandledRejection` handler (`shutdownManager.js:63–65`) chỉ log, không exit. `logger.exitOnError:false` là option logging, không một lời gọi exit. Không có timer định kỳ nào được cấu hình để stop bot sau 7/14 ngày.

### Error handling audit

| Operation / lỗi | Catch hiện tại | Escape/crash/remaining risk |
|---|---|---|
| WS ECONNRESET/ECONNREFUSED/ENOTFOUND/ETIMEDOUT/closed/socket hang up | Baileys ws error/close → end → app close/retry | Không thấy lỗi này cụ thể trong logs; không thể quy mọi lỗi cùng một path nếu origin khác; max retry/401 có thể exit |
| groupMetadata query/network | Wrapper :13–19 log rồi null; handle getChat :183–190 còn catch | Có thể Unknown/filter skip; dependency query timeout 60 s |
| HTTP media fetch/stream failure | `_downloadItem` :174–179 catch downloadMedia rejection | Log thiếu err.message dù returned metadata có error; không bảo đảm stalled promise được kết thúc |
| save media FS errors, ENOSPC/EACCES | `_downloadItem` :217–234 catch | fail counter/skipped result; không trực tiếp crash; memory allocation fatal OOM không tương đương catchable ENOMEM |
| NDJSON append/serialize | jsonStorage save :109–125 catch; handler không nhận failure | Collector có thể không lưu nhưng vẫn “processed” |
| Startup/auth mkdir/load/socket creation | `_buildClient` rejected; initial catch chỉ log; reconnect catch recursive retry | Initial phục hồi thiếu, retry eventual exit |
| creds.update async write | Không app catch; dependency write try/finally chỉ release lock | Có thể unhandledRejection; global log-only; auth persist lỗi |
| malformed message wrapper hoặc async connection callback | Ngoài handle catch; emitter không await | Có thể unhandledRejection; batch sau có thể vẫn chạy nhưng chưa phục hồi message lỗi |
| handle và album finalize | broad try/catch + timer callback catch | Phần lớn nghiệp vụ được catch; logger itself throws/rejects vẫn có thể escape |
| logger transport Error event/sync exception | Không app logger.on(error); uncaughtException sau register gọi shutdown | Khả năng theo API/error source, chưa có vận hành evidence |
| client.end async rejection trong cleanup | Sync try/catch không catch promise | Global unhandledRejection; cleanup vẫn tiến tới exit |
| Navigation timeout/Protocol error/Target closed/Execution context destroyed | Không có current browser path | Historical logs chỉ có profile conflict, không các lỗi này |

## Memory leak risks

- **Confirmed source retention:** seenAlbums không evict; mỗi batch kể cả single media giữ ID vĩnh viễn.
- **Unbounded theo group count:** groupMetadataCache giữ participant metadata; fixed group set có thể plateau.
- **Dependency source retention:** `node_modules/@whiskeysockets/baileys/lib/Utils/use-multi-file-auth-state.js:10–18` module-global `fileLocks` Map path→Mutex không delete. Tăng theo distinct auth key filenames đã read/write/remove; key-file deletion không loại mutex. **Có bằng chứng cấu trúc giữ entry, chưa đo tăng trên production; không kết luận mọi state/caches của thư viện leak.**
- **Conditional backlog retention:** `_queue` không bound/deadline; suspended finalizeAlbumBatch giữ message/raw payload/client; getGroupMetadata đang chờ cũng giữ message. Không có application message-history store riêng.
- **Transient spike:** media chunk/buffer/base64/decode và migration read/split/stringify toàn file. Không thấy media buffer được lưu trong một global array sau completion; bình thường local refs được GC khi promise/function kết thúc.
- **Dedup:** threshold-based cleanup, không hard cap; không bảo đảm TTL check khi has(id). Finalizer set bypass pruning.
- **Album buffers/timers:** mỗi group tạo một timeout 1500 ms, xóa map entry khi finalize bắt đầu. Không recursive timer/no-clear leak vĩnh viễn ở đường bình thường; bursts/event-loop stall vẫn giữ nhiều group/messages. Shutdown không cancel timers hay drain batches.
- **Health:** start guard ngăn duplicate interval, stop clear interval, timer unref. Không có duplicate health timer theo normal flow. Cleanup-task array push khi start nhưng entrypoint chỉ start một lần; không chứng minh start được gọi nhiều lần.
- **Sockets/listeners:** dependency normal end clear timers/destroy emitter; không chứng minh mỗi reconnect leak listeners. Race/multi-process concurrency và old references trong pending queue là rủi ro riêng.
- **Database/Puppeteer:** không có DB connections/pool/pages/browser trong bản hiện tại.
- **Logs:** không thấy `MaxListenersExceededWarning`, `heap out of memory`, `ENOMEM`. Existing health đoạn Baileys ngắn không đủ kiểm định 1–2 tuần. Cần RSS/external/arrayBuffers chứ không chỉ heapUsed; không đặt kết luận OOM từ warning threshold 300 MB.

## Chromium/Puppeteer risks

Current architecture: **không áp dụng** headless/flags/page leaks/orphan Chromium/browser disconnected listener. `.wwebjs_cache` là artifact lịch sử, không được current source dùng. May logs chứng minh browser profile in-use nhưng không phân biệt orphan browser, duplicate process hay lỗi teardown. Nếu production vẫn dùng whatsapp-web.js, cần source revision của bản đó và process browser lúc sự cố; current checkout không đủ audit production cũ.

## Session/auth risks

Auth persist bằng multi-file state + creds.update. Session actual path là `AUTH_PATH/baileys_auth`; mặc định nested `.baileys_auth/baileys_auth`, không phải chỉ `.baileys_auth`. Không RemoteAuth/LocalAuth hiện tại. Không code xóa session hoặc logout; lệnh “Please clear session” chỉ là thông báo. Không xóa khóa để điều tra.

Network transient nên retry; loggedOut/session-invalid/replaced/forbidden cần diagnosis riêng. Current chỉ tách loggedOut 401. Không nhận biết đường đọc auth bị lỗi trả null; có thể chờ QR mà file log không chứa QR usable. Directory tồn tại/857 file không chứng minh state hợp lệ. Kill giữa writeFile và mutex chỉ process-local có nguy cơ state bị hỏng/tranh ghi; chưa có log chứng minh.

## External/Windows risks

**NOT VERIFIABLE FROM CODE:** Windows Update restart, sleep/hibernate, shutdown/power loss, user logout, máy/network policy, user unlink linked device, PM2 daemon/service/task không startup sau reboot. Snapshot audit không phải evidence về host production tuần trước. Chưa đọc Windows event log để áp vào incident vì không có thời gian/host incident xác định; commands cụ thể bên dưới dùng trên đúng máy chạy bot.

PM2 service/Scheduled Task/startup persistence không được thiết lập trong repo. Windows user logout chỉ ảnh hưởng nếu bot/daemon phụ thuộc interactive session; không khẳng định logout luôn kill PM2. Kiểm tra account chạy service/task, điều kiện task, sleep policy, last boot và events. Không cài startup, thay power settings hay resurrect trong vòng audit này.

## Existing logs and timestamp correlation

| Evidence | Diễn giải được phép |
|---|---|
| `logs/bot-2026-05-12.log`, 1005 bytes | Bản cũ auth/ready, lặp authenticated và SIGINT 20:06:32; không chứng minh duplicate listeners |
| `logs/error.log:1–9`, 2228 bytes | Browser already running 2026-05-12; historical startup/profile conflict |
| `logs/combined.log`, 83334 bytes, 705 lines | Trộn bản cũ và migration/test/Baileys; không có PID |
| combined :221,:223 | Hai start 2026-06-06 07:25:24 và 07:26:20; không thấy shutdown xen giữa, hỗ trợ overlapping-instance hypothesis nhưng không chứng minh |
| combined :266–267 | QR refs attempts ended 07:28:07 và reconnect; service chưa authenticated cho ít nhất một stream |
| combined :268–547 | 45 close do conflict, retry 1/10 lặp; xác nhận churn, không xác nhận OOM/PM2 restart |
| combined :552–555 | SIGINT 07:32:55 → health uptime 6m35s, reconnects=24 → Closing socket → cleanup complete |
| combined :556–560 | Start 07:33:13 → QR → restart required 07:33:28 → READY 07:33:37; restart required được phục hồi |
| combined :599–705 | Đoạn ổn định 5–50 phút; message/media lưu được; kết thúc 08:23:13 không có exit/error marker |
| user `.pm2/pm2.log` | Chỉ daemon startup 2026-05-27; không application exit/restart records |

Timestamps log không ghi UTC offset. Daemon banner May có GMT+0700; không tự giả định mọi host/log production cùng timezone. Khoảng trống May→June và sau June **không chứng minh process chạy liên tục hoặc crash**. SIGINT có thể từ Ctrl+C hoặc supervisor; không coi đó là unexplained self-crash. Không thấy current max-attempts/logout/unhandled rejection/uncaughtException/OOM markers. Logs thiếu cửa sổ 7–14 ngày và thời điểm incident nên không xác định được restart history cuối cùng.

## Missing observability

Đã có uptime, heapUsed/heapTotal, RSS, event-loop sample, close reason message, retry count/delay và processing counters. Những phần thiếu hoặc chưa đáng tin:

- PID, host, boot ID, deployed commit/script path, cwd, resolved auth path, socket generation; không correlate nhiều instances.
- Numeric disconnect status/name/full error/lastDisconnect.date; reason string đã có nhưng thiếu classification.
- Readiness state/last open, last message received vs persisted, last creds save; no service liveness check.
- Reconnect pending timer/current generation, total attempts qua nhiều opens; current count reset sớm.
- Media active/queued/oldest age, download start/end/duration/bytes/error stack; queueStats export chưa được log.
- Cache/Set/Map sizes, message volume, external memory/arrayBuffers và memory trend dài ngày.
- Auth failures counter không được cập nhật bởi bot, đừng hiểu authFail=0 là auth luôn tốt.
- PM2 app config, restart/unstable_restart count, exit_code, reason, stdout/stderr/daemon logs và windows events.
- Startup migration duration/peak RAM/file sizes, disk free/IO errors và confirmed write success.
- Baileys diagnostic logger silent; không có browser log cần thêm cho current architecture.

## Evidence needed on next failure

Chạy **trên đúng máy production, trước khi restart/stop/xóa session**. Dùng PowerShell. Các command dưới là đề xuất thu thập; audit chưa chạy PM2 hay thay settings. Trước tiên lấy đúng name/id từ status, thay `whatsappbot` nếu khác. Không chạy một bot thứ hai để “test”.

```powershell
Get-Date -Format o
Get-TimeZone
node --version
npm --version
Get-Command node,pm2 -ErrorAction SilentlyContinue | Select-Object Name,Source
pm2 status
pm2 describe whatsappbot
pm2 logs whatsappbot --lines 300 --nostream
pm2 logs whatsappbot --err --lines 300 --nostream
pm2 report
```

Lưu evidence vào thư mục mới ngoài repo; `jlist`/report có thể chứa env/secret, giữ private và redact trước khi chia sẻ:

```powershell
$auditEvidence = Join-Path $env:USERPROFILE ('Desktop\wa-evidence-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $auditEvidence | Out-Null
pm2 jlist | Out-File (Join-Path $auditEvidence 'pm2-jlist.json') -Encoding utf8
pm2 report | Out-File (Join-Path $auditEvidence 'pm2-report.txt') -Encoding utf8
pm2 describe whatsappbot | Out-File (Join-Path $auditEvidence 'pm2-describe.txt') -Encoding utf8
pm2 logs whatsappbot --lines 1000 --nostream | Out-File (Join-Path $auditEvidence 'pm2-recent.txt') -Encoding utf8
$auditPm2Home = if ($env:PM2_HOME) { $env:PM2_HOME } else { Join-Path $env:USERPROFILE '.pm2' }
Get-Content (Join-Path $auditPm2Home 'pm2.log') -Tail 500
Copy-Item -LiteralPath (Join-Path $auditPm2Home 'pm2.log') -Destination $auditEvidence -ErrorAction Continue
Get-ChildItem -LiteralPath (Join-Path $auditPm2Home 'logs') -File | Select-Object Name,Length,LastWriteTime
```

Đọc `pm2 describe/jlist` lấy chính xác `pm_exec_path`, `pm_cwd`, stdout/stderr paths, interpreter/node_version, status, pm_uptime, restart_time, unstable_restarts, exit_code, autorestart, min_uptime, max_restarts, restart_delay/exp_backoff_restart_delay, max_memory_restart, kill_timeout, env/NODE_OPTIONS. Nếu không có app trong PM2, đối chiếu đúng PM2_HOME/account/service; không tự start/resurrect trước thu thập.

Từ đúng `pm_cwd` project:

```powershell
git rev-parse HEAD
git status --short
Get-Content package.json
Get-Content logs\combined.log -Tail 500
Get-Content logs\error.log -Tail 300
Copy-Item -LiteralPath '.\logs' -Destination (Join-Path $auditEvidence 'project-logs') -Recurse
Select-String -Path '.\logs\*.log' -Pattern 'Connection closed|Reconnecting|Logged out|Max reconnect|Initial startup|Unhandled|Uncaught|Protocol error|Target closed|Session closed|Execution context|Navigation|WebSocket|auth_failure|ENOMEM|heap out of memory|MaxListenersExceededWarning|shutdown|health'
Get-ChildItem -LiteralPath '.\.baileys_auth\baileys_auth' -File | Measure-Object
Get-ChildItem -LiteralPath '.\archive' -Recurse -File | Sort-Object Length -Descending | Select-Object -First 10 FullName,Length,LastWriteTime
Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free,Root
```

Paths trên dùng mặc định; nếu `AUTH_PATH/LOG_PATH/ARCHIVE_BASE` khác thì dùng resolved path trong cwd/env thực tế. Không đưa auth files/QR/private message archive vào report công khai.

Process/socket snapshot, kiểm tra nhiều bot/Chromium (Chromium chỉ có ý nghĩa nếu deployed bản cũ):

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|chrome|chromium|msedge)\.exe$' } | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine | Format-List
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,StartTime,CPU,WorkingSet64,PrivateMemorySize64,HandleCount
Get-NetTCPConnection | Where-Object { $_.OwningProcess -in (Get-Process node -ErrorAction SilentlyContinue).Id } | Select-Object OwningProcess,State,RemoteAddress,RemotePort
Resolve-DnsName web.whatsapp.com
Test-NetConnection web.whatsapp.com -Port 443
```

DNS/TCP test chỉ xác nhận một endpoint lúc kiểm tra, không chứng minh WebSocket auth/media CDN hoạt động. OS memory không thay heap snapshot nhưng giúp phát hiện RSS tăng và process owner. Snapshot lần hai sau khoảng 5–10 phút giúp so sánh uptime/restart/memory; thu logs trước mọi can thiệp.

Windows events và startup (khoảng 14 ngày, chỉnh sát thời gian failure):

```powershell
$auditSince = (Get-Date).AddDays(-14)
Get-CimInstance Win32_OperatingSystem | Select-Object LastBootUpTime,FreePhysicalMemory,TotalVisibleMemorySize
Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=$auditSince; Id=41,42,1074,6005,6006,6008} -ErrorAction Continue | Select-Object TimeCreated,Id,ProviderName,Message
Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Power-Troubleshooter'; StartTime=$auditSince} -ErrorAction Continue | Select-Object TimeCreated,Id,Message
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=$auditSince; Id=1000,1001} -ErrorAction Continue | Where-Object { $_.Message -match 'node|chrome|chromium|pm2' } | Select-Object TimeCreated,Id,Message
Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-WindowsUpdateClient/Operational'; StartTime=$auditSince} -ErrorAction Continue | Select-Object TimeCreated,Id,Message
Get-CimInstance Win32_Service | Where-Object { $_.PathName -match 'pm2|node|whatsapp' } | Select-Object Name,State,StartMode,StartName,PathName
Get-ScheduledTask | Where-Object { $_.TaskName -match 'pm2|whatsapp|node' -or ($_.Actions.Execute -join ' ') -match 'pm2|node' -or ($_.Actions.Arguments -join ' ') -match 'pm2|whatsapp' } | Select-Object TaskName,TaskPath,State,Principal,Actions,Triggers,Settings
Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,User,Location
powercfg /getactivescheme
powercfg /query
```

Nếu nghi user logout, đọc Security IDs 4634/4647 trong cùng time window bằng account có quyền; audit policy/log retention có thể không ghi đủ. Event 1074 message/process phân biệt reboot chủ động/Update; event 42/wake records hỗ trợ sleep timeline. Power scheme hiện tại không chứng minh trạng thái lịch sử. Không sửa Windows power/service/task trong vòng thu evidence.

Nếu cần chứng minh leak/stalled queue: **đề xuất sau audit, chưa tạo script/chưa bật instrumentation** ghi cache/queue sizes, download deadlines/duration, socket generation/PID, external/arrayBuffers và heap profiling có kiểm soát. Heap snapshot có thể pause process và chứa dữ liệu private; chỉ tiến hành theo kế hoạch điều tra riêng.

## Final diagnosis

```text
Confirmed root cause:
Chưa xác định root cause của sự cố sau 1–2 tuần.
Confirmed observations: historical Chromium profile-in-use;
current-era Baileys conflict/reconnect storm; unbounded seenAlbums retention trong source.
Các observation này không tự chứng minh incident dài ngày.

Likely root cause:
Theo vận hành logs: conflict/session contention + reconnect budget reset sớm.
Theo cấu trúc phù hợp dài ngày: seenAlbums accumulation, media backlog/peak allocation.
Không đủ cơ sở chọn duy nhất một nguyên nhân cho production failure được mô tả.

Possible contributing factors:
Socket generation race/multiple instances; queue thiếu bound/deadline;
size limit sau download; group/auth file-lock cache; sync I/O/startup migration;
auth reject không được recover; CWD/env khác; terminal auth errors retry chung;
shutdown không await/cancel; PM2/Windows persistence chưa xác minh.

Not enough evidence:
Crash hay chỉ offline tại failure thực; PM2 restart count/exit_code/config;
deployed revision; 7–14 ngày memory; OOM/native exit; session invalid;
duplicate processes/sockets tại incident; Windows reboot/sleep/logout timeline.
ROOT CAUSE NOT YET PROVEN
```

### Trả lời 10 câu hỏi cuối task

| # | Câu trả lời có bằng chứng |
|---|---|
| 1 | Log xác nhận mất kết nối và SIGINT; không xác nhận unexplained crash dài ngày. Online-but-inactive paths có ở source. |
| 2 | Chưa xác định PM2 đang restart; không có app/daemon restart evidence trên máy audit. |
| 3 | Có: retry exhausted, loggedOut, shutdown timeout/completion; module-load throw cũng fail startup. |
| 4 | Có exponential reconnect: 5/10/20/40/80/120/120/120/120/120 s, 10 attempts trước khi lần trigger kế tiếp exit nếu chưa open; tổng sleep 755 s, chưa cộng build/connect duration. |
| 5 | Reset budget ngay open; thiếu generation/old socket cancellation; startup catch không retry; async build resolve không đồng nghĩa ready; terminal reasons không phân loại. Race là source risk, chưa proven runtime. |
| 6 | Current không có Chromium. Bản cũ có thể có browser chết/lock, nhưng log chỉ chứng minh profile-in-use. |
| 7 | Có confirmed unbounded seenAlbums và unbounded cache/queue risks. Không chứng minh duplicate live client/timer/listener sau normal close; dependency có cleanup. |
| 8 | Có thể invalid/revoked/read failure/CWD khác; không có evidence current 401 incident; reconnect không chủ động logout/xóa session. |
| 9 | Có khả năng crash loop nếu PM2 policy và exit timing phù hợp; chưa chứng minh PM2 đã bỏ cuộc. Conflict reconnect có thể lặp mãi mà không exit do reset 1/10. |
| 10 | Strongest logs: conflict storm. Strongest long-run code risk: seenAlbums giữ ID mãi. Chưa chứng minh nguyên nhân của mốc 1–2 tuần. |

## Recommended fix plan

**Chỉ đề xuất. KHÔNG IMPLEMENT trong task này.**

### P0 - must fix

1. Xác nhận đúng deployed script/revision/cwd/PM2_HOME và thu evidence failure; kiểm tra mọi process cùng session. Nếu xác nhận duplicate instances, giữ một owner cho session và ngăn trùng start.
2. Lifecycle một socket generation: classify disconnect, ignore stale events, cancel retry pending, close/await previous socket khi cần, startup failure có recovery, ready deadline và budget reset sau stable connection thay vì chỉ open tức thì. Tách auth requires-action khỏi transient network retry.
3. Giới hạn/TTL `seenAlbums`; media backlog bound, operation deadline/cancel, error completion release slot; size guard trước và trong streaming, tránh base64/full-buffer copy không cần thiết.
4. Bắt rejected promises tại listener auth/message/connection, log đúng operation và bảo đảm trạng thái failure được recover hoặc restart có chủ đích. Không coi log-only global handler là recovery.

### P1 - should fix

1. Thêm PID/socket ID/status code/last successful receive/save/auth persist, queue/cache sizes, external memory; giữ health đã có, sửa ý nghĩa reconnect/auth counters.
2. Đọc dotenv trước logger, validate tất cả numeric config, pin/reproduce dependency/runtime sau khi kiểm định tương thích. Không tự nâng library để che root cause.
3. Định nghĩa PM2 config từ host evidence: cwd/env, autorestart/backoff/memory/restart budget/kill_timeout; kiểm chứng Windows service/task startup và save/resurrect workflow riêng.
4. Shutdown disable reconnect, cancel timers, drain/cancel jobs, await end/auth/log flush; đồng nhất graceful exit path.
5. Hạn chế startup migration toàn archive; chuyển migration sang thao tác có kiểm soát/streaming, storage failure propagation và archive retention theo nhu cầu.

### P2 - hardening

1. Group cache TTL/size/invalidation, dedup TTL/hard cap và đánh dấu success rõ ràng; đánh giá auth store/mutex retention, cross-process ownership.
2. Kiểm chứng bằng outage→restore, terminal auth/QR, duplicate-start prevention, stalled/oversized media, disk write failure, shutdown khi retry/media active; soak test có workload và memory trend nhiều ngày.
3. Alert readiness/auth requires-action/ingestion lag và vận hành Windows update/sleep có quy trình; phân biệt không có traffic với pipeline dead để tránh false alarms.

Kết quả audit chỉ tạo báo cáo này. Không thay source, session, archive, dependency, PM2 hoặc Windows settings.
