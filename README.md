# SafeSchool AI — Lá chắn Số Học đường

Nền tảng web Full-Stack hỗ trợ **phát hiện sớm bắt nạt trực tuyến**, **sơ cứu tâm lý tức thì**, **cẩm nang kỹ năng số** và **cổng kết nối tư vấn học đường ẩn danh 2 chiều** dành cho học sinh THPT — phát triển bởi **Team Victer - DNT (Nguyễn Tiến Đức - Trường THPT Tôn Đức Thắng, xã Tà Lài, tỉnh Đồng Nai)**.

---

## Kiến trúc hiệu năng siêu tốc & Nguyên tắc cốt lõi

1. **Ultra-Low Latency Pipeline (`< 1.5s` luồng phân tích & SSE Streaming):**
   - **Client-Side Smart Image Compression:** Trước khi gửi ảnh chụp màn hình lên máy chủ, trình duyệt tự động thu nhỏ cạnh dài tối đa về `1024px` bằng HTML5 `<canvas>` và nén sang `image/webp` chất lượng `0.78` (fallback `image/jpeg`), giảm dung lượng từ vài MB xuống `~40KB - 150KB` trong `< 50ms`.
   - **Real-Time Server-Sent Events (SSE):** Các endpoint `POST /api/analyze/stream` và `POST /api/chat/stream` truyền tiến độ theo giai đoạn thực (*Tối ưu dữ liệu → AI quét ngữ cảnh → Sơ cứu & Khuyến nghị*), đổ dần kết quả JSON ra thẻ giao diện và stream từng cụm chữ cho Trợ lý AI An toàn Mạng.
   - **Backend Tuning & Caching:** Nén HTTP `compression` (bỏ qua SSE `/stream`), HTTP Keep-Alive (`65s`), pooling `GoogleGenAI` client, chuẩn hóa `temperature: 0.15`, `max_output_tokens: 1024`, `thinking_level: 'minimal'` trên `gemini-3.5-flash-lite`, **SHA-256 LRU Cache** (`< 10ms` cho nội dung lặp lại) và **Circuit Breaker** tự động tránh nghẽn 429/timeout.
2. **Zero Mock Data (Không dữ liệu giả):**
   - Cơ sở dữ liệu SQLite (`better-sqlite3`) khởi tạo sạch 100% (0 bản ghi mẫu).
   - Bảng điều khiển Tổ Tư vấn và biểu đồ thống kê (`Chart.js`) tính toán trực tiếp từ SQLite.
3. **Zero-Identity & Server-Side API Key Only:**
   - Tuyệt đối không thu thập họ tên, email, SĐT hay địa chỉ IP. Toàn bộ gọi Google AI Studio API được thực hiện 100% tại Backend qua biến môi trường `GEMINI_API_KEY`.
4. **Bộ tính năng bảo vệ học sinh & Tổ Tư vấn:**
   - **Góc Học sinh:** Trích đoạn bằng chứng trọng tâm (`evidence_excerpt`), khía cạnh tâm lý & pháp lý Việt Nam (`legal_psych_impact`), bài tập **hít thở 4-7-8 tương tác 30 giây**, thanh **SOS & Tổng đài 111 / Ngày Mai 096 306 1414**, tạo mã hồ sơ ẩn danh `SH-XXXXXX` kèm nút **Tải ảnh thẻ mã `.png`**, và **Trợ lý AI An toàn Mạng** phản hồi theo luồng SSE.
   - **Góc Tổ Tư vấn:** Hàng đợi phân loại thông minh (`CRITICAL → LOW`), biểu đồ `Chart.js` thời gian thực, **Xuất CSV ẩn danh** (UTF-8 BOM, chống formula injection) và **In / Xuất PDF báo cáo Đoàn trường** (`@media print`).
   - **Nhận diện thương hiệu & Giao diện:** Logo & Favicon SVG riêng (`public/logo.svg`, `public/favicon.svg`), Light/Dark Mode chuẩn Tailwind CSS (`darkMode: 'class'`) và **Interactive Spotlight Onboarding Tour 5 bước**.

---

## Cấu trúc thư mục

```text
safeschool-ai/
├── package.json            # @google/genai, express, compression, better-sqlite3, chart.js, lucide, zod, dotenv
├── tailwind.config.js      # Cấu hình Tailwind CSS (darkMode: 'class')
├── src/
│   └── tailwind-input.css  # Nguồn CSS đầu vào để build tĩnh ra public/tailwind.css
├── start-safeschool.bat    # Script khởi chạy nhanh 1 chạm trên Windows
├── .env.example            # Mẫu biến môi trường (PORT, GEMINI_API_KEY, GEMINI_MODEL, ADMIN_PIN, DB_PATH)
├── .gitignore              # Loại trừ node_modules, .env, file database *.db
├── server.js               # Express + Compression + SSE Streaming + SHA-256 Cache + Gemini Multimodal JSON Schema + Auth PIN
├── database.js             # SQLite WAL schema (tickets, messages), auto-migration cột mới, truy vấn thống kê thực
├── public/
│   ├── favicon.svg         # Favicon SVG nhận diện SafeSchool AI
│   ├── logo.svg            # Logo SVG Khiên & Trái tim SafeSchool AI
│   ├── index.html          # Giao diện Góc Học sinh, Spotlight Tour 5 bước & Góc Tổ Tư vấn
│   ├── tailwind.css        # CSS Tailwind đã biên dịch sẵn (npm run build:css)
│   ├── styles.css          # Light/Dark Mode, Glassmorphism, Breathing 4-7-8, Spotlight & Print Report CSS
│   └── app.js              # Nén ảnh Canvas, SSE client, 4-7-8 Breathing Timer, Receipt Card PNG, CSV/Print Export & Chart.js
└── tests/
    └── api.test.js         # Kiểm thử API, SSE streaming, SHA-256 cache, bảo mật server-side key, PIN, Triage & SQLite
```

---

## Cài đặt & Chạy Local (1 lệnh)

**Yêu cầu:** Node.js `>= 22.0.0`.

```bash
npm install
cp .env.example .env
# Điền GEMINI_API_KEY trong file .env
npm run build:css
npm start
```

> **Windows:** Nhấp đúp tệp `start-safeschool.bat` để tự kiểm tra Node.js, cài đặt `node_modules`, khởi tạo `.env`, chạy server tại `http://localhost:3000` và mở trình duyệt.

- Khi vào **"Góc Tổ Tư vấn"** ở cấu hình mặc định, mã PIN demo là `11092026`.

### Kiểm thử tự động

```bash
npm test
```

---

## Triển khai lên Render (`safeschool-ai-smdb.onrender.com`)

1. Đẩy mã nguồn lên GitHub (`.env` và `data/` đã được `.gitignore` loại trừ).
2. Tạo **Web Service** trên [Render](https://render.com) trỏ tới repository:
   - **Runtime:** `Node`
   - **Build Command:** `npm install && npm run build:css`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/api/health`
3. Thêm **Environment Variables**:
   - `GEMINI_API_KEY`: API Key Google AI Studio *(bắt buộc)*
   - `GEMINI_MODEL`: `gemini-3.5-flash-lite` *(tối ưu độ trễ `< 1.5s` cho Multimodal + JSON Schema)*
   - `ADMIN_PIN`: Mã PIN bí mật của Tổ Tư vấn Tâm lý Nhà trường
   - `SHOW_DEMO_PIN_HINT`: `false` *(ẩn gợi ý PIN demo trên môi trường công khai)*
   - `DB_PATH`: `/var/data/safeschool.db` *(khi gắn Render Persistent Disk tại `/var/data`)*
