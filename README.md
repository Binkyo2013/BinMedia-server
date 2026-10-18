# Bin Media Server

Backend cho ứng dụng di động **Bin Media** (phim + tin tức). Chạy trên Node.js thuần
(không framework), lưu trữ bền vững bằng **PostgreSQL** (hoặc file JSON / file trên
repo git cho môi trường phát triển).

> Phiên bản này thay thế mô hình JVHD device-binding cũ (ECDSA challenge/response,
> OneDrive) bằng mô hình tài khoản **Free / VIP + session** theo đặc tả Bin Media.

## 1. Phân vai

| Thành phần | Trách nhiệm |
|---|---|
| **Ứng dụng di động** | Giao diện, điều hướng Phim/Tin tức, tìm kiếm/lọc, trình phát video, lưu trạng thái UI + lịch sử xem (chỉ khi người dùng đồng ý), đăng ký Free / đăng nhập VIP / kiểm tra session, hiển thị lỗi theo `error.code`. **Không** chứa GitLab token, **không** tự quyết định quyền VIP. |
| **Backend (repo này)** | API, tài khoản + thiết bị, thời hạn Free, kiểm tra VIP (danh sách trên GitLab), tạo/thu hồi session, chống đăng ký Free trùng thiết bị, giới hạn đăng nhập sai, metadata video + cache, log/giám sát. |
| **CSDL** | PostgreSQL (bảng: tài khoản, thiết bị Free, session + thu hồi, bộ đếm đăng nhập sai + khóa, metadata phim/tập/danh mục, trạng thái liên kết, lịch sử xem). Xem `schema.sql`. |
| **Module nguồn Facebook** | `sources/facebook.js` — tách riêng: chỉ nội dung được phép, chuẩn hóa, xác minh truy cập, URL nhúng hợp lệ, lỗi nhất quán. |

**Backend là nguồn sự thật duy nhất** về thời hạn Free và trạng thái VIP. Mọi mốc
thời gian tính bằng đồng hồ server — sửa dữ liệu cục bộ, đổi giờ điện thoại hay sửa
APK đều không thay đổi được quyền.

## 2. Chạy thử nhanh (không cần CSDL)

```bash
node server.js
# hoặc cấu hình đầy đủ:
PORT=8787 \
STORE_DRIVER=json \
VIP_SOURCE=static \
VIP_LIST_STATIC='["ten_vip_1","ten_vip_2"]' \
ADMIN_TOKEN=mat-khau-admin \
node server.js
```

Chạy test:

```bash
npm ci
npm test        # unit + e2e; PostgreSQL integration skipped unless configured
```

## 3. Biến môi trường

### Chung
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Cổng nghe |
| `ADMIN_TOKEN` | *(rỗng)* | Token API admin (Bearer). Rỗng → API admin tắt. **Không** truyền token qua query string. |
| `MAX_BODY` | `65536` | Giới hạn body request |
| `CORS_ORIGIN` | `*` | Origin cho CORS |
| `TRUST_PROXY` | `1` | Tin `X-Forwarded-For` (đặt `0` nếu không đứng sau proxy) |

### Lưu trữ (`STORE_DRIVER`)
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `STORE_DRIVER` | `json` | `postgres` (khuyến nghị trên Render) \| `json` \| `git` |
| `DATA_FILE` | `data/bimedia.json` | File dữ liệu khi dùng driver `json` |
| `DATABASE_URL` | | Chuỗi kết nối PostgreSQL |
| `DATABASE_SSL` | `1` | SSL tới Postgres (`0` để tắt) |
| `STORE_AUTO_MIGRATE` | `1` | Tự chạy `schema.sql` khi khởi động |
| `STORE_GIT_PROVIDER` | `github` | `github` \| `gitlab` (driver `git`) |
| `STORE_GIT_TOKEN` / `STORE_GIT_OWNER` / `STORE_GIT_REPO` / `STORE_GIT_PATH` / `STORE_GIT_BRANCH` | | Cấu hình file JSON trên repo git riêng (driver `git`) |

> **Lưu ý Render:** ổ đĩa là tạm thời — dùng `postgres` (hoặc driver `git`) để dữ
> liệu (đặc biệt là **khóa đăng nhập**) sống qua restart/redeploy.

