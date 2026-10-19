# Windows deployment script

## Files changed

- `deploy.cmd`: entry point tại root, tự `cd /d "%~dp0"`, mặc định pause cuối lần chạy; hỗ trợ `--no-pause`.
- `scripts/deploy-helper.ps1`: đọc JSON PM2, kiểm tra online, lọc output và quản lý metadata/cleanup deploy lock.
- `tests/deploy.test.js`: kiểm thử bằng Node/npm/PM2 giả trong project tạm, kể cả đường dẫn có khoảng trắng, `&`, `!`.
- `.gitignore`: bỏ qua `deploy-logs/` và `.deploy.lock/`.
- `.gitattributes`: giữ `deploy.cmd` ở dạng CRLF để CMD xử lý labels/pipeline đúng.

Task này không sửa source bot, dependencies hoặc `ecosystem.config.cjs`. Những thay đổi stability trước đó được giữ nguyên.

## Deploy flow

1. Tạo `.deploy.lock` bằng mkdir atomic; tạo log riêng có timestamp, milliseconds và token để tránh trùng tên.
2. Kiểm tra PowerShell/helper, Node/npm/PM2 trong PATH, ba file project và `node_modules`; in versions; kiểm tra syntax config bằng `node --check`.
3. `call npm test`. Chỉ khi pass mới kiểm tra app production.
4. Chạy `pm2 describe whatsappbot` và đọc `pm2 jlist`. Không có app thì fresh deployment; có một app thì stop rồi delete đúng `whatsappbot`. Lỗi inspect/stop/delete sẽ abort.
5. `call pm2 start ecosystem.config.cjs`, rồi describe và verify bằng jlist.
6. Trong cửa sổ tối đa 30 giây, yêu cầu ba mẫu online liên tiếp cách nhau một giây, PID dương và PID/restart count không đổi. Exit 78 hoặc stopped/errored/stopping khiến verify fail ngay.
7. Chỉ sau verify mới `pm2 save`. Sau đó chạy status, describe và logs `--lines 100 --nostream`; in kết quả và hướng dẫn; cleanup own deploy lock; pause nếu cần.

## Safety protections

- Tests/preflight fail: không gọi stop/delete/start production.
- Không `pm2 kill`, git pull/reset/checkout/clean, npm install/ci, logout, scan QR hoặc thao tác session/auth/archive/log của bot.
- Không xóa `bot.lock`. Cleanup chỉ gỡ owner metadata có token của lần deploy này và xóa thư mục deploy lock rỗng, không recursive delete.
- Lock có sẵn luôn abort và giữ nguyên; metadata cho biết PID owner còn sống hay không, nếu đọc được.
- Không lưu raw PM2 jlist/describe/status hoặc raw test/log output, vì có thể chứa env, credentials, QR và nội dung tin nhắn. Console và deploy log chỉ nhận versions, test totals, exit codes, trạng thái PM2 cùng các indicator/metrics trong whitelist. Các command status/describe vẫn chạy, nhưng output được thay bằng summary PM2 an toàn.
- Exit code của command được truyền bằng marker riêng qua pipeline; sanitizer thành công không che lỗi npm/PM2.
- `AUTH_REQUIRED`, `AUTH_REQUIRES_ACTION`, `QR_REQUIRED`, `CONFLICT` chỉ sinh hướng dẫn kiểm tra session owner; không tạo restart loop hay xóa session.

Kiểm chứng trên Windows: `npm test` **47/47 pass**, gồm 12 tests deploy với executables giả: tests fail, fresh/online deploy, start/save/stop/delete/inspect lỗi, exit 78, start thành công nhưng process errored, lock có sẵn và thiếu dependencies. Tests kiểm tra thứ tự lệnh, exit codes, cleanup lock, không restart thêm khi log có auth/conflict và không rò dữ liệu nhạy cảm giả. PowerShell parser và kiểm tra ASCII/CRLF của batch đều pass. Không thực thi deploy lên production thật.

## Failure behaviour

| Tình huống | Kết quả |
| --- | --- |
| Thiếu command/file/dependencies; tests fail | Code 2, `DEPLOY ABORTED`, bot cũ không bị stop |
| Deploy lock đã tồn tại | Code 2, không chạy deploy và không gỡ lock của lần khác |
| Inspect/stop/delete/start/verify lỗi | Code 1, `DEPLOY FAILED`, diagnostics và hướng dẫn operator |
| Start trả thành công nhưng process errored/không online | Code 1, không gọi save |
| App exit 78 | Code 1, cảnh báo ownership; không restart thủ công hoặc xóa bot.lock |
| Save lỗi sau verify | Warning, code 0; process đã được xác nhận đang chạy |
| Cleanup own lock không thành công | Code 1, cảnh báo kiểm tra lock; không cưỡng chế xóa |

## How to use

Đảm bảo Node.js, npm, PM2 có trong PATH và dependencies đã được chuẩn bị. Giữ `scripts/deploy-helper.ps1` cùng project khi di chuyển thư mục. Chạy dưới Windows account/PM2_HOME đang quản lý production bot.

Double-click `deploy.cmd`, hoặc trong CMD tại project:

```bat
deploy.cmd
```

Không pause, phù hợp terminal/automation:

```bat
deploy.cmd --no-pause
```

Trong PowerShell dùng `./deploy.cmd` hoặc `./deploy.cmd --no-pause`. Mỗi lần chạy đã lấy được lock tạo log trong `deploy-logs`. Dependencies thiếu thì script chỉ hướng dẫn tự chạy npm install, không tự cài.

## Example output

```text
[1/7] Pre-flight checks
[2/7] Running tests
TESTS PASSED
Proceeding with deployment...
[3/7] Inspecting current PM2 process
PM2: name=whatsappbot status=online pid=12345 id=0 restarts=0
[4/7] Stopping old process
[5/7] Starting new version
[6/7] Verifying deployment
Verified whatsappbot online with a stable PID/restart count.
[7/7] Saving PM2 state
DEPLOY COMPLETED SUCCESSFULLY
Expected healthy indicators: connection-open, connection-stable, READY.
Action required indicators: CONFLICT, AUTH_REQUIRES_ACTION, QR_REQUIRED, AUTH_REQUIRED.
Do not repeatedly restart the bot. Inspect WhatsApp session/auth ownership first.
Deploy lock released.
```

## Known limitations

- PM2 online xác nhận process đang chạy trong khoảng kiểm tra, không bảo đảm WhatsApp READY hay độ ổn định dài hạn. Indicator auth/conflict có thể xuất phát từ log lịch sử trong 100 dòng cuối; cần đối chiếu tình trạng hiện tại.
- Không rollback tự động. Nếu lỗi sau khi stop/delete, bot cũ có thể đã dừng và operator cần xử lý.
- Cleanup thực hiện ở mọi đường kết thúc do script xử lý. Ctrl+C, kill terminal, mất điện hoặc lỗi quyền/filesystem có thể để lại `.deploy.lock`. Kiểm tra owner và bảo đảm không có deploy đang chạy trước khi tự xử lý lock deploy còn sót; không đụng `bot.lock`.
- Không cấu hình PM2 tự khởi động cùng Windows. Save chỉ lưu process list của PM2 đang sử dụng.
- Cần Windows PowerShell và quyền chạy helper với `-ExecutionPolicy Bypass`; policy doanh nghiệp vẫn có thể chặn.
- Log cố ý lọc chặt; khi command lỗi, operator có thể cần chạy command tương ứng riêng để xem chi tiết tại máy. Script không tự xóa/rotate deploy logs.
- Kiểm thử task này dùng fake executables, không deploy, stop/delete/start production thật.
