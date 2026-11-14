# SafeSchool AI — Lá chắn Số Học đường

Nền tảng web Full-Stack hỗ trợ **phát hiện sớm bắt nạt trực tuyến**, **sơ cứu tâm lý tức thì**, **cẩm nang kỹ năng số** và **cổng kết nối tư vấn học đường ẩn danh 2 chiều** dành cho học sinh THPT — triển khai thực tế cho **Trường THPT Tôn Đức Thắng, xã Tà Lài, tỉnh Đồng Nai**.

---

## Nguyên tắc thiết kế cốt lõi

1. **Zero Mock Data (Không dữ liệu giả):**
   - Cơ sở dữ liệu SQLite (`better-sqlite3`) khởi tạo ở trạng thái sạch 100%, tuyệt đối không có tin nhắn mẫu, báo cáo đóng cứng hay dữ liệu giả.
   - Bảng điều khiển Tổ Tư vấn và biểu đồ thống kê (`Chart.js`) luôn hiển thị trạng thái chờ dữ liệu thực cho đến khi phát sinh hồ sơ gửi từ người dùng.
2. **Zero-Identity (Bảo mật danh tính tuyệt đối):**
   - Không yêu cầu hoặc lưu trữ họ tên, email, số điện thoại hay địa chỉ IP của học sinh.
   - Học sinh chỉ chọn Khối lớp (`10` / `11` / `12` / `Ẩn danh hoàn toàn`), nhận mã hồ sơ duy nhất định dạng `SH-XXXXXX` để tra cứu tiến độ và nhắn tin ẩn danh 2 chiều với Tổ Tư vấn Tâm lý.
3. **Tích hợp Google Gemini AI thật (Multimodal + Structured JSON Output, Server-Side Only):**
   - Sử dụng SDK chính thức `@google/genai` (`>= 3.3.0`) qua **Interactions API** (`ai.interactions.create`).
   - Hỗ trợ phân tích đồng thời **văn bản** và **ảnh chụp màn hình** (chọn file, kéo-thả hoặc dán trực tiếp `Ctrl+V`), trả về JSON tuân thủ nghiêm ngặt `response_format` JSON Schema (`risk_level`, `category`, `confidence_score`, `detected_signals`, `psychological_first_aid`, `actionable_steps`).
   - **Bảo mật API Key 100% phía Backend:** Toàn bộ kết nối tới Google AI Studio API được xử lý độc quyền ở máy chủ Express thông qua biến môi trường `GEMINI_API_KEY` trong tệp `.env` (hoặc Environment Variables trên Render). Giao diện người dùng không hiển thị nút cài đặt hay ô nhập API Key và server bỏ qua mọi header ghi đè từ client.
   - **Lưu ý về phiên bản model:** Theo tài liệu chính thức mới nhất của Google Gemini API, model `gemini-3.5-flash` và tham số `temperature` đã chuyển sang trạng thái deprecated trên thế hệ Gemini mới. Hệ thống mặc định sử dụng **`gemini-3.8-flash`** (thay thế trực tiếp) kết hợp `system_instruction`, JSON Schema `response_format` và `generation_config: { thinking_level: 'low' }` để đảm bảo độ ổn định khi phân loại. Bạn vẫn có thể thay đổi model qua biến môi trường `GEMINI_MODEL`.
4. **Hệ thống Giao diện Sáng / Tối (Tailwind CSS Light & Dark Mode) & Interactive Spotlight Onboarding Tour:**
   - Biên dịch tĩnh Tailwind CSS (`darkMode: 'class'` trong `tailwind.config.js` → `public/tailwind.css`) kết hợp hệ thống biến CSS cho **Light Mode** (`#F8FAFC` / `#FFFFFF` / `#0F172A` / `#0F766E` / `#0284C7`) và **Dark Mode** (`#0B1120` / `#1E293B` / `#334155` / `#F1F5F9` / `#2DD4BF` / `#38BDF8`). Nút chuyển nhanh Mặt trời / Mặt trăng trên Header lưu lựa chọn vào `localStorage` (`safeschool_theme`) và tự động đồng bộ giao diện hệ thống nếu người dùng chưa chọn.
   - **Interactive Spotlight Guide Engine** bằng JavaScript + CSS thuần gồm **5 bước**: tự động khởi chạy ở lần truy cập đầu tiên (`localStorage`: `safeschool_tour_done`), kèm nút **"Bỏ qua hướng dẫn"** và nút **"Hướng dẫn sử dụng"** luôn nổi bật trên Header. Khi chạy, tour làm tối/mờ nền xung quanh, khoét sáng vùng thao tác với viền phát sáng `#2DD4BF` và hiển thị thẻ hướng dẫn kèm ví dụ minh họa không chèn vào ô nhập liệu thật.

---

## Kiến trúc & Cấu trúc thư mục