### Danh sách VIP (quản lý trên GitLab)
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `VIP_SOURCE` | tự nhận | `gitlab` \| `static` \| `file` |
| `GITLAB_API_URL` | `https://gitlab.com/api/v4` | API GitLab |
| `GITLAB_PROJECT_ID` | | ID số hoặc path THÔ của project (vd. group/project); code tự URL-encode |
| `GITLAB_VIP_PATH` | `vip.txt` | Đường dẫn file danh sách (JSON array hoặc mỗi tên một dòng) |
| `GITLAB_VIP_REF` | `main` | Nhánh |
| `GITLAB_TOKEN` | | **Chỉ tồn tại ở server** — app không bao giờ giữ token này |
| `VIP_LIST_STATIC` / `VIP_LIST_FILE` | | Cho dev/test |
| `VIP_LIST_TTL_MS` | `60000` | TTL cache danh sách |
| `VIP_STALE_MAX_MS` | *(deprecated)* | Không còn dùng để cấp quyền; dữ liệu quá TTL luôn bị từ chối nếu tải lại lỗi |
| `VIP_SESSION_TTL_MS` | `2592000000` | Session VIP hết hạn sau 30 ngày; số nguyên dương, đơn vị ms |

### Tài khoản Free / khóa VIP
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `FREE_DURATION_HOURS` | `48` | Thời hạn Free, tính từ lúc server ghi nhận đăng ký |
| `VIP_FAIL_LIMIT` | `5` | Số lần nhập tên VIP sai **liên tiếp** trước khi khóa |
| `VIP_LOCK_SECONDS` | `300` | Thời gian khóa (5 phút) |

### Lịch sử xem & nguồn
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `HISTORY_ENABLED` | `1` | Bật/tắt lịch sử xem |
| `HISTORY_NOTICE` | *(thông báo mặc định)* | Văn bản thông báo người dùng |
| `FACEBOOK_VERIFY_ONLINE` | `0` | Bật kiểm tra truy cập online (xem mục 6 trước khi bật) |
| `SOURCE_CACHE_TTL_MS` | `600000` | Cache kết quả resolve nguồn (10 phút) |

## 4. Đặc tả tài khoản — cách server thực thi

### Free — 48 giờ
- Người dùng tự chọn **tên tài khoản** khi mở app lần đầu, không email/mật khẩu.
- `POST /api/auth/register-free` với `{ name, deviceId }`:
  - `deviceId` là mã **ngẫu nhiên do app sinh** (≥16 ký tự, không phải IMEI/serial).
  - **1 thiết bị = 1 tài khoản Free**: ràng buộc `UNIQUE(device_id)` + transaction
    → đăng ký trùng khi chạy đồng thời chỉ có 1 request thành công
    (`409 DEVICE_REGISTERED`).
  - `freeExpiresAt = now + 48h` — **server** ghi nhận, không nhận giá trị từ client.
- `POST /api/auth/restore` `{ deviceId }`: thiết bị đã đăng ký lấy lại session khi
  còn hạn; hết hạn → `403 FREE_EXPIRED` (app chuyển sang luồng VIP).

### VIP — quyền theo GitLab, ràng buộc một thiết bị
- `POST /api/auth/login-vip` yêu cầu `{ name, deviceId }` (Device ID bắt buộc).
- Tên được chuẩn hóa NFC, trim/gộp khoảng trắng, không phân biệt hoa/thường.
- Backend kiểm tra danh sách GitLab rồi tạo/kiểm tra liên kết trong PostgreSQL:
  tài khoản chưa có liên kết → ghi nhận; cùng thiết bị → cho phép;
  khác thiết bị → `403 VIP_DEVICE_MISMATCH`, không ghi đè liên kết.
- `vip_device_bindings.account_id` là PRIMARY KEY; `device_id` không UNIQUE.
  Một thiết bị được dùng nhiều VIP, đồng thời giữ nguyên liên kết Free cũ.
  Tạo tài khoản và claim liên kết dùng transaction + khóa hàng, không chỉ kiểm tra RAM.
- Đăng xuất/thu hồi session/xóa tên khỏi GitLab không tự gỡ liên kết thiết bị.
  **Chưa có API chuyển thiết bị**; không tự ý sửa liên kết để né lỗi.
- Mỗi yêu cầu dùng session VIP phải gửi **cả** Bearer token và `X-Device-ID`.
  Backend đối chiếu session → tài khoản → liên kết thiết bị → danh sách VIP hiện tại.
