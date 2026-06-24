// ══════════════════════════════════════════════════════════
//  db.js — Database Layer (SQLite via sql.js)
//  Digital Exchange Management System — Phase 01
//  Schema covers ALL phases (01–08) — built once, used always
// ══════════════════════════════════════════════════════════

const DB = (() => {

  let _db = null;
  const DB_KEY = 'dems_sqlite_db';

  // ── SCHEMA ──────────────────────────────────────────────
  // All tables defined upfront. Phases use what they need.
  const SCHEMA = `

    -- ── PHASE 01: App Settings & Profile ─────────────────
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- ── PHASE 01: Audit Log ──────────────────────────────
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT NOT NULL,
      detail      TEXT DEFAULT '',
      timestamp   TEXT NOT NULL,
      platform    TEXT DEFAULT '',
      user_agent  TEXT DEFAULT ''
    );

    -- ── PHASE 02 + 03: Transactions (Tamper-Proof) ───────
    -- CRITICAL: No UPDATE or DELETE ever issued on this table
    CREATE TABLE IF NOT EXISTS transactions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number  TEXT UNIQUE NOT NULL,       -- EXC-YYYY-NNNNN
      order_id        TEXT DEFAULT '',            -- Bitget order ID
      txn_type        TEXT NOT NULL,              -- 'buy' | 'sell'
      amount_pkr      REAL NOT NULL,
      exchange_rate   REAL NOT NULL,
      amount_usdt     REAL,
      client_name     TEXT DEFAULT '',
      client_cnic     TEXT DEFAULT '',
      bank_name       TEXT DEFAULT '',
      bank_last4      TEXT DEFAULT '',
      payment_ref     TEXT DEFAULT '',
      notes           TEXT DEFAULT '',
      screenshot_path TEXT DEFAULT '',
      timestamp       TEXT NOT NULL,              -- UTC timestamp, system generated
      hash            TEXT NOT NULL,              -- SHA-256 of this record
      prev_hash       TEXT NOT NULL DEFAULT '0',  -- Hash chain link
      chain_index     INTEGER NOT NULL DEFAULT 0, -- Position in chain
      is_locked       INTEGER NOT NULL DEFAULT 1, -- Always 1 after insert
      clock_unverified INTEGER NOT NULL DEFAULT 0, -- 1 if device clock could not be checked against network time at submit
      cost_rate       REAL,                        -- Optional: rate the exchange trades at with its liquidity provider
      profit_pkr      REAL,                        -- Optional: profit/loss in PKR for this transaction
      hash_version    TEXT NOT NULL DEFAULT 'DEMS-v1' -- Which fieldOrder this record's hash was built with (DEMS-v1 or DEMS-v2)
    );

    -- ── PHASE 04: Receipts ───────────────────────────────
    CREATE TABLE IF NOT EXISTS receipts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number TEXT UNIQUE NOT NULL,
      txn_id         INTEGER NOT NULL REFERENCES transactions(id),
      pdf_path       TEXT DEFAULT '',
      generated_at   TEXT NOT NULL,
      qr_data        TEXT DEFAULT '',
      print_count    INTEGER DEFAULT 0,
      share_count    INTEGER DEFAULT 0
    );

    -- ── PHASE 05: Client KYC ────────────────────────────
    CREATE TABLE IF NOT EXISTS clients (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      cnic             TEXT UNIQUE,
      full_name        TEXT NOT NULL,
      phone            TEXT DEFAULT '',
      whatsapp         TEXT DEFAULT '',
      bank_name        TEXT DEFAULT '',
      bank_account     TEXT DEFAULT '',
      bank_last4       TEXT DEFAULT '',
      is_verified      INTEGER DEFAULT 0,
      is_flagged       INTEGER DEFAULT 0,
      flag_reason      TEXT DEFAULT '',
      total_txns       INTEGER DEFAULT 0,
      total_volume_pkr REAL DEFAULT 0,
      first_txn_date   TEXT DEFAULT '',
      last_txn_date    TEXT DEFAULT '',
      notes            TEXT DEFAULT '',
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );

    -- ── PHASE 07: Verification Log ───────────────────────
    CREATE TABLE IF NOT EXISTS verification_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number  TEXT NOT NULL,
      verified_at     TEXT NOT NULL,
      result          TEXT NOT NULL,  -- 'ORIGINAL' | 'TAMPERED' | 'NOT_FOUND'
      verifier_ip     TEXT DEFAULT '',
      user_agent      TEXT DEFAULT ''
    );

    -- ── PHASE 08: Backup Log ─────────────────────────────
    CREATE TABLE IF NOT EXISTS backup_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      backup_type TEXT NOT NULL,  -- 'cloud' | 'local' | 'auto'
      status      TEXT NOT NULL,  -- 'success' | 'failed'
      file_size   INTEGER DEFAULT 0,
      backed_up_at TEXT NOT NULL,
      notes       TEXT DEFAULT ''
    );

    -- ── SEC-FIX 2: Login Lockout (moved from localStorage) ──
    -- Single-row table (id=1 always) tracking failed-login state.
    -- Stored in SQLite so lockout survives incognito tabs and clears
    -- of localStorage; auth.js is the sole writer.
    CREATE TABLE IF NOT EXISTS login_lockout (
      id           INTEGER PRIMARY KEY,
      failed_count INTEGER NOT NULL DEFAULT 0,
      lockout_until TEXT,
      updated_at   TEXT NOT NULL
    );
    INSERT OR IGNORE INTO login_lockout (id, failed_count, updated_at) VALUES (1, 0, '');

    -- ── INDEXES for performance ──────────────────────────
    CREATE INDEX IF NOT EXISTS idx_txn_date    ON transactions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_txn_type    ON transactions(txn_type);
    CREATE INDEX IF NOT EXISTS idx_txn_client  ON transactions(client_name);
    CREATE INDEX IF NOT EXISTS idx_txn_receipt ON transactions(receipt_number);
    CREATE INDEX IF NOT EXISTS idx_client_cnic ON clients(cnic);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_verify_receipt ON verification_log(receipt_number);

    -- ── INTEGRITY: chain_index must be unique ────────────
    CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_chain_unique ON transactions(chain_index);

    -- ── PHASE 01 (scalability): Transaction Attachments ──
    -- Stores receipt screenshots and image attachments separately
    -- from the main transactions table so that large base64 blobs
    -- do not bloat the core transaction rows that the hash engine,
    -- chain checker, and reports scan on every page load.
    --
    -- screenshot_path on transactions continues to hold 'attachment:<id>'
    -- for new rows, or the legacy data-URI for rows inserted before this
    -- migration.  attachment_id is a fast FK shortcut (nullable so that
    -- existing rows and rows without screenshots are unaffected).
    CREATE TABLE IF NOT EXISTS attachments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      txn_id      INTEGER NOT NULL,
      mime_type   TEXT    NOT NULL DEFAULT 'image/jpeg',
      base64_data TEXT    NOT NULL,
      uploaded_at TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_att_txn ON attachments(txn_id);

  `;

  // ── PERSISTENCE ─────────────────────────────────────────

  // _pendingSave: timer handle for the trailing debounce.
  // _saveImmediate: the real synchronous export used by flush paths.
  let _pendingSave = null;

  function _saveImmediate() {
    if (!_db) return;
    try {
      const data = _db.export();
      let binaryStr = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < data.length; i += CHUNK) {
        binaryStr += String.fromCharCode.apply(null, data.subarray(i, i + CHUNK));
      }
      localStorage.setItem(DB_KEY, btoa(binaryStr));
    } catch (e) {
      console.error('DB save error:', e);
      if (e.name === 'QuotaExceededError' || (e.message && e.message.includes('quota'))) {
        const banner = document.createElement('div');
        banner.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:999999;display:flex;align-items:center;justify-content:center;flex-direction:column;color:#fff;font-family:sans-serif;padding:40px;text-align:center;';
        banner.innerHTML = '<div style="font-size:48px;margin-bottom:16px;">🚨</div><h1 style="color:#ef4444;margin-bottom:16px;">STORAGE FULL — DATA NOT SAVED</h1><p style="max-width:500px;line-height:1.6;color:#fca5a5;">Browser storage is full. The last database changes were NOT persisted. Please go to Settings → Backup and create an encrypted backup immediately, then clear old data.</p><a href="backup.html" style="margin-top:24px;background:#ef4444;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;">Go to Backup Now</a>';
        document.body.appendChild(banner);
      }
    }
  }

  // saveToStorage() — debounced, trailing-edge, 2-second window.
  // Multiple DB.run() calls fired in quick succession (e.g. inserting a
  // transaction + its attachment) coalesce into a single export, which
  // avoids serialising the full SQLite file on every individual INSERT.
  //
  // The _pendingSave flag also lets flushStorage() cancel the pending
  // timer and write synchronously when the page is about to unload.
  function saveToStorage() {
    if (_pendingSave !== null) {
      clearTimeout(_pendingSave);
    }
    _pendingSave = setTimeout(() => {
      _pendingSave = null;
      _saveImmediate();
    }, 2000);
  }

  // flushStorage() — cancels any pending debounce and writes immediately.
  // Called on beforeunload / visibilitychange-to-hidden to guarantee no
  // in-flight writes are lost when the tab closes or navigates away.
  function flushStorage() {
    if (_pendingSave !== null) {
      clearTimeout(_pendingSave);
      _pendingSave = null;
    }
    _saveImmediate();
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (!raw) return null;
      if (raw.charAt(0) === '[') {
        return new Uint8Array(JSON.parse(raw));
      }
      const binaryStr = atob(raw);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      return bytes;
    } catch {
      return null;
    }
  }

  // Auto-save every 30 seconds (belt-and-suspenders on top of the debounce)
  setInterval(flushStorage, 30000);

  // Flush before tab closes / navigates away
  window.addEventListener('beforeunload', flushStorage);

  // Also flush when the tab becomes hidden (mobile background, alt-tab, etc.)
  // This fires more reliably than beforeunload on mobile browsers.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushStorage();
  });

  return {

    /**
     * init()
     * Must be called before anything else.
     * Loads sql.js, restores existing DB or creates fresh one.
     */
    async init() {
      if (_db) return _db;

      // Load sql.js from CDN
      await new Promise((resolve, reject) => {
        if (window.SQL) { resolve(); return; }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });

      const SQL = await window.initSqlJs({
        locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${file}`
      });

      // Restore existing DB or create new
      const existing = loadFromStorage();
      if (existing) {
        _db = new SQL.Database(existing);
      } else {
        _db = new SQL.Database();
      }

      // Apply schema
      try {
        _db.run(SCHEMA);
      } catch (e) {
        console.warn('[DB] Full schema apply failed, retrying statement-by-statement:', e.message);
        SCHEMA.split(';').map(s => s.trim()).filter(Boolean).forEach(stmt => {
          try { _db.run(stmt + ';'); }
          catch (e2) { console.warn('[DB] Schema statement skipped:', e2.message); }
        });
      }

      // ── MIGRATION: clock_unverified column ──
      // CREATE TABLE IF NOT EXISTS is a no-op on a transactions table that
      // already existed before this column was introduced, so databases
      // created earlier need it added explicitly. This is purely additive —
      // it adds a new column with a default value and does not modify any
      // existing row's stored data, so it does not conflict with the
      // no-UPDATE/no-DELETE invariant on this table.
      try {
        const cols = _db.exec(`PRAGMA table_info(transactions)`);
        const hasCol = cols.length && cols[0].values.some(row => row[1] === 'clock_unverified');
        if (!hasCol) {
          _db.run(`ALTER TABLE transactions ADD COLUMN clock_unverified INTEGER NOT NULL DEFAULT 0`);
        }
      } catch (e) {
        console.warn('[DB] clock_unverified migration skipped:', e.message);
      }

      // ── MIGRATION: cost_rate and profit_pkr columns (Phase 03 — profit tracking) ──
      // Nullable REAL columns — existing rows will read NULL for both, which the
      // hash engine treats as '' in v1 payload (not in fieldOrder) and as the
      // string 'null' in v2 payload.  Purely additive; no existing data is changed.
      try {
        const cols2 = _db.exec(`PRAGMA table_info(transactions)`);
        const colNames = cols2.length ? cols2[0].values.map(row => row[1]) : [];
        if (!colNames.includes('cost_rate')) {
          _db.run(`ALTER TABLE transactions ADD COLUMN cost_rate REAL`);
        }
        if (!colNames.includes('profit_pkr')) {
          _db.run(`ALTER TABLE transactions ADD COLUMN profit_pkr REAL`);
        }
      } catch (e) {
        console.warn('[DB] cost_rate/profit_pkr migration skipped:', e.message);
      }

      // ── MIGRATION: hash_version column (Phase 03 — profit tracking) ──
      // Records inserted before this migration were hashed under the v1
      // field order (no cost_rate/profit_pkr in the payload), so any row
      // that doesn't already have a hash_version must be backfilled with
      // 'DEMS-v1' — NOT the current version — so HashEngine.verifyRecord()
      // keeps picking the v1 field order for them and they continue to
      // verify correctly. ALTER TABLE ... DEFAULT applies retroactively to
      // existing rows for the purpose of this backfill UPDATE only; it does
      // not touch hash, prev_hash, or any other already-committed field, so
      // it does not conflict with the no-UPDATE/no-DELETE invariant on this
      // table's hashed data.
      try {
        const cols3 = _db.exec(`PRAGMA table_info(transactions)`);
        const colNames3 = cols3.length ? cols3[0].values.map(row => row[1]) : [];
        if (!colNames3.includes('hash_version')) {
          _db.run(`ALTER TABLE transactions ADD COLUMN hash_version TEXT NOT NULL DEFAULT 'DEMS-v1'`);
        }
      } catch (e) {
        console.warn('[DB] hash_version migration skipped:', e.message);
      }

      // ── MIGRATION: is_void and voids_chain_index columns ──────────────
      // Additive columns for the Void/Correction workflow (Phase 03+).
      // is_void = 1 marks a record as a correction entry (never a new txn).
      // voids_chain_index points to the chain_index of the original record
      // that this correction entry supersedes.
      // Existing rows naturally get is_void = 0 (the default) — they are
      // regular transactions, not void entries. No hashed field is touched.
      try {
        const colsVoid = _db.exec(`PRAGMA table_info(transactions)`);
        const colNamesVoid = colsVoid.length ? colsVoid[0].values.map(row => row[1]) : [];
        if (!colNamesVoid.includes('is_void')) {
          _db.run(`ALTER TABLE transactions ADD COLUMN is_void INTEGER NOT NULL DEFAULT 0`);
        }
        if (!colNamesVoid.includes('voids_chain_index')) {
          _db.run(`ALTER TABLE transactions ADD COLUMN voids_chain_index INTEGER`);
        }
      } catch (e) {
        console.warn('[DB] is_void/voids_chain_index migration skipped:', e.message);
      }

      // ── MIGRATION: attachments table (scalability phase) ──────────────
      // The attachments table is declared in SCHEMA above so new databases
      // get it automatically.  For existing databases that pre-date this
      // change, CREATE TABLE IF NOT EXISTS in SCHEMA is a no-op during the
      // bulk _db.run(SCHEMA) call because sql.js re-runs SCHEMA on every
      // init() — but the table will be created on first schema run if it
      // doesn't already exist.  This migration block is a belt-and-
      // suspenders safety net that verifies the table was actually created
      // (e.g. if the bulk schema run skipped it due to a parse error) and
      // also adds the attachment_id convenience column to transactions if it
      // is missing.
      try {
        _db.run(`
          CREATE TABLE IF NOT EXISTS attachments (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            txn_id      INTEGER NOT NULL,
            mime_type   TEXT    NOT NULL DEFAULT 'image/jpeg',
            base64_data TEXT    NOT NULL,
            uploaded_at TEXT    NOT NULL
          )
        `);
        _db.run(`CREATE INDEX IF NOT EXISTS idx_att_txn ON attachments(txn_id)`);

        // attachment_id on transactions — fast FK shortcut, nullable so
        // existing rows and attachment-free rows are unaffected.
        const colsAtt = _db.exec(`PRAGMA table_info(transactions)`);
        const colNamesAtt = colsAtt.length ? colsAtt[0].values.map(row => row[1]) : [];
        if (!colNamesAtt.includes('attachment_id')) {
          _db.run(`ALTER TABLE transactions ADD COLUMN attachment_id INTEGER`);
        }
      } catch (e) {
        console.warn('[DB] attachments migration skipped:', e.message);
      }

      flushStorage();

      return _db;
    },

    /**
     * run(sql, params?)
     * Execute INSERT / UPDATE / DELETE / CREATE.
     * Schedules a debounced saveToStorage() — multiple rapid calls
     * (e.g. insert transaction + insert attachment) coalesce into one export.
     */
    async run(sql, params = []) {
      if (!_db) await this.init();
      _db.run(sql, params);
      saveToStorage();   // debounced — queues a 2-second trailing write
      return { lastInsertRowid: _db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] };
    },

    /**
     * flush()
     * Cancel any pending debounce and write the DB to localStorage right now.
     * Use after a critical multi-step write sequence (e.g. insert txn + attachment)
     * when you need the data persisted before navigating away.
     */
    flush() {
      flushStorage();
    },

    /**
     * transaction(fn)
     * Wraps a sequence of DB writes in a single SQLite BEGIN/COMMIT so that
     * multi-step operations (e.g. insert transaction + sync client + save
     * attachment) either all succeed or all roll back together. If `fn`
     * throws, the partial writes are rolled back and the error is re-thrown
     * to the caller. On success, a single saveToStorage() is scheduled so
     * the whole batch persists as one export rather than one per statement.
     */
    async transaction(fn) {
      if (!_db) await this.init();
      _db.run('BEGIN');
      try {
        await fn();
        _db.run('COMMIT');
        saveToStorage();
      } catch (e) {
        try { _db.run('ROLLBACK'); } catch {}
        throw e;
      }
    },

    /**
     * get(sql, params?)
     * Returns a single row object or null
     */
    async get(sql, params = []) {
      if (!_db) await this.init();
      const result = _db.exec(sql, params);
      if (!result.length || !result[0].values.length) return null;
      const cols = result[0].columns;
      const vals = result[0].values[0];
      const obj  = {};
      cols.forEach((c, i) => obj[c] = vals[i]);
      return obj;
    },

    /**
     * all(sql, params?)
     * Returns array of row objects
     */
    async all(sql, params = []) {
      if (!_db) await this.init();
      const result = _db.exec(sql, params);
      if (!result.length) return [];
      const cols = result[0].columns;
      return result[0].values.map(row => {
        const obj = {};
        cols.forEach((c, i) => obj[c] = row[i]);
        return obj;
      });
    },

    /**
     * getNextReceiptNumber()
     * Generates sequential receipt number: EXC-YYYY-NNNNN
     */
    async getNextReceiptNumber() {
      const year = new Date().getFullYear();
      const row  = await this.get(
        `SELECT COUNT(*) as cnt FROM transactions WHERE receipt_number LIKE 'EXC-${year}-%'`
      );
      const next = (row?.cnt || 0) + 1;
      return `EXC-${year}-${String(next).padStart(5, '0')}`;
    },

    // ════════════════════════════════════════════════════════
    //  ATTACHMENT API
    //  Stores/retrieves receipt screenshots out-of-band from the
    //  transactions table so that base64 image blobs do not bloat
    //  the rows the hash engine and reports read on every load.
    // ════════════════════════════════════════════════════════

    /**
     * saveAttachment(txnId, mimeType, base64Data)
     * Inserts a new row into attachments and returns its id.
     * The caller is expected to then UPDATE transactions.screenshot_path
     * to 'attachment:<id>' and transactions.attachment_id to <id>.
     *
     * Note: uses the debounced saveToStorage() via DB.run() — call
     * DB.flush() after the full transaction+attachment sequence when you
     * need the persist to happen before a page redirect.
     */
    async saveAttachment(txnId, mimeType, base64Data) {
      if (!_db) await this.init();
      const now = new Date().toISOString();
      const result = await this.run(
        `INSERT INTO attachments (txn_id, mime_type, base64_data, uploaded_at)
         VALUES (?, ?, ?, ?)`,
        [txnId, mimeType || 'image/jpeg', base64Data, now]
      );
      return result.lastInsertRowid;
    },

    /**
     * getAttachment(txnId)
     * Returns the most recent attachment row for a given transaction id,
     * or null if none exists.  The caller can use the returned base64_data
     * directly as an <img src=""> value or a data-URI.
     */
    async getAttachment(txnId) {
      if (!_db) await this.init();
      return await this.get(
        `SELECT * FROM attachments WHERE txn_id = ? ORDER BY id DESC LIMIT 1`,
        [txnId]
      );
    },

    /**
     * migrateInlineScreenshot(txnId, screenshotPath)
     * Legacy compatibility helper.
     *
     * Databases created before the attachments table was introduced store
     * the full base64 data-URI directly in transactions.screenshot_path.
     * When callers encounter a screenshot_path that starts with 'data:'
     * they should call this method once to:
     *   1. Move the blob into the attachments table.
     *   2. Replace screenshot_path with 'attachment:<id>'.
     *   3. Set attachment_id for fast lookup.
     *
     * This migration is lazy (on first access) so it is safe to call from
     * any page that renders a screenshot — it is a no-op if the path is
     * already in 'attachment:<id>' format or is empty.
     *
     * Returns: { migrated: bool, attachmentId: int|null, base64Data: string }
     */
    async migrateInlineScreenshot(txnId, screenshotPath) {
      if (!screenshotPath || !screenshotPath.startsWith('data:')) {
        return { migrated: false, attachmentId: null, base64Data: screenshotPath || '' };
      }

      try {
        // Extract MIME type from data-URI header (e.g. 'data:image/jpeg;base64,...')
        const mimeMatch = screenshotPath.match(/^data:([^;]+);base64,/);
        const mimeType  = mimeMatch ? mimeMatch[1] : 'image/jpeg';

        const attId = await this.saveAttachment(txnId, mimeType, screenshotPath);

        // UPDATE is permitted here because screenshot_path and attachment_id
        // are non-hashed metadata columns — they are not part of the fields
        // covered by the DEMS-v1 or DEMS-v2 hash payload, so rewriting them
        // cannot break chain verification.
        _db.run(
          `UPDATE transactions SET screenshot_path = ?, attachment_id = ? WHERE id = ?`,
          [`attachment:${attId}`, attId, txnId]
        );
        flushStorage();   // immediate — migration is a one-time write

        console.info(`[DB] Migrated inline screenshot for txn ${txnId} → attachment ${attId}`);
        return { migrated: true, attachmentId: attId, base64Data: screenshotPath };
      } catch (e) {
        console.warn('[DB] migrateInlineScreenshot failed:', e.message);
        return { migrated: false, attachmentId: null, base64Data: screenshotPath };
      }
    },

    /**
     * export()
     * Returns raw Uint8Array of DB for backup (Phase 08)
     */
    exportRaw() {
      if (!_db) return null;
      return _db.export();
    },

    /**
     * importRaw(uint8Array)
     * Restore DB from backup
     */
    async importRaw(data) {
      const SQL = await window.initSqlJs({
        locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${file}`
      });
      _db = new SQL.Database(data);
      flushStorage();   // immediate — backup restore should persist before any redirect
      return true;
    },

    /**
     * getStats()
     * Quick stats for dashboard (Phase 06)
     */
    async getStats() {
      const txnCount = await this.get('SELECT COUNT(*) as cnt FROM transactions');
      const clients  = await this.get('SELECT COUNT(*) as cnt FROM clients');
      const today    = new Date().toISOString().split('T')[0];
      const todayTxn = await this.get(
        `SELECT COUNT(*) as cnt, COALESCE(SUM(amount_pkr),0) as vol
         FROM transactions WHERE timestamp LIKE '${today}%'`
      );
      return {
        totalTransactions: txnCount?.cnt || 0,
        totalClients     : clients?.cnt || 0,
        todayTransactions: todayTxn?.cnt || 0,
        todayVolume      : todayTxn?.vol || 0
      };
    },

    // ════════════════════════════════════════════════════════
    //  PROTECTED TABLES — NEVER ERASABLE BY ANY RESET PATH
    //
    //  These hold the financial/audit record the app exists to
    //  protect (transactionImmutable / noDeleteAllowed). No reset,
    //  "factory reset", or maintenance function is permitted to
    //  drop, truncate, or DELETE FROM any of these — ever. This
    //  list is intentionally hardcoded here (not passed in by a
    //  caller) so a UI bug or careless edit elsewhere can't expand
    //  what gets erased.
    // ════════════════════════════════════════════════════════
    PROTECTED_TABLES: ['transactions', 'receipts', 'verification_log', 'audit_log'],

    /**
     * resetAppConfigOnly()
     * The ONLY sanctioned "factory reset"-style operation. Clears
     * app-level configuration (app_settings) so a misconfigured
     * install can be reset to a clean shell — and nothing else.
     * It does NOT touch transactions, receipts, verification_log,
     * audit_log, or clients. Credential localStorage keys (PIN/
     * password hashes) are cleared by the caller in settings.html,
     * since those live outside the SQLite DB.
     *
     * Returns a summary of exactly what was cleared, so the caller
     * can log/display it accurately rather than guessing.
     */
    async resetAppConfigOnly() {
      if (!_db) await this.init();

      const before = await this.get('SELECT COUNT(*) as cnt FROM app_settings');

      // Hardcoded, allow-listed statement — does not accept or build
      // table names dynamically, so it cannot be redirected at any
      // table other than app_settings.
      _db.run('DELETE FROM app_settings');
      flushStorage();   // immediate — config reset should land before any redirect

      const survivingCounts = {};
      for (const t of this.PROTECTED_TABLES) {
        try {
          const row = await this.get(`SELECT COUNT(*) as cnt FROM ${t}`);
          survivingCounts[t] = row?.cnt || 0;
        } catch (e) {
          survivingCounts[t] = 'unavailable';
        }
      }

      return {
        clearedTable   : 'app_settings',
        clearedRows    : before?.cnt || 0,
        protectedTables: this.PROTECTED_TABLES,
        survivingCounts: survivingCounts
      };
    }

  };

})();