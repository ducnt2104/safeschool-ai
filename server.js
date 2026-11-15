require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const compression = require('compression');
const { GoogleGenAI } = require('@google/genai');
const { z } = require('zod');
const { createDatabase } = require('./database');

const FAST_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const SECONDARY_MODEL = 'gemini-3.8-flash';
const rawEnvModel = String(process.env.GEMINI_MODEL || '').trim();
// Nếu chưa cấu hình hoặc cấu hình gemini-3.5-flash (đã deprecated/chậm trên API),
// tự động định tuyến sang nhánh siêu tốc gemini-3.5-flash-lite (< 1.5s, tương thích schema gemini-3.5-flash).
const DEFAULT_MODEL =
  !rawEnvModel || rawEnvModel === 'gemini-3.5-flash' ? FAST_DEFAULT_MODEL : rawEnvModel;
const GEMINI_PRIMARY_TIMEOUT_MS = 5500;
const GEMINI_FALLBACK_TIMEOUT_MS = 14000;
const REQUESTED_MODEL_NOTE =
  DEFAULT_MODEL === FAST_DEFAULT_MODEL
    ? 'Sử dụng model gemini-3.5-flash-lite (nhánh siêu tốc tối ưu độ trễ < 1.5s, tương thích cấu hình gemini-3.5-flash).'
    : `Sử dụng model ${DEFAULT_MODEL}.`;

const SCHOOL_NAME = 'Trường THPT Tôn Đức Thắng, xã Tà Lài, Thành phố Đồng Nai';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_STORED_IMAGE_BYTES = 4 * 1024 * 1024;
const ANALYSIS_CACHE_TTL_MS = 30 * 60 * 1000;
const ANALYSIS_CACHE_MAX_ENTRIES = 200;

const CATEGORIES = [
  'Miệt thị ngoại hình (Body Shaming)',
  'Cô lập tập thể',
  'Vu khống / Bôi nhọ danh dự',
  'Đe dọa bạo lực / Tống tiền',
  'Quấy rối trực tuyến',
  'Xâm phạm riêng tư / Rò rỉ thông tin',
  'Nguy cơ tự hại / Khủng hoảng tâm lý',
  'Bình thường / Không có dấu hiệu bắt nạt',
  'Hành vi tiêu cực khác',
];

const ANALYSIS_SYSTEM_INSTRUCTION = [
  'Bạn là Chuyên gia Tâm lý Học đường & An toàn Mạng tại Việt Nam (SafeSchool AI - Trường THPT Tôn Đức Thắng, xã Tà Lài, Thành phố Đồng Nai).',
  'Phân tích nhanh, chuẩn xác văn bản hoặc ảnh chụp màn hình để phát hiện bắt nạt trực tuyến, tiếng lóng, teencode học đường trên Facebook, Messenger, Zalo, TikTok.',
  'Phân biệt trêu đùa thân thiện với công kích, miệt thị, cô lập, vu khống hay đe dọa. Nếu có nguy cơ tự hại, đe dọa tính mạng hoặc bạo lực nghiêm trọng, BẮT BUỘC xếp CRITICAL.',
  'Trả về JSON ngắn gọn, súc tích đúng Schema: trích dẫn cụm từ gây tổn thương nổi bật (evidence_excerpt), đánh giá tác động tâm lý & pháp lý theo Luật An ninh mạng 2018 (legal_psych_impact), lời trấn an ấm áp (psychological_first_aid) và 3-4 bước hành động cụ thể gồm cách giữ nguyên URL/thời gian/ID khi chụp màn hình và chặn/báo cáo.',
].join(' ');

const CHAT_SYSTEM_INSTRUCTION = [
  'Bạn là Trợ lý Cẩm nang An toàn Mạng & Luyện Phản xạ (AI Safety Coach) của nền tảng SafeSchool AI tại Trường THPT Tôn Đức Thắng, xã Tà Lài, Thành phố Đồng Nai.',
  'Đối tượng là học sinh THPT. Giọng văn gần gũi, tôn trọng, bảo vệ sức khỏe tinh thần và phẩm giá học sinh.',
  'Hỗ trợ: (1) Gợi ý 2-3 câu đáp trả khéo léo, bản lĩnh khi bị trêu chọc hoặc công kích nhóm chat; (2) Lưu bằng chứng số chuẩn pháp lý (giữ URL, thời gian, ID tài khoản); (3) Chặn/báo cáo trên Facebook, Messenger, Zalo, TikTok; (4) Quyền riêng tư & Luật An ninh mạng 2018 / QĐ 874/QĐ-BTTTT.',
  'Nếu phát hiện khủng hoảng nặng hoặc tự hại, khuyên gọi ngay Tổng đài Bảo vệ Trẻ em 111 (24/7), Đường dây nóng Ngày Mai 096 306 1414 hoặc gửi hồ sơ ẩn danh trên ứng dụng.',
  'Trả lời súc tích theo gạch đầu dòng ngắn gọn, dễ đọc trên điện thoại.',
].join('\n');