- Session hết hạn sau 30 ngày mặc định, không phải quyền VIP hết hạn sau 30 ngày.
- Cache VIP có TTL thật (mặc định 60s), refresh theo yêu cầu, single-flight trong
  mỗi tiến trình. Hết TTL, yêu cầu chờ tải lại; lỗi → `503 VIP_SOURCE_UNAVAILABLE`,
  **không xác thực bằng stale cache**. Retry có tiết lưu tối đa 5s khi nguồn lỗi.
  Không có timer nền khi không có yêu cầu; `/health` báo trạng thái cache, không tải lại.
- Danh sách rỗng hợp lệ thu hồi toàn bộ VIP, không cấp quyền cho ai. Nội dung lỗi
  không được coi là danh sách hợp lệ. JSON phải là mảng toàn chuỗi tên hợp lệ;
  định dạng mỗi tên một dòng vẫn hỗ trợ.
- Gỡ VIP khỏi GitLab ảnh hưởng session cũ chậm nhất khi cache hết TTL và yêu cầu
  xác thực tiếp theo chạy; nguồn lỗi sau TTL cũng bị từ chối. Binding vẫn được giữ.
- Free được đưa vào danh sách VIP vẫn nâng quyền theo luồng cũ; giữ bản ghi thiết bị
  Free và mốc expiry cũ để bảo toàn dữ liệu. Session Free cũ không thành session VIP;
  `/api/auth/restore` không cấp session VIP chỉ từ Device ID.

### Khóa VIP — 5 lần sai → 5 phút
- 5 lần nhập tên VIP sai **liên tiếp** (thành công sẽ reset bộ đếm) → khóa đăng nhập
  300 giây, phản hồi `429 AUTH_LOCKED` kèm `retryAfterSec`.
- Bộ đếm + thời gian khóa lưu **trong CSDL** — đóng app, xóa dữ liệu app hay
  **khởi động lại server** đều không xóa được khóa.
- Trong thời gian khóa: kể cả tên đúng cũng **không cấp quyền mới**.
- Sau 300 giây → cho phép thử lại theo chính sách.
- Kết hợp giới hạn tần suất theo **IP** (30 lần/10 phút), theo **thiết bị** và theo
  **tên** (cùng đếm vào khóa).
- Lỗi **không bao giờ** trả về danh sách tên VIP hợp lệ.

### Session
- Token sinh ngẫu nhiên (32 byte), chỉ lưu **SHA-256** trong CSDL, trả về app đúng
  một lần. Hết hạn / bị thu hồi (`revokedAt`) → `401` và phải xác thực trực tuyến lại.
- Admin thu hồi: `DELETE /api/admin/sessions/:id`, `POST /api/admin/accounts/:id/revoke`.

### Mã lỗi (map ra thông báo trong app)
| `error.code` | HTTP | Ý nghĩa |
|---|---|---|
| `NAME_INVALID` / `DEVICE_INVALID` / `BAD_REQUEST` | 400 | Dữ liệu không hợp lệ |
| `SESSION_REQUIRED` / `SESSION_INVALID` / `SESSION_EXPIRED` / `SESSION_REVOKED` | 401 | Session — xác thực lại |
| `VIP_INVALID` | 401 | Tên VIP sai (không hé lộ danh sách) |
| `FREE_EXPIRED` | 403 | Free hết 48 giờ |
| `VIP_INACTIVE` | 403 | Quyền VIP không còn hiệu lực |
| `VIP_DEVICE_MISMATCH` | 403 | Tài khoản/session VIP liên kết với thiết bị khác; không tự chuyển |
| `ADMIN_FORBIDDEN` | 403 | Sai admin token |
| `HISTORY_CONSENT_REQUIRED` / `HISTORY_DISABLED` | 403 | Lịch sử xem cần đồng ý / đang tắt |
| `NO_ACCOUNT` / `NOT_FOUND` | 404 | Không tìm thấy |
| `DEVICE_REGISTERED` / `NAME_TAKEN` | 409 | Trùng thiết bị / tên đã dùng |
| `AUTH_LOCKED` | 429 | Đã khóa sau 5 lần sai — chờ `retryAfterSec` |
| `RATE_LIMITED` | 429 | Vượt giới hạn tần suất |
| `SOURCE_UNAVAILABLE` / `SOURCE_UNKNOWN` | 502 | Nguồn phát không khả dụng |
| `VIP_SOURCE_UNAVAILABLE` / `SERVICE_UNAVAILABLE` | 503 | Không xác minh được quyền — không cấp quyền mới |
| `INTERNAL` | 500 | Lỗi hệ thống |

