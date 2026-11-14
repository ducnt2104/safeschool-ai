'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp, parseImageDataUrl } = require('../server');

// 1x1 transparent PNG for multimodal image tests
const SAMPLE_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function makeAnalysisStub(overrides = {}) {
  return {
    risk_level: 'HIGH',
    category: 'Đe dọa / Bôi nhọ trực tuyến',
    confidence_score: 91,
    detected_signals: 'Phát hiện ngôn từ công kích, đe dọa trực tiếp và gây áp lực tâm lý.',
    psychological_first_aid:
      'Thầy cô và SafeSchool AI đang ở bên lắng nghe em. Đây hoàn toàn không phải lỗi của em.',
    actionable_steps: [
      'Chụp màn hình đầy đủ tin nhắn kèm ngày giờ và tài khoản gửi.',
      'Chặn và báo cáo tài khoản vi phạm trên nền tảng mạng xã hội.',
      'Chia sẻ ngay với Tổ Tư vấn Tâm lý Nhà trường hoặc gia đình.',
    ],
    ...overrides,
  };
}

async function startTestServer(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeschool-test-'));
  const dbPath = path.join(tempDir, 'safeschool-test.db');

  const capturedCalls = {
    analyze: [],
    chat: [],
  };

  const defaultStubRunner = options.useDefaultAiRunner
    ? undefined
    : options.aiRunner === undefined
      ? {
          async analyze(payload) {
            capturedCalls.analyze.push(payload);
            return makeAnalysisStub();
          },
          async chat(payload) {
            capturedCalls.chat.push(payload);
            return {
              reply: 'Em hãy giữ bình tĩnh, chụp màn hình bằng chứng và trao đổi với Tổ Tư vấn nhé.',
              interactionId: `int-test-${capturedCalls.chat.length}`,
            };
          },
        }
      : options.aiRunner;

  const { app, db } = createApp({
    dbPath,
    adminPin: options.adminPin ?? '11092026',
    geminiApiKey: options.geminiApiKey ?? '',
    geminiModel: options.geminiModel ?? 'gemini-3.8-flash',
    aiRunner: defaultStubRunner,
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(urlPath, { method = 'GET', headers = {}, body } = {}) {
    const reqHeaders = { ...headers };
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      reqHeaders['content-type'] = 'application/json';
    }
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: reqHeaders,
      body: payload,
    });
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await res.json()
      : await res.text();
    return { status: res.status, headers: res.headers, data };
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return { baseUrl, db, capturedCalls, request, close };
}

test('parseImageDataUrl normalizes image/jpg and rejects unsupported formats', () => {
  const parsed = parseImageDataUrl(
    'data:image/jpg;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
  );
  assert.equal(parsed.mimeType, 'image/jpeg');
  assert.ok(parsed.normalizedDataUrl.startsWith('data:image/jpeg;base64,'));

  assert.throws(
    () => parseImageDataUrl('data:text/plain;base64,SGVsbG8='),
    (err) => err.status === 400
  );
});

test('Health, config status, static assets, vendor bundles, and zero-mock initial DB', async (t) => {
  const ctx = await startTestServer({ geminiApiKey: '' });
  t.after(() => ctx.close());

  const health = await ctx.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.db, 'connected');
  assert.equal(health.data.model, 'gemini-3.8-flash');

  const config = await ctx.request('/api/config/status');
  assert.equal(config.status, 200);
  assert.equal(config.data.ok, true);
  assert.equal(config.data.serverKeyConfigured, false);
  assert.equal(config.data.isDefaultPin, true);
  assert.equal(config.data.demoPinHint, '11092026');
  assert.match(config.data.schoolName, /Tôn Đức Thắng/);
  assert.match(config.data.requestedModelNote, /gemini-3\.5-flash/i);

  const indexRes = await ctx.request('/');
  assert.equal(indexRes.status, 200);
  assert.match(indexRes.data, /SafeSchool AI/);
  assert.match(indexRes.data, /id="btn-theme-toggle"/);
  assert.match(indexRes.data, /id="btn-start-tour"/);
  assert.doesNotMatch(indexRes.data, /api-key-dialog|x-gemini-api-key|Cài đặt API Key|server-key-warning/);

  const tailwindCssRes = await ctx.request('/tailwind.css');
  assert.equal(tailwindCssRes.status, 200);
  assert.ok(tailwindCssRes.data.length > 500);

  const cssRes = await ctx.request('/styles.css');
  assert.equal(cssRes.status, 200);

  const appJsRes = await ctx.request('/app.js');
  assert.equal(appJsRes.status, 200);

  const chartRes = await ctx.request('/vendor/chart.umd.min.js');
  assert.equal(chartRes.status, 200);
  assert.ok(chartRes.data.length > 1000);

  const lucideRes = await ctx.request('/vendor/lucide.min.js');
  assert.equal(lucideRes.status, 200);
  assert.ok(lucideRes.data.length > 1000);

  const unknownApi = await ctx.request('/api/does-not-exist');
  assert.equal(unknownApi.status, 404);
  assert.equal(unknownApi.data.code, 'NOT_FOUND');

  // Verify database starts completely clean with Zero Mock Data
  const loginRes = await ctx.request('/api/counselor/login', {
    method: 'POST',
    body: { pin: '11092026' },
  });
  assert.equal(loginRes.status, 200);

  const emptyDash = await ctx.request('/api/counselor/dashboard', {
    headers: { authorization: `Bearer ${loginRes.data.token}` },
  });
  assert.equal(emptyDash.status, 200);
  assert.deepEqual(emptyDash.data.tickets, []);
  assert.equal(emptyDash.data.analytics.total, 0);
  assert.equal(emptyDash.data.analytics.totalMessages, 0);
  assert.deepEqual(emptyDash.data.analytics.byStatus, {
    PENDING: 0,
    IN_PROGRESS: 0,
    RESOLVED: 0,
  });
  assert.deepEqual(emptyDash.data.analytics.byRisk, {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
  });
  assert.deepEqual(emptyDash.data.analytics.byCategory, []);
});