const ANALYSIS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    risk_level: {
      type: 'string',
      enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      description: 'Mức độ rủi ro: LOW, MEDIUM, HIGH, hoặc CRITICAL.',
    },
    category: {
      type: 'string',
      enum: CATEGORIES,
      description: 'Phân loại hành vi chính xác nhất bằng tiếng Việt.',
    },
    confidence_score: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'Độ tin cậy từ 0 đến 100 (%).',
    },
    evidence_excerpt: {
      type: 'string',
      description:
        'Trích dẫn ngắn gọn cụm từ hoặc chi tiết hình ảnh gây tổn thương; nếu an toàn ghi "Không phát hiện chi tiết công kích."',
    },
    detected_signals: {
      type: 'string',
      description: 'Giải thích súc tích, khách quan dấu hiệu ngôn ngữ/ngữ cảnh phát hiện được.',
    },
    legal_psych_impact: {
      type: 'string',
      description:
        'Đánh giá ngắn tác động tâm lý và quyền được bảo vệ theo Luật An ninh mạng 2018 / QĐ 874/QĐ-BTTTT.',
    },
    psychological_first_aid: {
      type: 'string',
      description: 'Lời trấn an ấm áp, đồng cảm, không phán xét dành cho học sinh ngay lúc này.',
    },
    actionable_steps: {
      type: 'array',
      minItems: 3,
      maxItems: 4,
      items: { type: 'string' },
      description:
        '3 đến 4 bước ứng phó cụ thể (lưu chứng cứ giữ URL/thời gian/ID, chặn/báo cáo trên Facebook/Zalo/TikTok).',
    },
  },
  required: [
    'risk_level',
    'category',
    'confidence_score',
    'evidence_excerpt',
    'detected_signals',
    'legal_psych_impact',
    'psychological_first_aid',
    'actionable_steps',
  ],
  additionalProperties: false,
};

const AnalysisResultSchema = z.object({
  risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  category: z.string().min(2).max(140),
  confidence_score: z.number().int().min(0).max(100),
  evidence_excerpt: z.string().max(600).optional().default(''),
  detected_signals: z.string().min(4).max(2000),
  legal_psych_impact: z.string().max(1200).optional().default(''),
  psychological_first_aid: z.string().min(4).max(2000),
  actionable_steps: z.array(z.string().min(3).max(500)).min(1).max(6),
});

const AnalyzeRequestSchema = z.object({
  text: z.string().max(6000).optional(),
  imageDataUrl: z.string().max(12 * 1024 * 1024).nullable().optional(),
});

const CreateTicketSchema = z.object({
  grade_level: z.enum(['10', '11', '12', 'ANONYMOUS']).default('ANONYMOUS'),
  reported_text: z.string().max(6000).optional().default(''),
  student_note: z.string().max(2000).optional().default(''),
  evidence_image: z.string().max(6 * 1024 * 1024).nullable().optional(),
  analysis: AnalysisResultSchema,
});

const MessageInputSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'Vui lòng nhập nội dung tin nhắn.')
    .max(2000, 'Tin nhắn tối đa 2.000 ký tự.'),
});

const StatusUpdateSchema = z.object({
  status: z.enum(['PENDING', 'IN_PROGRESS', 'RESOLVED']),
});

const ChatRequestSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, 'Vui lòng nhập câu hỏi.')
    .max(2000, 'Câu hỏi tối đa 2.000 ký tự.'),
  previousInteractionId: z.string().max(256).nullable().optional(),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().max(4000),
      })
    )
    .max(20)
    .optional(),
});

const TICKET_CODE_REGEX = /^SH-[A-Z0-9]{6}$/;

function parseImageDataUrl(dataUrl, maxBytes = MAX_IMAGE_BYTES) {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(
    /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/
  );
  if (!match) {
    const err = new Error(
      'Định dạng ảnh không hợp lệ. Chỉ hỗ trợ ảnh PNG, JPG, WebP hoặc GIF.'
    );
    err.status = 400;
    throw err;
  }
  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const base64Data = match[2];
  const byteSize = Math.floor((base64Data.length * 3) / 4);
  if (byteSize > maxBytes) {
    const limitMb = Math.round(maxBytes / (1024 * 1024));
    const err = new Error(`Kích thước ảnh vượt quá giới hạn ${limitMb}MB.`);
    err.status = 400;
    throw err;
  }
  return {
    mimeType,
    base64Data,
    normalizedDataUrl: `data:${mimeType};base64,${base64Data}`,
  };
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest();
}

function constantTimeEquals(a, b) {
  return crypto.timingSafeEqual(sha256Buffer(a), sha256Buffer(b));
}

function extractInteractionText(interaction) {
  if (!interaction) return '';
  if (typeof interaction.output_text === 'string' && interaction.output_text.trim()) {
    return interaction.output_text.trim();
  }
  if (Array.isArray(interaction.steps)) {
    const chunks = [];
    for (const step of interaction.steps) {
      if (step && step.type === 'model_output' && Array.isArray(step.content)) {
        for (const item of step.content) {
          if (item && item.type === 'text' && typeof item.text === 'string') {
            chunks.push(item.text);
          }
        }
      }
    }
    if (chunks.length > 0) return chunks.join('').trim();
  }
  return '';
}

function parseJsonResponse(rawText) {
  const cleaned = String(rawText || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientGeminiError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const msg = String(error?.message || '').toLowerCase();
  const name = String(error?.name || '').toLowerCase();
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    name === 'timeouterror' ||
    msg.includes('timeout') ||
    msg.includes('high demand') ||
    msg.includes('unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('deadline expired')
  );
}

function classifyGeminiError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const msg = String(error?.message || '');
  const lower = msg.toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('permission_denied') ||
    lower.includes('unauthenticated')
  ) {
    return {
      status: 401,
      code: 'INVALID_API_KEY',
      message:
        'API Key Google AI Studio trên máy chủ không hợp lệ hoặc đã hết hiệu lực. Vui lòng kiểm tra lại cấu hình GEMINI_API_KEY trong tệp .env.',
    };
  }

  if (status === 429 || lower.includes('resource_exhausted') || lower.includes('quota')) {
    return {
      status: 429,
      code: 'RATE_LIMITED',
      message:
        'API Key đang tạm thời chạm giới hạn lượt gọi (Rate Limit/Quota). Vui lòng chờ vài giây rồi thử lại.',
    };
  }

  if (
    status === 503 ||
    status === 504 ||
    lower.includes('high demand') ||
    lower.includes('timeout') ||
    lower.includes('deadline expired')
  ) {
    return {
      status: 503,
      code: 'AI_BUSY',
      message:
        'Máy chủ Google Gemini AI đang quá tải tạm thời. Vui lòng thử bấm phân tích lại sau vài giây.',
    };
  }

  if (status === 400 && lower.includes('model')) {
    return {
      status: 400,
      code: 'MODEL_ERROR',
      message: `Không thể gọi model AI (${msg}). Vui lòng kiểm tra cấu hình GEMINI_MODEL.`,
    };
  }

  return {
    status: status >= 400 && status < 600 ? status : 502,
    code: 'GEMINI_API_ERROR',
    message:
      'Không thể kết nối tới Google AI Studio lúc này. Vui lòng kiểm tra kết nối mạng hoặc thử lại sau.',
  };
}