## 5. API

API người dùng được bảo vệ yêu cầu `Authorization: Bearer <session token>`.
Session VIP còn yêu cầu `X-Device-ID: <deviceId>`. API admin dùng token admin riêng.

| Method | Path | Mô tả |
|---|---|---|
| GET | `/health` | Giám sát: store, danh sách VIP, thời gian server |
| POST | `/api/auth/register-free` | Đăng ký Free `{name, deviceId}` → token + account |
| POST | `/api/auth/restore` | Khôi phục session theo `deviceId` |
| POST | `/api/auth/login-vip` | Đăng nhập VIP `{name, deviceId}` |
| GET | `/api/me` | Kiểm tra session + trạng thái tài khoản (kèm `serverTime`) |
| POST | `/api/auth/logout` | Thu hồi session hiện tại |
| GET/POST/DELETE | `/api/history` | Lịch sử xem (POST cần đã đồng ý) |
| POST | `/api/history/consent` | Đồng ý/từ chối lưu lịch sử `{accepted}` |
| GET | `/api/catalog/categories` | Danh mục phim |
| GET | `/api/catalog/movies?q=&category=&page=&pageSize=&sort=` | Tìm kiếm + lọc |
| GET | `/api/catalog/movies/:id` | Chi tiết phim + `linkStatus` |
| GET | `/api/catalog/movies/:id/episodes` | Danh sách tập |
| GET | `/api/catalog/episodes/:id/play` | URL phát + URL nhúng từ module nguồn |
| POST | `/api/admin/catalog/import` | Import metadata hàng loạt (chuẩn hóa + kiểm tra ref) |
| POST | `/api/admin/categories` · `/api/admin/movies` · `/api/admin/movies/:id/episodes` | Upsert metadata |
| POST | `/api/admin/episodes/:id/link` | Liên kết tập với nguồn Facebook |
| POST | `/api/admin/source/refresh` | Xác minh trạng thái truy cập nguồn |
| GET | `/api/admin/status` · `/api/admin/accounts` · `/api/admin/sessions` | Giám sát, quản lý |
| DELETE | `/api/admin/sessions/:id` · POST `/api/admin/accounts/:id/revoke` | Thu hồi session / tài khoản |

**Trạng thái liên kết phim–video** (`linkStatus`): `linked` (đã liên kết nguồn hợp lệ)
/ `unlinked` / `broken` (nguồn hỏng) / `partial` (một số tập hỏng) — cập nhật tự
động khi import, link hoặc xác minh nguồn.

## 6. Module nguồn Facebook — phạm vi & cam kết

Xem header `sources/facebook.js`. Tóm tắt:

- **Chỉ** xử lý URL video Facebook **công khai** do admin chủ động liên kết
  (`facebook.com/.../videos/...`, `watch?v=...`, `fb.watch/...` — whitelist regex).
- Trả **URL nhúng chính thức** (`facebook.com/plugins/video.php`) để phát trong
  webview + URL xem gốc. Không tải lại, không phân phối lại nội dung.
- Xác minh truy cập = kiểm tra URL công khai (không cookie/phiên đăng nhập); redirect
  tới trang đăng nhập → `SOURCE_UNAVAILABLE`. **Không** vượt login wall.
- Lỗi nguồn luôn có dạng `{ code: "SOURCE_UNAVAILABLE", sourceCode: ... }`.
- **Không** vượt xác thực, không lấy nội dung riêng tư, không né giới hạn truy cập,
  không giả mạo người dùng Facebook.
- **Trước khi phát triển thật:** chốt API chính thức (Graph API, quyền
  `public_video`...), rà điều khoản nền tảng Facebook, khả năng phát video trong app.

## 7. Triển khai trên Render

1. Tạo **PostgreSQL** trên Render → lấy `DATABASE_URL`.
2. Tạo **Web Service** từ repo này:
   - Build: `npm install` · Start: `node server.js`
   - Env: `STORE_DRIVER=postgres`, `DATABASE_URL=...`, `ADMIN_TOKEN=...`,
     `VIP_SOURCE=gitlab`, `GITLAB_PROJECT_ID=...`, `GITLAB_VIP_PATH=Member_BinMedia.txt`,
     `GITLAB_TOKEN=...` (chỉ ở server).
