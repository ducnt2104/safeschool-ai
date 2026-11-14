const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const ALLOWED_GRADES = new Set(['10', '11', '12', 'ANONYMOUS']);
const ALLOWED_RISKS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const ALLOWED_STATUSES = new Set(['PENDING', 'IN_PROGRESS', 'RESOLVED']);
const TICKET_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createDatabase(dbFilePath) {
  const resolvedPath =
    dbFilePath || process.env.DB_PATH || path.join(__dirname, 'data', 'safeschool.db');

  if (resolvedPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Khởi tạo schema sạch, tuyệt đối KHÔNG chèn dữ liệu mẫu/giả (Zero Mock Data)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_code TEXT NOT NULL UNIQUE,
      grade_level TEXT NOT NULL DEFAULT 'ANONYMOUS'
        CHECK (grade_level IN ('10', '11', '12', 'ANONYMOUS')),
      reported_text TEXT,
      student_note TEXT,
      evidence_image TEXT,
      risk_level TEXT NOT NULL
        CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
      category TEXT NOT NULL,
      confidence_score INTEGER NOT NULL,
      evidence_excerpt TEXT NOT NULL DEFAULT '',
      detected_signals TEXT NOT NULL,
      legal_psych_impact TEXT NOT NULL DEFAULT '',
      psychological_first_aid TEXT NOT NULL,
      actionable_steps_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'IN_PROGRESS', 'RESOLVED')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_code TEXT NOT NULL,
      sender_role TEXT NOT NULL CHECK (sender_role IN ('STUDENT', 'COUNSELOR')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (ticket_code) REFERENCES tickets(ticket_code) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_risk_created
      ON tickets(risk_level, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_tickets_status_created
      ON tickets(status, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_messages_ticket_created
      ON messages(ticket_code, created_at ASC);
  `);

  // Di trú an toàn cho tệp SQLite đã tồn tại trước bản nâng cấp
  const existingCols = new Set(
    db.prepare('PRAGMA table_info(tickets)').all().map((col) => col.name)
  );
  if (!existingCols.has('evidence_excerpt')) {
    db.exec("ALTER TABLE tickets ADD COLUMN evidence_excerpt TEXT NOT NULL DEFAULT ''");
  }
  if (!existingCols.has('legal_psych_impact')) {
    db.exec("ALTER TABLE tickets ADD COLUMN legal_psych_impact TEXT NOT NULL DEFAULT ''");
  }

  function generateTicketCode() {
    const bytes = crypto.randomBytes(6);
    let suffix = '';
    for (let i = 0; i < 6; i += 1) {
      suffix += TICKET_CODE_ALPHABET[bytes[i] % TICKET_CODE_ALPHABET.length];
    }
    return `SH-${suffix}`;
  }

  function hydrateTicket(row) {
    if (!row) return null;
    let actionableSteps = [];
    try {
      const parsed = JSON.parse(row.actionable_steps_json);
      if (Array.isArray(parsed)) actionableSteps = parsed;
    } catch {
      actionableSteps = [];
    }
    return {
      ticket_code: row.ticket_code,
      grade_level: row.grade_level,
      reported_text: row.reported_text || '',
      student_note: row.student_note || '',
      has_image: Boolean(row.evidence_image),
      evidence_image: row.evidence_image || null,
      risk_level: row.risk_level,
      category: row.category,
      confidence_score: row.confidence_score,
      evidence_excerpt: row.evidence_excerpt || '',
      detected_signals: row.detected_signals,
      legal_psych_impact: row.legal_psych_impact || '',
      psychological_first_aid: row.psychological_first_aid,
      actionable_steps: actionableSteps,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  const insertTicketStmt = db.prepare(`
    INSERT INTO tickets (
      ticket_code,
      grade_level,
      reported_text,
      student_note,
      evidence_image,
      risk_level,
      category,
      confidence_score,
      evidence_excerpt,
      detected_signals,
      legal_psych_impact,
      psychological_first_aid,
      actionable_steps_json,
      status
    ) VALUES (
      @ticket_code,
      @grade_level,
      @reported_text,
      @student_note,
      @evidence_image,
      @risk_level,
      @category,
      @confidence_score,
      @evidence_excerpt,
      @detected_signals,
      @legal_psych_impact,
      @psychological_first_aid,
      @actionable_steps_json,
      'PENDING'
    )
  `);

  const insertMessageStmt = db.prepare(`
    INSERT INTO messages (ticket_code, sender_role, content)
    VALUES (@ticket_code, @sender_role, @content)
  `);

  const getTicketByCodeStmt = db.prepare(`
    SELECT * FROM tickets WHERE ticket_code = ?
  `);

  const getMessagesByTicketStmt = db.prepare(`
    SELECT id, ticket_code, sender_role, content, created_at
    FROM messages
    WHERE ticket_code = ?
    ORDER BY datetime(created_at) ASC, id ASC
  `);

  const touchTicketStmt = db.prepare(`
    UPDATE tickets
    SET updated_at = datetime('now')
    WHERE ticket_code = ?
  `);

  const updateTicketStatusStmt = db.prepare(`
    UPDATE tickets
    SET status = @status, updated_at = datetime('now')
    WHERE ticket_code = @ticket_code
  `);

  const createTicketTx = db.transaction((payload) => {
    const gradeLevel = ALLOWED_GRADES.has(payload.grade_level)
      ? payload.grade_level
      : 'ANONYMOUS';

    if (!ALLOWED_RISKS.has(payload.risk_level)) {
      throw new Error('Mức độ rủi ro không hợp lệ.');
    }

    let ticketCode = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = generateTicketCode();
      const existing = getTicketByCodeStmt.get(candidate);
      if (!existing) {
        ticketCode = candidate;
        break;
      }
    }
    if (!ticketCode) {
      throw new Error('Không thể cấp mã hồ sơ duy nhất, vui lòng thử lại.');
    }

    insertTicketStmt.run({
      ticket_code: ticketCode,
      grade_level: gradeLevel,
      reported_text: payload.reported_text || null,
      student_note: payload.student_note || null,
      evidence_image: payload.evidence_image || null,
      risk_level: payload.risk_level,
      category: payload.category,
      confidence_score: Math.round(payload.confidence_score),
      evidence_excerpt: payload.evidence_excerpt || '',
      detected_signals: payload.detected_signals,
      legal_psych_impact: payload.legal_psych_impact || '',
      psychological_first_aid: payload.psychological_first_aid,
      actionable_steps_json: JSON.stringify(payload.actionable_steps || []),
    });

    if (payload.student_note && payload.student_note.trim()) {
      insertMessageStmt.run({
        ticket_code: ticketCode,
        sender_role: 'STUDENT',
        content: payload.student_note.trim(),
      });
    }

    return hydrateTicket(getTicketByCodeStmt.get(ticketCode));
  });

  const addMessageTx = db.transaction((ticketCode, senderRole, content) => {
    const ticket = getTicketByCodeStmt.get(ticketCode);
    if (!ticket) return null;

    const info = insertMessageStmt.run({
      ticket_code: ticketCode,
      sender_role: senderRole,
      content: content.trim(),
    });

    if (senderRole === 'COUNSELOR' && ticket.status === 'PENDING') {
      updateTicketStatusStmt.run({ ticket_code: ticketCode, status: 'IN_PROGRESS' });
    } else {
      touchTicketStmt.run(ticketCode);
    }

    const createdMessage = db
      .prepare('SELECT id, ticket_code, sender_role, content, created_at FROM messages WHERE id = ?')
      .get(info.lastInsertRowid);

    const updatedTicket = getTicketByCodeStmt.get(ticketCode);
    return {
      message: createdMessage,
      status: updatedTicket.status,
      updated_at: updatedTicket.updated_at,
    };
  });

  return {
    db,
    dbPath: resolvedPath,

    ping() {
      const row = db.prepare('SELECT 1 AS ok').get();
      return Boolean(row && row.ok === 1);
    },

    createTicket(payload) {
      return createTicketTx(payload);
    },

    getTicketWithMessages(rawCode) {
      const code = String(rawCode || '').trim().toUpperCase();
      const ticket = hydrateTicket(getTicketByCodeStmt.get(code));
      if (!ticket) return null;
      const messages = getMessagesByTicketStmt.all(code);
      return { ticket, messages };
    },

    addMessage(rawCode, senderRole, content) {
      const code = String(rawCode || '').trim().toUpperCase();
      return addMessageTx(code, senderRole, content);
    },

    updateTicketStatus(rawCode, newStatus) {
      const code = String(rawCode || '').trim().toUpperCase();
      if (!ALLOWED_STATUSES.has(newStatus)) {
        throw new Error('Trạng thái xử lý không hợp lệ.');
      }
      const res = updateTicketStatusStmt.run({ ticket_code: code, status: newStatus });
      if (res.changes === 0) return null;
      return hydrateTicket(getTicketByCodeStmt.get(code));
    },

    listTicketsPrioritized(statusFilter) {
      const hasValidFilter = statusFilter && ALLOWED_STATUSES.has(statusFilter);
      const whereClause = hasValidFilter ? 'WHERE t.status = ?' : '';
      const sql = `
        SELECT
          t.ticket_code,
          t.grade_level,
          t.reported_text,
          t.student_note,
          CASE WHEN t.evidence_image IS NOT NULL THEN 1 ELSE 0 END AS has_image,
          t.risk_level,
          t.category,
          t.confidence_score,
          t.evidence_excerpt,
          t.detected_signals,
          t.legal_psych_impact,
          t.status,
          t.created_at,
          t.updated_at,
          (SELECT COUNT(*) FROM messages m WHERE m.ticket_code = t.ticket_code) AS message_count,
          (
            SELECT m.content
            FROM messages m
            WHERE m.ticket_code = t.ticket_code
            ORDER BY datetime(m.created_at) DESC, m.id DESC
            LIMIT 1
          ) AS last_message_preview
        FROM tickets t
        ${whereClause}
        ORDER BY
          CASE t.risk_level
            WHEN 'CRITICAL' THEN 1
            WHEN 'HIGH' THEN 2
            WHEN 'MEDIUM' THEN 3
            WHEN 'LOW' THEN 4
            ELSE 5
          END ASC,
          datetime(t.created_at) DESC,
          t.id DESC
      `;
      const stmt = db.prepare(sql);
      return hasValidFilter ? stmt.all(statusFilter) : stmt.all();
    },

    getAnalytics() {
      const totalRow = db.prepare('SELECT COUNT(*) AS total FROM tickets').get();
      const total = totalRow ? totalRow.total : 0;

      const byStatus = { PENDING: 0, IN_PROGRESS: 0, RESOLVED: 0 };
      const statusRows = db
        .prepare('SELECT status, COUNT(*) AS count FROM tickets GROUP BY status')
        .all();
      for (const row of statusRows) {
        if (Object.hasOwn(byStatus, row.status)) {
          byStatus[row.status] = row.count;
        }
      }

      const byRisk = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
      const riskRows = db
        .prepare('SELECT risk_level, COUNT(*) AS count FROM tickets GROUP BY risk_level')
        .all();
      for (const row of riskRows) {
        if (Object.hasOwn(byRisk, row.risk_level)) {
          byRisk[row.risk_level] = row.count;
        }
      }

      const byCategory = db
        .prepare(
          `SELECT category, COUNT(*) AS count
           FROM tickets
           GROUP BY category
           ORDER BY count DESC, category ASC`
        )
        .all();

      const totalMessagesRow = db.prepare('SELECT COUNT(*) AS count FROM messages').get();

      return {
        total,
        totalMessages: totalMessagesRow ? totalMessagesRow.count : 0,
        byStatus,
        byRisk,
        byCategory,
      };
    },

    close() {
      db.close();
    },
  };
}

if (require.main === module) {
  require('dotenv').config();
  const targetDbPath = process.argv[2];
  const store = createDatabase(targetDbPath);
  try {
    const schemaRows = store.db
      .prepare(
        `SELECT type, name
         FROM sqlite_master
         WHERE type IN ('table', 'index')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY type DESC, name ASC`
      )
      .all();

    const tables = schemaRows.filter((row) => row.type === 'table').map((row) => row.name);
    const indexes = schemaRows.filter((row) => row.type === 'index').map((row) => row.name);
    const analytics = store.getAnalytics();

    store.db.pragma('wal_checkpoint(TRUNCATE)');
    console.log(`[SQLite] Khởi tạo thành công: ${store.dbPath}`);
    console.log(`[SQLite] Tables (${tables.length}): ${tables.join(', ')}`);
    console.log(`[SQLite] Indexes (${indexes.length}): ${indexes.join(', ')}`);
    console.log(
      `[SQLite] Rows (Zero Mock Data): tickets=${analytics.total}, messages=${analytics.totalMessages}`
    );
  } finally {
    store.close();
  }
}

module.exports = { createDatabase };