test('POST /api/analyze validates input, enforces server-side API key only, ignores client header overrides, and supports multimodal', async (t) => {
  const noKeyCtx = await startTestServer({ geminiApiKey: '' });
  t.after(() => noKeyCtx.close());

  const emptyInput = await noKeyCtx.request('/api/analyze', {
    method: 'POST',
    body: { text: '   ' },
  });
  assert.equal(emptyInput.status, 400);
  assert.equal(emptyInput.data.code, 'EMPTY_INPUT');

  const invalidImage = await noKeyCtx.request('/api/analyze', {
    method: 'POST',
    body: { imageDataUrl: 'not-a-valid-data-url' },
  });
  assert.equal(invalidImage.status, 400);
  assert.equal(invalidImage.data.code, 'INVALID_IMAGE');

  const missingKey = await noKeyCtx.request('/api/analyze', {
    method: 'POST',
    body: { text: 'Nhóm chat lớp đang chế ảnh mình và dọa đánh.' },
  });
  assert.equal(missingKey.status, 503);
  assert.equal(missingKey.data.code, 'MISSING_API_KEY');

  const headerOverrideIgnored = await noKeyCtx.request('/api/analyze', {
    method: 'POST',
    headers: { 'x-gemini-api-key': 'AIza-user-override-key' },
    body: { text: 'Nhóm chat lớp đang chế ảnh mình và dọa đánh.' },
  });
  assert.equal(headerOverrideIgnored.status, 503);
  assert.equal(headerOverrideIgnored.data.code, 'MISSING_API_KEY');

  const serverCtx = await startTestServer({ geminiApiKey: 'AIza-server-key' });
  t.after(() => serverCtx.close());

  const multimodal = await serverCtx.request('/api/analyze', {
    method: 'POST',
    headers: { 'x-gemini-api-key': 'AIza-ignored-override-key' },
    body: {
      text: 'Bạn kia nhắn tin đe dọa sau giờ học.',
      imageDataUrl: SAMPLE_PNG_DATA_URL,
    },
  });
  assert.equal(multimodal.status, 200);
  assert.equal(multimodal.data.ok, true);
  assert.equal(multimodal.data.modelUsed, 'gemini-3.8-flash');
  assert.equal(multimodal.data.analysis.risk_level, 'HIGH');
  assert.equal(serverCtx.capturedCalls.analyze.length, 1);
  assert.equal(serverCtx.capturedCalls.analyze[0].apiKey, 'AIza-server-key');
  assert.equal(serverCtx.capturedCalls.analyze[0].image.mimeType, 'image/png');
});