3. `schema.sql` tự chạy khi khởi động (`STORE_AUTO_MIGRATE=1`).
4. Health Check Path: `/health` (đường dẫn `/` không phải endpoint kiểm tra).
5. File VIP trên GitLab: JSON array `["tên một","tên hai"]` hoặc mỗi tên một dòng.

## 8. Cấu trúc mã

```
server.js            — HTTP API, routing, auth/session, khóa VIP, admin, giám sát
lib/authcore.js      — tên/token/hash, cổng khóa & tần suất, mã lỗi
lib/store.js         — lưu trữ: postgres | json | git (đăng ký Free nguyên tử)
sources/index.js     — registry module nguồn
sources/facebook.js  — module nguồn Facebook (tách riêng, có cam kết phạm vi)
schema.sql           — PostgreSQL schema
test/                — unit + e2e (node --test)
```

## 9. Giới hạn bảo mật đã chấp nhận (đặc tả)

Chỉ xác thực bằng **tên VIP** không chứng minh được người nhập là chủ tài khoản —
bất kỳ ai biết tên VIP đều có thể thử. Đặc tả hiện tại tuân theo lựa chọn này;
có thể nâng cấp sau (mật khẩu một lần, mã mời, xác thực thiết bị...). Các biện pháp
bù đắp hiện có: khóa 5 phút + giới hạn tần suất theo IP/thiết bị/tên, session thu
hồi được, không hé lộ danh sách VIP.

## 10. Tích hợp app: mở lại, cài lại và giới hạn định danh

Repo này **không có mã app BinMedia**. Backend chỉ nhận chuỗi `deviceId` do app gửi;
không thể xác minh cách app tạo/lưu/khôi phục định danh, cũng không chứng thực phần cứng.

1. App tạo ID ngẫu nhiên đủ mạnh (UUID/ít nhất 128 bit ngẫu nhiên), chuỗi 16–128 ký tự
   `[A-Za-z0-9_-]`; không dùng IMEI, serial hoặc fingerprint ngầm. Ví dụ ID ngắn
   `device-id-01` KHÔNG hợp lệ theo validator hiện có.
2. Đăng nhập: gửi `{name, deviceId}` qua HTTPS. Không chứa token GitLab trong app.
3. Lưu session token trong kho bí mật của hệ điều hành (Keychain hoặc dữ liệu mã hóa
   bằng khóa Android Keystore), không SharedPreferences/AsyncStorage/plaintext file,
   không log token. Không dùng tên + Device ID thay cho token để tự động vào app.
4. Mở lại: gọi `GET /api/me` với Bearer token + `X-Device-ID`; chỉ vào giao diện chính
   sau phản hồi thành công. Không lấy trạng thái UI lưu cục bộ làm bằng chứng quyền.
5. `401`: session không hợp lệ/hết hạn/thu hồi → bỏ token và yêu cầu đăng nhập lại.
   `403 VIP_INACTIVE`: dừng quyền VIP; `403 VIP_DEVICE_MISMATCH`: không đổi ID hoặc tự
   chuyển liên kết. `400 DEVICE_INVALID`: kiểm tra tích hợp header/ID.
   `503` hoặc lỗi DB/mạng: báo tạm không xác minh được, không tự cấp quyền/offline;
   có thể giữ token an toàn để thử lại sau, không cần xóa session vì lỗi tạm thời.
6. Gỡ app có thể mất token và ID. Không cam kết Keychain/Keystore/backup hệ điều hành
   chắc chắn sống qua uninstall. Nếu app khôi phục đúng ID, người dùng đăng nhập lại
   cùng VIP (hoặc VIP khác chưa liên kết) được; nếu ID thay đổi, VIP đã liên kết sẽ
   bị từ chối. Không tìm tài khoản chỉ từ ID rồi cấp token VIP.
7. Khôi phục ID qua tài khoản chủ sở hữu đã xác minh hoặc quy trình chuyển thiết bị
   do admin duyệt là phương án tương lai cần thiết kế riêng, có đồng ý/quyền riêng tư;
   chưa triển khai trong PR này. Test backend chỉ mô phỏng gửi lại ID cũ/mới, không
   phải kiểm thử uninstall/reinstall trên Android/iOS thật.