async function callGeminiWithRetry(fn, maxRetries = 1) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientGeminiError(error) || attempt === maxRetries) {
        throw error;
      }
      const backoffMs = 450 * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(backoffMs);
    }
  }
  throw lastError;
}

const aiClientPool = new Map();
const modelCooldownUntil = new Map();

function getGenAIClient(apiKey) {
  let client = aiClientPool.get(apiKey);
  if (!client) {
    if (aiClientPool.size >= 8) {
      const oldestKey = aiClientPool.keys().next().value;
      aiClientPool.delete(oldestKey);
    }
    client = new GoogleGenAI({ apiKey });
    aiClientPool.set(apiKey, client);
  }
  return client;
}

function getThinkingLevelForModel(model) {
  const name = String(model || '').toLowerCase();
  if (
    name.includes('3.8') ||
    name.includes('4-') ||
    name.includes('pro') ||
    name.includes('2.5')
  ) {
    return 'low';
  }
  return 'minimal';
}

function buildAnalysisGenerationConfig(model) {
  return {
    thinking_level: getThinkingLevelForModel(model),
    temperature: 0.15,
    max_output_tokens: 1024,
  };
}

function buildChatGenerationConfig(model) {
  return {
    thinking_level: getThinkingLevelForModel(model),
    temperature: 0.25,
    max_output_tokens: 1024,
  };
}

/**
 * Quét JSON đang stream để trích xuất ngay các trường đã hoàn chỉnh (phục vụ SSE Progressive UI).
 */
function extractCompletedJsonFields(raw) {
  const src = String(raw || '').trim();
  const objStart = src.indexOf('{');
  if (objStart === -1) return {};

  const fields = {};
  let i = objStart + 1;
  const n = src.length;

  const skipWs = () => {
    while (i < n && /[\s,]/.test(src[i])) i += 1;
  };

  const readJsonString = () => {
    if (src[i] !== '"') return null;
    const start = i;
    i += 1;
    while (i < n) {
      const ch = src[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        const token = src.slice(start, i + 1);
        i += 1;
        try {
          return JSON.parse(token);
        } catch {
          return null;
        }
      }
      i += 1;
    }
    return undefined; // Chưa hoàn thành chuỗi trong stream
  };

  while (i < n) {
    skipWs();
    if (i >= n || src[i] === '}') break;
    if (src[i] !== '"') {
      i += 1;
      continue;
    }
    const key = readJsonString();
    if (key === undefined) break;
    skipWs();
    if (src[i] !== ':') break;
    i += 1;
    skipWs();
    if (i >= n) break;

    if (src[i] === '"') {
      const val = readJsonString();
      if (val === undefined) break;
      if (key && val !== null) fields[key] = val;
    } else if (src[i] === '[') {
      i += 1;
      const items = [];
      let closed = false;
      while (i < n) {
        skipWs();
        if (i >= n) break;
        if (src[i] === ']') {
          i += 1;
          closed = true;
          break;
        }
        if (src[i] === '"') {
          const item = readJsonString();
          if (item === undefined) break;
          if (item !== null) items.push(item);
        } else {
          i += 1;
        }
      }
      if (key && items.length > 0) fields[key] = items;
      if (!closed) break;
    } else {
      const valStart = i;
      while (i < n && !/[,}\s]/.test(src[i])) i += 1;
      if (i >= n) break; // Chờ ký tự phân tách để chắc chắn số đã hoàn tất
      const token = src.slice(valStart, i);
      if (key && /^-?\d+(?:\.\d+)?$/.test(token)) {
        fields[key] = Number(token);
      }
    }
  }

  return fields;
}

/**
 * Thử gọi model chính; bỏ qua tức thì model đang trong cooldown 429/timeout để không nghẽn luồng.
 */
async function runWithModelFallback(primaryModel, invokeForModel) {
  const rawCandidates = [primaryModel || DEFAULT_MODEL, FAST_DEFAULT_MODEL, SECONDARY_MODEL];
  const uniqueCandidates = Array.from(new Set(rawCandidates.filter(Boolean)));
  const now = Date.now();
  const activeCandidates = uniqueCandidates.filter(
    (m) => (modelCooldownUntil.get(m) || 0) <= now
  );
  const candidates = activeCandidates.length > 0 ? activeCandidates : uniqueCandidates;

  let lastError;
  for (let idx = 0; idx < candidates.length; idx += 1) {
    const model = candidates[idx];
    const isLastCandidate = idx === candidates.length - 1;
    try {
      const requestOptions = {
        timeout_ms: isLastCandidate ? GEMINI_FALLBACK_TIMEOUT_MS : GEMINI_PRIMARY_TIMEOUT_MS,
        retries: { strategy: 'none' },
      };
      const retries = isLastCandidate ? 1 : 0;
      const result = await callGeminiWithRetry(
        () => invokeForModel(model, requestOptions),
        retries
      );
      return { result, modelUsed: model };
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || error?.statusCode || 0);
      const msgLower = String(error?.message || '').toLowerCase();
      if (status === 429 || msgLower.includes('quota') || msgLower.includes('rate limit')) {
        modelCooldownUntil.set(model, Date.now() + 10 * 60 * 1000);
      } else if (
        String(error?.name || '').toLowerCase() === 'timeouterror' ||
        msgLower.includes('timeout')
      ) {
        modelCooldownUntil.set(model, Date.now() + 2 * 60 * 1000);
      }
      if (!isTransientGeminiError(error) || isLastCandidate) {
        throw error;
      }
    }
  }
  throw lastError;
}