test('Zero-Identity tickets, 2-way anonymous messaging, triage sorting, and real SQLite analytics', async (t) => {
  const ctx = await startTestServer({ geminiApiKey: 'AIza-server-key' });
  t.after(() => ctx.close());

  const specs = [
    { grade: '10', risk: 'LOW', category: 'Bình thường', note: 'Hỏi tham khảo' },
    { grade: '12', risk: 'CRITICAL', category: 'Đe dọa bạo lực', note: 'Cần hỗ trợ gấp' },
    { grade: 'ANONYMOUS', risk: 'MEDIUM', category: 'Cô lập tập thể', note: '' },
    { grade: '11', risk: 'HIGH', category: 'Miệt thị ngoại hình', note: 'Bị bình luận công khai' },
  ];

  const createdCodes = [];
  for (const item of specs) {
    const res = await ctx.request('/api/tickets', {
      method: 'POST',
      body: {
        grade_level: item.grade,
        reported_text: `Nội dung báo cáo mức ${item.risk}`,
        student_note: item.note,
        evidence_image: item.risk === 'CRITICAL' ? SAMPLE_PNG_DATA_URL : null,
        analysis: makeAnalysisStub({
          risk_level: item.risk,
          category: item.category,
        }),
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.ok, true);
    assert.match(res.data.ticket.ticket_code, /^SH-[A-Z0-9]{6}$/);
    assert.equal(res.data.ticket.status, 'PENDING');
    // Confirm Zero-Identity: no PII fields returned
    assert.equal(res.data.ticket.email, undefined);
    assert.equal(res.data.ticket.phone, undefined);
    assert.equal(res.data.ticket.ip, undefined);
    createdCodes.push(res.data.ticket.ticket_code);
  }

  const criticalCode = createdCodes[1];

  // Lookup validation and 404 handling
  const badCode = await ctx.request('/api/tickets/BAD-CODE');
  assert.equal(badCode.status, 400);
  assert.equal(badCode.data.code, 'INVALID_TICKET_CODE');

  const notFound = await ctx.request('/api/tickets/SH-ZZZZZZ');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.data.code, 'NOT_FOUND');

  // Student looks up ticket (case-insensitive normalization); student_note seeds initial message
  const lookup = await ctx.request(`/api/tickets/${criticalCode.toLowerCase()}`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.data.ticket.ticket_code, criticalCode);
  assert.equal(lookup.data.ticket.evidence_image, SAMPLE_PNG_DATA_URL);
  assert.equal(lookup.data.messages.length, 1);
  assert.equal(lookup.data.messages[0].sender_role, 'STUDENT');
  assert.equal(lookup.data.messages[0].content, 'Cần hỗ trợ gấp');

  // Student sends an anonymous follow-up message
  const studentMsg = await ctx.request(`/api/tickets/${criticalCode}/messages`, {
    method: 'POST',
    body: { content: 'Em mới nhận thêm một tin nhắn đe dọa khác lúc ra về.' },
  });
  assert.equal(studentMsg.status, 201);
  assert.equal(studentMsg.data.message.sender_role, 'STUDENT');
  assert.equal(studentMsg.data.status, 'PENDING');

  // Counselor auth checks
  const unauthDash = await ctx.request('/api/counselor/dashboard');
  assert.equal(unauthDash.status, 401);
  assert.equal(unauthDash.data.code, 'UNAUTHORIZED');

  const wrongPin = await ctx.request('/api/counselor/login', {
    method: 'POST',
    body: { pin: '0000' },
  });
  assert.equal(wrongPin.status, 401);
  assert.equal(wrongPin.data.code, 'INVALID_PIN');

  const login = await ctx.request('/api/counselor/login', {
    method: 'POST',
    body: { pin: '11092026' },
  });
  assert.equal(login.status, 200);
  const authHeaders = { authorization: `Bearer ${login.data.token}` };

  // Verify Triage Queue sorts CRITICAL -> HIGH -> MEDIUM -> LOW
  const dash = await ctx.request('/api/counselor/dashboard', { headers: authHeaders });
  assert.equal(dash.status, 200);
  assert.deepEqual(
    dash.data.tickets.map((ticket) => ticket.risk_level),
    ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
  );

  // Verify real SQLite analytics counts (3 tickets had initial notes + 1 follow-up message = 4)
  assert.equal(dash.data.analytics.total, 4);
  assert.equal(dash.data.analytics.totalMessages, 4);
  assert.deepEqual(dash.data.analytics.byRisk, {
    CRITICAL: 1,
    HIGH: 1,
    MEDIUM: 1,
    LOW: 1,
  });
  assert.deepEqual(dash.data.analytics.byStatus, {
    PENDING: 4,
    IN_PROGRESS: 0,
    RESOLVED: 0,
  });

  // First counselor reply automatically moves PENDING -> IN_PROGRESS
  const counselorReply = await ctx.request(
    `/api/counselor/tickets/${criticalCode}/messages`,
    {
      method: 'POST',
      headers: authHeaders,
      body: {
        content:
          'Cô đã tiếp nhận hồ sơ. Chiều nay ra về em đi cùng bạn và ghé phòng Tư vấn nhé.',
      },
    }
  );
  assert.equal(counselorReply.status, 201);
  assert.equal(counselorReply.data.message.sender_role, 'COUNSELOR');
  assert.equal(counselorReply.data.status, 'IN_PROGRESS');

  // Student reads the 2-way conversation
  const updatedLookup = await ctx.request(`/api/tickets/${criticalCode}`);
  assert.equal(updatedLookup.status, 200);
  assert.equal(updatedLookup.data.ticket.status, 'IN_PROGRESS');
  assert.equal(updatedLookup.data.messages.length, 3);
  assert.equal(updatedLookup.data.messages[0].sender_role, 'STUDENT');
  assert.equal(updatedLookup.data.messages[1].sender_role, 'STUDENT');
  assert.equal(updatedLookup.data.messages[2].sender_role, 'COUNSELOR');

  // Counselor marks ticket RESOLVED and checks filtered dashboard
  const resolveRes = await ctx.request(
    `/api/counselor/tickets/${criticalCode}/status`,
    {
      method: 'PATCH',
      headers: authHeaders,
      body: { status: 'RESOLVED' },
    }
  );
  assert.equal(resolveRes.status, 200);
  assert.equal(resolveRes.data.ticket.status, 'RESOLVED');

  const resolvedOnly = await ctx.request('/api/counselor/dashboard?status=RESOLVED', {
    headers: authHeaders,
  });
  assert.equal(resolvedOnly.status, 200);
  assert.equal(resolvedOnly.data.tickets.length, 1);
  assert.equal(resolvedOnly.data.tickets[0].ticket_code, criticalCode);
});

test('POST /api/chat enforces server-side API key, ignores header override, and forwards previousInteractionId', async (t) => {
  const noKeyCtx = await startTestServer({ geminiApiKey: '' });
  t.after(() => noKeyCtx.close());

  const noKey = await noKeyCtx.request('/api/chat', {
    method: 'POST',
    body: { message: 'Nếu bị bạn dọa tung ảnh riêng tư thì làm sao?' },
  });
  assert.equal(noKey.status, 503);
  assert.equal(noKey.data.code, 'MISSING_API_KEY');

  const headerIgnored = await noKeyCtx.request('/api/chat', {
    method: 'POST',
    headers: { 'x-gemini-api-key': 'AIza-chat-header-should-fail' },
    body: { message: 'Nếu bị bạn dọa tung ảnh riêng tư thì làm sao?' },
  });
  assert.equal(headerIgnored.status, 503);
  assert.equal(headerIgnored.data.code, 'MISSING_API_KEY');

  const ctx = await startTestServer({ geminiApiKey: 'AIza-server-chat-key' });
  t.after(() => ctx.close());

  const turn1 = await ctx.request('/api/chat', {
    method: 'POST',
    headers: { 'x-gemini-api-key': 'AIza-ignored-client-key' },
    body: { message: 'Nếu bị bạn dọa tung ảnh riêng tư thì làm sao?' },
  });
  assert.equal(turn1.status, 200);
  assert.equal(turn1.data.ok, true);
  assert.equal(turn1.data.interactionId, 'int-test-1');
  assert.equal(ctx.capturedCalls.chat[0].apiKey, 'AIza-server-chat-key');

  const turn2 = await ctx.request('/api/chat', {
    method: 'POST',
    body: {
      message: 'Mình cần lưu bằng chứng như thế nào?',
      previousInteractionId: turn1.data.interactionId,
      history: [{ role: 'user', text: 'Nếu bị bạn dọa tung ảnh riêng tư thì làm sao?' }],
    },
  });
  assert.equal(turn2.status, 200);
  assert.equal(turn2.data.interactionId, 'int-test-2');
  assert.equal(ctx.capturedCalls.chat[1].apiKey, 'AIza-server-chat-key');
  assert.equal(ctx.capturedCalls.chat[1].previousInteractionId, 'int-test-1');
});

test('Default unstubbed aiRunner boots cleanly and enforces missing key checks', async (t) => {
  const ctx = await startTestServer({ geminiApiKey: '', useDefaultAiRunner: true });
  t.after(() => ctx.close());

  const analyzeRes = await ctx.request('/api/analyze', {
    method: 'POST',
    body: { text: 'Kiểm tra khởi tạo mặc định.' },
  });
  assert.equal(analyzeRes.status, 503);
  assert.equal(analyzeRes.data.code, 'MISSING_API_KEY');

  const chatRes = await ctx.request('/api/chat', {
    method: 'POST',
    body: { message: 'Kiểm tra khởi tạo chat mặc định.' },
  });
  assert.equal(chatRes.status, 503);
  assert.equal(chatRes.data.code, 'MISSING_API_KEY');
});