**Giới hạn bảo mật còn tồn tại:** tên VIP không phải bí mật xác thực. Người biết tên
có thể claim tài khoản chưa liên kết trước chủ thật. ID do client khai báo có thể
bị sao chép; token + ID bị đánh cắp vẫn có thể bị dùng lại. Ràng buộc này không thay
thế mật khẩu/mã mời dùng một lần/chứng minh khóa thiết bị hoặc attestation. Cần cơ chế
xác minh chủ sở hữu trước khi coi đây là chống giả mạo thiết bị hoàn chỉnh.

## 11. Migration và triển khai an toàn

- Chỉ thêm bảng `vip_device_bindings` và cột nullable `sessions.device_id` bằng
  `IF NOT EXISTS`. Không xóa bảng, reset DB, backfill từ `last_device_id`, hoặc thay
  UNIQUE của dữ liệu Free. Dữ liệu Free và session cũ được giữ nguyên.
- VIP cũ chưa có binding được claim trong lần đăng nhập thành công đầu tiên sau
  nâng cấp. `last_device_id` cũ không chứng minh quyền sở hữu. Nếu không chấp nhận
  rủi ro first-claim, **chưa deploy**: cần xác minh chủ sở hữu và lập kế hoạch liên kết
  tài khoản cũ có kiểm soát trước. PR này không tự chuyển dữ liệu sở hữu.
- Session VIP cũ chưa có `device_id` bị từ chối, phải đăng nhập lại; không tự nâng
  session Free thành VIP. App cũ không gửi header sẽ không dùng được API VIP mới.
  Cần cập nhật app phối hợp trước khi rollout backend.
- Trước production: tạo backup/snapshot PostgreSQL, xác nhận khôi phục được, chạy
  migration trên staging với bản sao dữ liệu đã bảo vệ. DDL có thể lấy khóa ngắn;
  triển khai trong khung giờ phù hợp, tránh nhiều phiên bản backend cũ/mới cùng ghi.
- Với auto-migrate bật, schema chạy khi server khởi động; nếu tắt, người vận hành
  chạy `schema.sql` trong transaction qua công cụ PostgreSQL trước khi chạy code mới.
  Không dán URL DB vào chat/log/lệnh lưu trong repository.
- Giữ env Render hiện có `STORE_DRIVER=postgres`, Internal `DATABASE_URL`, nguồn VIP
  `VIP_SOURCE=gitlab` + project/path/ref riêng, token chỉ trong env secret nếu cần.
  Không cần biến mới bắt buộc. Có thể cấu hình `VIP_SESSION_TTL_MS` (mặc định 30 ngày),
  `VIP_LIST_TTL_MS` (mặc định 60s); `VIP_STALE_MAX_MS` không còn cho phép stale auth.
- Sau deploy kiểm tra health + đăng nhập bằng dữ liệu staging/được phép, khởi động
  lại rồi kiểm tra liên kết/session. GET health không chứng minh các luồng ghi đúng.
- Rollback không cần xóa cấu trúc mới, nhưng code cũ không thực thi binding: rollback
  backend là giảm bảo mật, cần kiểm soát truy cập, không coi là biện pháp tự động an toàn.

## 12. Kiểm thử PostgreSQL cục bộ

`npm test` chạy unit/e2e, suite PostgreSQL sẽ skip nếu thiếu
`BINMEDIA_TEST_DATABASE_URL`. Để chạy đầy đủ, cấp biến này qua môi trường test an toàn
trỏ tới PostgreSQL **cục bộ dùng riêng cho test**, rồi chạy `npm test`.
Suite từ chối host không phải localhost; tạo/xóa duy nhất schema ngẫu nhiên của nó.
Không dùng database production hoặc credentials thật trong test/commit.

Suite kiểm tra migration lặp lại và giữ dữ liệu cũ, cạnh tranh claim từ nhiều kết nối,
rollback khi constraint lỗi, nhiều VIP/cùng thiết bị, session hash + device, quyền VIP
bị thu hồi, mất kết nối DB fail-closed. E2E kiểm tra Free 48h, khóa 5 lần/300s,
restart/session tự xác thực, ID khôi phục/mất sau cài lại (mô phỏng), TTL + nguồn lỗi
phục hồi, single-flight, parser/API GitLab bằng mock (không dùng dữ liệu VIP thật).