function createApp(options = {}) {
  const db = options.db || createDatabase(options.dbPath);
  const adminPin = String(options.adminPin || process.env.ADMIN_PIN || '11092026');
  const showDemoHintEnv = process.env.SHOW_DEMO_PIN_HINT !== 'false';
  const isDefaultPin = adminPin === '11092026' && showDemoHintEnv;
  const geminiModel = options.geminiModel || DEFAULT_MODEL;
  const sessionSecret = crypto.randomBytes(32);

  function resolveServerApiKey() {
    return String(
      options.geminiApiKey !== undefined
        ? options.geminiApiKey
        : process.env.GEMINI_API_KEY || ''
    ).trim();
  }

  function signCounselorToken() {
    const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    const nonce = crypto.randomBytes(12).toString('hex');
    const payload = `${expiresAt}.${nonce}`;
    const sig = crypto
      .createHmac('sha256', sessionSecret)
      .update(`${payload}.${adminPin}`)
      .digest('hex');
    return `${payload}.${sig}`;
  }

  function verifyCounselorToken(token) {
    if (!token || typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [expiresAtStr, nonce, sig] = parts;
    const expiresAt = Number(expiresAtStr);
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
    const expectedSig = crypto
      .createHmac('sha256', sessionSecret)
      .update(`${expiresAtStr}.${nonce}.${adminPin}`)
      .digest('hex');
    if (sig.length !== expectedSig.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  }

  function requireCounselor(req, res, next) {
    const authHeader = String(req.get('authorization') || '');
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match || !verifyCounselorToken(match[1].trim())) {
      return res.status(401).json({
        ok: false,
        code: 'UNAUTHORIZED',
        error: 'Phiên đăng nhập Tổ Tư vấn chưa được xác thực hoặc đã hết hạn.',
      });
    }
    return next();
  }

  function buildAnalysisInputParts(text, image) {
    const inputParts = [];
    const userText =
      text && text.trim()
        ? text.trim()
        : 'Hãy phân tích toàn bộ nội dung văn bản, bình luận và ngữ cảnh trong ảnh chụp màn hình đính kèm.';

    inputParts.push({
      type: 'text',
      text: `Nội dung học sinh cung cấp để phân tích dấu hiệu bắt nạt trực tuyến:\n"""\n${userText}\n"""`,
    });

    if (image) {
      inputParts.push({
        type: 'image',
        data: image.base64Data,
        mime_type: image.mimeType,
      });
    }
    return inputParts;
  }

  function buildChatTranscriptFallbackPrompt(message, history) {
    if (!Array.isArray(history) || history.length === 0) {
      return message;
    }
    const recent = history.slice(-10).map((turn) => {
      const speaker = turn.role === 'assistant' ? 'Trợ lý' : 'Học sinh';
      return `${speaker}: ${turn.text}`;
    });
    return `Ngữ cảnh hội thoại trước đó:\n${recent.join('\n')}\n\nCâu hỏi mới của học sinh: ${message}`;
  }

  function attachModelMeta(analysisObj, modelUsed) {
    Object.defineProperty(analysisObj, '__modelUsed', {
      value: modelUsed,
      enumerable: false,
    });
    return analysisObj;
  }

  const defaultAiRunner = {
    async analyze({ apiKey, text, image }) {
      const ai = getGenAIClient(apiKey);
      const inputParts = buildAnalysisInputParts(text, image);

      const { result: interaction, modelUsed } = await runWithModelFallback(
        geminiModel,
        (model, requestOptions) =>
          ai.interactions.create(
            {
              model,
              system_instruction: ANALYSIS_SYSTEM_INSTRUCTION,
              // API v1 yêu cầu danh sách steps bọc nội dung đa phương thức trong bước user_input
              input: [{ type: 'user_input', content: inputParts }],
              response_format: {
                type: 'text',
                mime_type: 'application/json',
                schema: ANALYSIS_RESPONSE_SCHEMA,
              },
              generation_config: buildAnalysisGenerationConfig(model),
              store: false,
            },
            requestOptions
          )
      );

      const rawOutput = extractInteractionText(interaction);
      if (!rawOutput) {
        throw new Error('Phản hồi từ AI trống.');
      }
      const parsed = parseJsonResponse(rawOutput);
      const validated = AnalysisResultSchema.parse(parsed);
      return attachModelMeta(validated, modelUsed);
    },

    async analyzeStream({ apiKey, text, image, onPartial, signal }) {
      const ai = getGenAIClient(apiKey);
      const inputParts = buildAnalysisInputParts(text, image);

      const { result: stream, modelUsed } = await runWithModelFallback(
        geminiModel,
        (model, requestOptions) =>
          ai.interactions.create(
            {
              model,
              system_instruction: ANALYSIS_SYSTEM_INSTRUCTION,
              input: [{ type: 'user_input', content: inputParts }],
              response_format: {
                type: 'text',
                mime_type: 'application/json',
                schema: ANALYSIS_RESPONSE_SCHEMA,
              },
              generation_config: buildAnalysisGenerationConfig(model),
              stream: true,
              store: false,
            },
            requestOptions
          )
      );

      let rawOutput = '';
      let lastFieldSignature = '';

      for await (const ev of stream) {
        if (signal?.aborted) break;
        if (ev.event_type === 'step.delta' && ev.delta?.type === 'text' && ev.delta.text) {
          rawOutput += ev.delta.text;
          if (typeof onPartial === 'function') {
            const fields = extractCompletedJsonFields(rawOutput);
            const sig = JSON.stringify(fields);
            if (sig !== lastFieldSignature && Object.keys(fields).length > 0) {
              lastFieldSignature = sig;
              onPartial(fields);
            }
          }
        } else if (ev.event_type === 'error' && ev.error) {
          const err = new Error(ev.error.message || 'Lỗi stream từ Gemini AI.');
          err.status = ev.error.code || 502;
          throw err;
        }
      }

      if (!rawOutput.trim()) {
        throw new Error('Phản hồi từ AI trống.');
      }
      const parsed = parseJsonResponse(rawOutput);
      const validated = AnalysisResultSchema.parse(parsed);
      return attachModelMeta(validated, modelUsed);
    },

    async chat({ apiKey, message, previousInteractionId, history }) {
      const ai = getGenAIClient(apiKey);

      const sendChat = (model, usePreviousId, requestOptions) => {
        const params = {
          model,
          system_instruction: CHAT_SYSTEM_INSTRUCTION,
          input: usePreviousId
            ? message
            : buildChatTranscriptFallbackPrompt(message, history),
          generation_config: buildChatGenerationConfig(model),
          store: true,
        };
        if (usePreviousId && previousInteractionId) {
          params.previous_interaction_id = previousInteractionId;
        }
        return ai.interactions.create(params, requestOptions);
      };

      const { result: interaction, modelUsed } = await runWithModelFallback(
        geminiModel,
        async (model, requestOptions) => {
          const canContinue = Boolean(previousInteractionId) && model === geminiModel;
          if (!canContinue) {
            return sendChat(model, false, requestOptions);
          }
          try {
            return await sendChat(model, true, requestOptions);
          } catch (err) {
            const status = Number(err?.status || err?.statusCode || 0);
            if (status === 400 || status === 404) {
              return sendChat(model, false, requestOptions);
            }
            throw err;
          }
        }
      );

      const reply = extractInteractionText(interaction);
      if (!reply) {
        throw new Error('Trợ lý AI không trả về nội dung.');
      }
      return {
        reply,
        interactionId: interaction.id || null,
        modelUsed,
      };
    },

    async chatStream({ apiKey, message, previousInteractionId, history, onDelta, signal }) {
      const ai = getGenAIClient(apiKey);

      const openChatStream = (model, usePreviousId, requestOptions) => {
        const params = {
          model,
          system_instruction: CHAT_SYSTEM_INSTRUCTION,
          input: usePreviousId
            ? message
            : buildChatTranscriptFallbackPrompt(message, history),
          generation_config: buildChatGenerationConfig(model),
          stream: true,
          store: true,
        };
        if (usePreviousId && previousInteractionId) {
          params.previous_interaction_id = previousInteractionId;
        }
        return ai.interactions.create(params, requestOptions);
      };

      const { result: stream, modelUsed } = await runWithModelFallback(
        geminiModel,
        async (model, requestOptions) => {
          const canContinue = Boolean(previousInteractionId) && model === geminiModel;
          if (!canContinue) {
            return openChatStream(model, false, requestOptions);
          }
          try {
            return await openChatStream(model, true, requestOptions);
          } catch (err) {
            const status = Number(err?.status || err?.statusCode || 0);
            if (status === 400 || status === 404) {
              return openChatStream(model, false, requestOptions);
            }
            throw err;
          }
        }
      );

      let reply = '';
      let interactionId = null;

      for await (const ev of stream) {
        if (signal?.aborted) break;
        if (ev.event_type === 'step.delta' && ev.delta?.type === 'text' && ev.delta.text) {
          reply += ev.delta.text;
          if (typeof onDelta === 'function') {
            onDelta(ev.delta.text);
          }
        } else if (ev.event_type === 'interaction.completed' && ev.interaction?.id) {
          interactionId = ev.interaction.id;
        } else if (ev.event_type === 'interaction.created' && ev.interaction?.id) {
          interactionId = interactionId || ev.interaction.id;
        }
      }

      if (!reply.trim()) {
        throw new Error('Trợ lý AI không trả về nội dung.');
      }
      return { reply, interactionId, modelUsed };
    },
  };

  const aiRunner = options.aiRunner || defaultAiRunner;

  // Bộ nhớ đệm SHA-256 cho nội dung phân tích trùng lặp (< 10ms)
  const analyzeCache = new Map();

  function computeAnalyzeCacheKey(text, image) {
    const hash = crypto.createHash('sha256');
    hash.update(String(geminiModel || ''));
    hash.update('\0');
    hash.update(String(text || '').trim());
    hash.update('\0');
    hash.update(image ? `${image.mimeType}:${image.base64Data}` : '');
    return hash.digest('hex');
  }

  function getCachedAnalysis(cacheKey) {
    const entry = analyzeCache.get(cacheKey);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      analyzeCache.delete(cacheKey);
      return null;
    }
    // LRU touch
    analyzeCache.delete(cacheKey);
    analyzeCache.set(cacheKey, entry);
    return entry;
  }

  function setCachedAnalysis(cacheKey, analysis, modelUsed) {
    if (analyzeCache.size >= ANALYSIS_CACHE_MAX_ENTRIES) {
      const oldestKey = analyzeCache.keys().next().value;
      analyzeCache.delete(oldestKey);
    }
    analyzeCache.set(cacheKey, {
      analysis,
      modelUsed,
      expiresAt: Date.now() + ANALYSIS_CACHE_TTL_MS,
    });
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(
    compression({
      threshold: 512,
      filter: (req, res) => {
        if (req.path.endsWith('/stream') || req.headers.accept === 'text/event-stream') {
          return false;
        }
        return compression.filter(req, res);
      },
    })
  );
  app.use(express.json({ limit: '12mb' }));

  // Header bảo mật cơ bản và tôn trọng chính sách Zero-Identity
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Phục vụ trực tiếp các thư viện UI từ node_modules để tránh phụ thuộc mạng CDN
  app.get('/vendor/chart.umd.min.js', (_req, res) => {
    res.sendFile(
      path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js')
    );
  });
  app.get('/vendor/lucide.min.js', (_req, res) => {
    res.sendFile(
      path.join(__dirname, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js')
    );
  });

  app.use(
    express.static(path.join(__dirname, 'public'), {
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  app.get('/api/health', (_req, res) => {
    const dbOk = db.ping();
    res.json({
      ok: dbOk,
      db: dbOk ? 'connected' : 'error',
      model: geminiModel,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/config/status', (_req, res) => {
    const hasServerKey = Boolean(
      options.geminiApiKey !== undefined
        ? String(options.geminiApiKey).trim()
        : String(process.env.GEMINI_API_KEY || '').trim()
    );
    res.json({
      ok: true,
      serverKeyConfigured: hasServerKey,
      model: geminiModel,
      requestedModelNote: REQUESTED_MODEL_NOTE,
      isDefaultPin,
      demoPinHint: isDefaultPin ? '11092026' : null,
      schoolName: SCHOOL_NAME,
    });
  });

  function validateAnalyzeInput(body) {
    const parsedBody = AnalyzeRequestSchema.safeParse(body);
    if (!parsedBody.success) {
      return { status: 400, code: 'VALIDATION_ERROR', error: 'Dữ liệu gửi lên không hợp lệ.' };
    }
    const text = (parsedBody.data.text || '').trim();
    const rawImage = parsedBody.data.imageDataUrl || null;
    if (!text && !rawImage) {
      return {
        status: 400,
        code: 'EMPTY_INPUT',
        error:
          'Vui lòng nhập nội dung tin nhắn/bình luận hoặc đính kèm ảnh chụp màn hình để AI phân tích.',
      };
    }
    let parsedImage = null;
    if (rawImage) {
      try {
        parsedImage = parseImageDataUrl(rawImage, MAX_IMAGE_BYTES);
      } catch (err) {
        return {
          status: err.status || 400,
          code: 'INVALID_IMAGE',
          error: err.message,
        };
      }
    }
    const apiKey = resolveServerApiKey();
    if (!apiKey) {
      return {
        status: 503,
        code: 'MISSING_API_KEY',
        error:
          'Dịch vụ phân tích AI trên máy chủ chưa được cấu hình GEMINI_API_KEY trong tệp .env. Vui lòng liên hệ quản trị viên hệ thống.',
      };
    }
    return { ok: true, text, parsedImage, apiKey };
  }

  function initSseResponse(res) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }
  }

  function attachSseAbort(res) {
    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished && !res.writableEnded) {
        abortController.abort();
      }
    });
    return abortController;
  }

  function sendSseEvent(res, eventName, payload) {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    if (typeof res.flush === 'function') {
      res.flush();
    }
  }

  app.post('/api/analyze', async (req, res) => {
    const startedAt = Date.now();
    const checked = validateAnalyzeInput(req.body);
    if (!checked.ok) {
      return res.status(checked.status).json({
        ok: false,
        code: checked.code,
        error: checked.error,
      });
    }

    const { text, parsedImage, apiKey } = checked;
    const cacheKey = computeAnalyzeCacheKey(text, parsedImage);
    const cachedHit = getCachedAnalysis(cacheKey);
    if (cachedHit) {
      return res.json({
        ok: true,
        cached: true,
        latencyMs: Date.now() - startedAt,
        modelUsed: cachedHit.modelUsed,
        analysis: cachedHit.analysis,
      });
    }

    try {
      const analysis = await aiRunner.analyze({
        apiKey,
        text,
        image: parsedImage,
      });
      const modelUsed = analysis?.__modelUsed || geminiModel;
      setCachedAnalysis(cacheKey, analysis, modelUsed);
      return res.json({
        ok: true,
        cached: false,
        latencyMs: Date.now() - startedAt,
        modelUsed,
        analysis,
      });
    } catch (error) {
      const mapped = classifyGeminiError(error);
      return res.status(mapped.status).json({
        ok: false,
        code: mapped.code,
        error: mapped.message,
      });
    }
  });

  app.post('/api/analyze/stream', async (req, res) => {
    const startedAt = Date.now();
    const checked = validateAnalyzeInput(req.body);
    if (!checked.ok) {
      return res.status(checked.status).json({
        ok: false,
        code: checked.code,
        error: checked.error,
      });
    }

    const { text, parsedImage, apiKey } = checked;
    initSseResponse(res);

    const abortController = attachSseAbort(res);

    const elapsed = () => Date.now() - startedAt;

    const cacheKey = computeAnalyzeCacheKey(text, parsedImage);
    const cachedHit = getCachedAnalysis(cacheKey);
    if (cachedHit) {
      sendSseEvent(res, 'stage', {
        step: 'cache_hit',
        label: 'Tìm thấy kết quả tức thì từ bộ nhớ đệm SHA-256...',
        percent: 96,
        elapsedMs: elapsed(),
      });
      sendSseEvent(res, 'done', {
        ok: true,
        cached: true,
        latencyMs: elapsed(),
        modelUsed: cachedHit.modelUsed,
        analysis: cachedHit.analysis,
      });
      return res.end();
    }

    sendSseEvent(res, 'stage', {
      step: 'scanning',
      label: parsedImage
        ? 'AI đang quét hình ảnh & đọc ngữ cảnh tin nhắn...'
        : 'AI đang quét ngữ cảnh & tín hiệu tâm lý...',
      percent: 45,
      elapsedMs: elapsed(),
    });

    try {
      let sentFirstAidStage = false;
      let analysis;

      if (typeof aiRunner.analyzeStream === 'function') {
        analysis = await aiRunner.analyzeStream({
          apiKey,
          text,
          image: parsedImage,
          signal: abortController.signal,
          onPartial: (fields) => {
            if (!sentFirstAidStage && fields.psychological_first_aid) {
              sentFirstAidStage = true;
              sendSseEvent(res, 'stage', {
                step: 'first_aid',
                label: 'Đang hoàn tất sơ cứu tâm lý & kịch bản ứng phó...',
                percent: 86,
                elapsedMs: elapsed(),
              });
            }
            sendSseEvent(res, 'partial', {
              fields,
              elapsedMs: elapsed(),
            });
          },
        });
      } else {
        analysis = await aiRunner.analyze({
          apiKey,
          text,
          image: parsedImage,
        });
      }

      if (abortController.signal.aborted) return res.end();

      const modelUsed = analysis?.__modelUsed || geminiModel;
      setCachedAnalysis(cacheKey, analysis, modelUsed);

      sendSseEvent(res, 'stage', {
        step: 'done',
        label: 'Hoàn tất phân tích & sơ cứu tâm lý',
        percent: 100,
        elapsedMs: elapsed(),
      });
      sendSseEvent(res, 'done', {
        ok: true,
        cached: false,
        latencyMs: elapsed(),
        modelUsed,
        analysis,
      });
      return res.end();
    } catch (error) {
      if (abortController.signal.aborted) return res.end();
      const mapped = classifyGeminiError(error);
      sendSseEvent(res, 'error', {
        ok: false,
        status: mapped.status,
        code: mapped.code,
        error: mapped.message,
      });
      return res.end();
    }
  });

  app.post('/api/tickets', (req, res) => {
    const parsedBody = CreateTicketSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: 'Thông tin hồ sơ không đầy đủ hoặc không hợp lệ.',
      });
    }

    const { grade_level, reported_text, student_note, evidence_image, analysis } =
      parsedBody.data;

    let normalizedImage = null;
    if (evidence_image) {
      try {
        normalizedImage = parseImageDataUrl(
          evidence_image,
          MAX_STORED_IMAGE_BYTES
        ).normalizedDataUrl;
      } catch (err) {
        return res.status(err.status || 400).json({
          ok: false,
          code: 'INVALID_IMAGE',
          error: err.message,
        });
      }
    }

    if (!reported_text.trim() && !normalizedImage && !student_note.trim()) {
      return res.status(400).json({
        ok: false,
        code: 'EMPTY_REPORT',
        error: 'Hồ sơ cần có nội dung hoặc ảnh bằng chứng kèm theo.',
      });
    }

    const ticket = db.createTicket({
      grade_level,
      reported_text: reported_text.trim(),
      student_note: student_note.trim(),
      evidence_image: normalizedImage,
      risk_level: analysis.risk_level,
      category: analysis.category,
      confidence_score: analysis.confidence_score,
      evidence_excerpt: analysis.evidence_excerpt || '',
      detected_signals: analysis.detected_signals,
      legal_psych_impact: analysis.legal_psych_impact || '',
      psychological_first_aid: analysis.psychological_first_aid,
      actionable_steps: analysis.actionable_steps,
    });

    return res.status(201).json({
      ok: true,
      ticket: {
        ticket_code: ticket.ticket_code,
        grade_level: ticket.grade_level,
        risk_level: ticket.risk_level,
        category: ticket.category,
        status: ticket.status,
        created_at: ticket.created_at,
      },
    });
  });

  app.get('/api/tickets/:code', (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!TICKET_CODE_REGEX.test(code)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_TICKET_CODE',
        error: 'Mã hồ sơ không đúng định dạng (ví dụ: SH-8F3K2P).',
      });
    }

    const result = db.getTicketWithMessages(code);
    if (!result) {
      return res.status(404).json({
        ok: false,
        code: 'NOT_FOUND',
        error: 'Không tìm thấy hồ sơ với mã này. Vui lòng kiểm tra lại.',
      });
    }

    return res.json({
      ok: true,
      ticket: result.ticket,
      messages: result.messages,
    });
  });

  app.post('/api/tickets/:code/messages', (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!TICKET_CODE_REGEX.test(code)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_TICKET_CODE',
        error: 'Mã hồ sơ không đúng định dạng (ví dụ: SH-8F3K2P).',
      });
    }

    const parsed = MessageInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: parsed.error.issues[0]?.message || 'Nội dung tin nhắn không hợp lệ.',
      });
    }

    const added = db.addMessage(code, 'STUDENT', parsed.data.content);
    if (!added) {
      return res.status(404).json({
        ok: false,
        code: 'NOT_FOUND',
        error: 'Không tìm thấy hồ sơ với mã này.',
      });
    }

    return res.status(201).json({
      ok: true,
      message: added.message,
      status: added.status,
      updated_at: added.updated_at,
    });
  });

  app.post('/api/chat', async (req, res) => {
    const startedAt = Date.now();
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: parsed.error.issues[0]?.message || 'Câu hỏi không hợp lệ.',
      });
    }

    const apiKey = resolveServerApiKey();
    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        code: 'MISSING_API_KEY',
        error:
          'Dịch vụ Trợ lý AI trên máy chủ chưa được cấu hình GEMINI_API_KEY trong tệp .env. Vui lòng liên hệ quản trị viên hệ thống.',
      });
    }

    try {
      const result = await aiRunner.chat({
        apiKey,
        message: parsed.data.message,
        previousInteractionId: parsed.data.previousInteractionId || null,
        history: parsed.data.history || [],
      });
      return res.json({
        ok: true,
        latencyMs: Date.now() - startedAt,
        modelUsed: result.modelUsed || geminiModel,
        reply: result.reply,
        interactionId: result.interactionId,
      });
    } catch (error) {
      const mapped = classifyGeminiError(error);
      return res.status(mapped.status).json({
        ok: false,
        code: mapped.code,
        error: mapped.message,
      });
    }
  });

  app.post('/api/chat/stream', async (req, res) => {
    const startedAt = Date.now();
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: parsed.error.issues[0]?.message || 'Câu hỏi không hợp lệ.',
      });
    }

    const apiKey = resolveServerApiKey();
    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        code: 'MISSING_API_KEY',
        error:
          'Dịch vụ Trợ lý AI trên máy chủ chưa được cấu hình GEMINI_API_KEY trong tệp .env. Vui lòng liên hệ quản trị viên hệ thống.',
      });
    }

    initSseResponse(res);
    const abortController = attachSseAbort(res);

    try {
      let result;
      if (typeof aiRunner.chatStream === 'function') {
        result = await aiRunner.chatStream({
          apiKey,
          message: parsed.data.message,
          previousInteractionId: parsed.data.previousInteractionId || null,
          history: parsed.data.history || [],
          signal: abortController.signal,
          onDelta: (deltaText) => {
            sendSseEvent(res, 'delta', { text: deltaText });
          },
        });
      } else {
        result = await aiRunner.chat({
          apiKey,
          message: parsed.data.message,
          previousInteractionId: parsed.data.previousInteractionId || null,
          history: parsed.data.history || [],
        });
        sendSseEvent(res, 'delta', { text: result.reply });
      }

      if (abortController.signal.aborted) return res.end();
      sendSseEvent(res, 'done', {
        ok: true,
        latencyMs: Date.now() - startedAt,
        modelUsed: result.modelUsed || geminiModel,
        reply: result.reply,
        interactionId: result.interactionId,
      });
      return res.end();
    } catch (error) {
      if (abortController.signal.aborted) return res.end();
      const mapped = classifyGeminiError(error);
      sendSseEvent(res, 'error', {
        ok: false,
        status: mapped.status,
        code: mapped.code,
        error: mapped.message,
      });
      return res.end();
    }
  });

  // --- Phân hệ B: Không gian Tổ Tư vấn Tâm lý (Protected by PIN -> Bearer Token) ---
  app.post('/api/counselor/login', (req, res) => {
    const pin = String(req.body?.pin || '').trim();
    if (!pin) {
      return res.status(400).json({
        ok: false,
        code: 'MISSING_PIN',
        error: 'Vui lòng nhập mã PIN Tổ Tư vấn.',
      });
    }

    if (!constantTimeEquals(pin, adminPin)) {
      return res.status(401).json({
        ok: false,
        code: 'INVALID_PIN',
        error: 'Mã PIN không chính xác. Vui lòng thử lại.',
      });
    }

    return res.json({
      ok: true,
      token: signCounselorToken(),
      expiresInSeconds: 12 * 60 * 60,
    });
  });

  app.get('/api/counselor/dashboard', requireCounselor, (req, res) => {
    const statusFilter = String(req.query.status || '').trim().toUpperCase();
    const tickets = db.listTicketsPrioritized(statusFilter);
    const analytics = db.getAnalytics();
    res.json({
      ok: true,
      analytics,
      tickets,
    });
  });

  app.get('/api/counselor/tickets/:code', requireCounselor, (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!TICKET_CODE_REGEX.test(code)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_TICKET_CODE',
        error: 'Mã hồ sơ không hợp lệ.',
      });
    }

    const result = db.getTicketWithMessages(code);
    if (!result) {
      return res.status(404).json({
        ok: false,
        code: 'NOT_FOUND',
        error: 'Không tìm thấy hồ sơ.',
      });
    }

    return res.json({
      ok: true,
      ticket: result.ticket,
      messages: result.messages,
    });
  });

  app.patch('/api/counselor/tickets/:code/status', requireCounselor, (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!TICKET_CODE_REGEX.test(code)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_TICKET_CODE',
        error: 'Mã hồ sơ không hợp lệ.',
      });
    }

    const parsed = StatusUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: 'Trạng thái cập nhật không hợp lệ.',
      });
    }

    const updated = db.updateTicketStatus(code, parsed.data.status);
    if (!updated) {
      return res.status(404).json({
        ok: false,
        code: 'NOT_FOUND',
        error: 'Không tìm thấy hồ sơ.',
      });
    }

    return res.json({
      ok: true,
      ticket: updated,
    });
  });

  app.post('/api/counselor/tickets/:code/messages', requireCounselor, (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!TICKET_CODE_REGEX.test(code)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_TICKET_CODE',
        error: 'Mã hồ sơ không hợp lệ.',
      });
    }

    const parsed = MessageInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: parsed.error.issues[0]?.message || 'Nội dung phản hồi không hợp lệ.',
      });
    }

    const added = db.addMessage(code, 'COUNSELOR', parsed.data.content);
    if (!added) {
      return res.status(404).json({
        ok: false,
        code: 'NOT_FOUND',
        error: 'Không tìm thấy hồ sơ.',
      });
    }

    return res.status(201).json({
      ok: true,
      message: added.message,
      status: added.status,
      updated_at: added.updated_at,
    });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({
      ok: false,
      code: 'NOT_FOUND',
      error: 'Endpoint không tồn tại.',
    });
  });

  // Fallback SPA route
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Global error handler
  app.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({
        ok: false,
        code: 'PAYLOAD_TOO_LARGE',
        error: 'Dung lượng ảnh hoặc dữ liệu gửi lên vượt quá giới hạn cho phép.',
      });
    }
    return res.status(err?.status || 500).json({
      ok: false,
      code: 'INTERNAL_ERROR',
      error: 'Đã xảy ra lỗi hệ thống. Vui lòng thử lại.',
    });
  });

  return { app, db };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT || 3000);
  const { app, db } = createApp();
  const server = app.listen(PORT, () => {
    console.log(
      `SafeSchool AI (Lá chắn Số Học đường) đang chạy tại http://localhost:${PORT} | Model: ${DEFAULT_MODEL}`
    );
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp, parseImageDataUrl, ANALYSIS_RESPONSE_SCHEMA };
