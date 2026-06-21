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
      is_locked       INTEGER NOT NULL DEFAULT 1  -- Always 1 after insert
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

  `;

  // ── PERSISTENCE ─────────────────────────────────────────
  function saveToStorage() {
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
    }
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

  // Auto-save every 30 seconds
  setInterval(saveToStorage, 30000);

  // Save before page unload
  window.addEventListener('beforeunload', saveToStorage);

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
      saveToStorage();

      return _db;
    },

    /**
     * run(sql, params?)
     * Execute INSERT / UPDATE / DELETE / CREATE
     */
    async run(sql, params = []) {
      if (!_db) await this.init();
      _db.run(sql, params);
      saveToStorage();
      return { lastInsertRowid: _db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] };
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
      saveToStorage();
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
    }

  };

})();