Ứng dụng chạy trên **một cổng duy nhất (Single-Port Express Server)** phục vụ đồng thời REST API, static assets (`public/tailwind.css`, `Chart.js` và `Lucide Icons` từ `node_modules`) và giao diện frontend Mobile-First, sẵn sàng deploy lên Render như một Web Service độc lập.

```text
safeschool-ai/
├── package.json            # Dependencies (@google/genai, express, better-sqlite3, chart.js, lucide, zod, dotenv) & Tailwind CSS
├── tailwind.config.js      # Cấu hình Tailwind CSS với darkMode: 'class'
├── src/
│   └── tailwind-input.css  # Nguồn CSS đầu vào để build tĩnh ra public/tailwind.css
├── start-safeschool.bat    # Script khởi chạy nhanh 1 chạm trên Windows (tự cài đặt, tạo .env, mở trình duyệt)
├── .env.example            # Mẫu biến môi trường (PORT, GEMINI_API_KEY, GEMINI_MODEL, ADMIN_PIN, DB_PATH)
├── .gitignore              # Loại trừ node_modules, .env, file database *.db
├── server.js               # Express server + REST API + tích hợp Google GenAI (server-side only) + Auth mã PIN (HMAC Bearer)
├── database.js               # Khởi tạo schema SQLite sạch (bảng tickets, messages), WAL mode, truy vấn thống kê thực
├── public/
│   ├── index.html          # Giao diện Góc Học sinh, Spotlight Tour 5 bước & Góc Tổ Tư vấn
│   ├── tailwind.css        # CSS Tailwind đã biên dịch sẵn (npm run build:css)
│   ├── styles.css          # Biến màu Light/Dark Mode, Spotlight cutout & responsive mobile/desktop
│   └── app.js              # Theme toggle, Spotlight Tour Engine, upload/paste ảnh, API & Chart.js dữ liệu thật
└── tests/
    └── api.test.js         # Bộ kiểm thử tự động API, bảo mật server-side key, mã PIN, Triage và thống kê SQLite
```

---

## Cài đặt & Chạy Local (1 lệnh)

**Yêu cầu môi trường:** Node.js `>= 22.0.0`.

```bash
# 1. Cài đặt thư viện
npm install

# 2. Tạo file .env và điền GEMINI_API_KEY lấy từ Google AI Studio
cp .env.example .env

# 3. (Khi chỉnh sửa class Tailwind mới) Biên dịch lại Tailwind CSS
npm run build:css

# 4. Khởi chạy ứng dụng
npm start
```

> **Khởi chạy nhanh trên Windows:** Nhấp đúp chuột vào tệp `start-safeschool.bat` để tự động kiểm tra Node.js, cài đặt `node_modules` (nếu chưa có), tạo `.env` từ `.env.example`, khởi động máy chủ và tự mở trình duyệt. Hãy điền `GEMINI_API_KEY` vào tệp `.env` trước khi sử dụng tính năng AI.

Mặc định ứng dụng chạy tại `http://localhost:3000`.
- Lấy API Key tại [Google AI Studio](https://aistudio.google.com/apikey) và cấu hình `GEMINI_API_KEY=...` trong tệp `.env`.
- Khi truy cập **"Góc Tổ Tư vấn"** với cấu hình mặc định, mã PIN demo được hiển thị gợi ý là `11092026`.

### Chạy kiểm thử tự động

```bash
npm test
```

---

## Triển khai lên Render (1 Web Service duy nhất)

1. Đẩy mã nguồn lên GitHub (file `.env` và thư mục `data/` đã được `.gitignore` loại trừ).
2. Trên [Render](https://render.com), chọn **New + → Web Service** và kết nối tới repository.
3. Cấu hình thông số:
   - **Runtime:** `Node` (đã khai báo `"engines": { "node": ">=22.0.0" }` trong `package.json`)
   - **Build Command:** `npm install && npm run build:css`
   - **Start Command:** `npm start`
4. Thêm các **Environment Variables**:
   - `GEMINI_API_KEY`: API Key Google AI Studio của trường *(bắt buộc để chạy các tính năng AI)*
   - `GEMINI_MODEL`: `gemini-3.8-flash`
   - `ADMIN_PIN`: Mã PIN bí mật dành cho Tổ Tư vấn Tâm lý (thay cho `11092026`)
   - `SHOW_DEMO_PIN_HINT`: `false` (ẩn gợi ý mã PIN demo trên giao diện công khai)
   - `DB_PATH`: `/var/data/safeschool.db` (nếu gắn **Render Persistent Disk** mount tại `/var/data` để bảo toàn dữ liệu SQLite qua các lần restart/redeploy)
   - *(Lưu ý: Render tự động truyền biến `PORT`, server đã lắng nghe `process.env.PORT || 3000`)*
