// ══════════════════════════════════════════════════════════
//  hash-engine.js — Tamper-Proof Core Engine
//  Digital Exchange Management System — Phase 02
// ══════════════════════════════════════════════════════════

const HashEngine = (() => {

  const HASH_VERSION   = 'DEMS-v1';
  const GENESIS_HASH   = '0'.repeat(64);
  const SALT           = 'DEMS_CHAIN_SALT_2024';

  async function sha256(input) {
    const encoded = new TextEncoder().encode(input);
    const buffer  = await crypto.subtle.digest('SHA-256', encoded);
    const bytes   = Array.from(new Uint8Array(buffer));
    return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function buildHashPayload(record, prevHash) {
    const fields = [
      HASH_VERSION,
      record.receipt_number  || '',
      record.txn_type        || '',
      String(record.amount_pkr    || 0),
      String(record.exchange_rate || 0),
      String(record.amount_usdt   || 0),
      record.client_name     || '',
      record.client_cnic     || '',
      record.bank_name       || '',
      record.bank_last4      || '',
      record.order_id        || '',
      record.payment_ref     || '',
      record.timestamp,
      String(record.chain_index),
      prevHash,
      SALT
    ];
    return fields.join('|');
  }

  function getServerTimestamp() {
    return new Date().toISOString();
  }

  async function getChainState() {
    try {
      const last = await DB.get(
        `SELECT hash, chain_index
         FROM transactions
         ORDER BY chain_index DESC
         LIMIT 1`
      );

      if (!last) {
        return {
          prevHash  : GENESIS_HASH,
          nextIndex : 0
        };
      }

      return {
        prevHash  : last.hash,
        nextIndex : last.chain_index + 1
      };
    } catch (e) {
      console.error('[HashEngine] getChainState error:', e);
      return {
        prevHash  : GENESIS_HASH,
        nextIndex : 0
      };
    }
  }

  async function logVerification(receiptNumber, result) {
    try {
      await DB.run(
        `INSERT INTO verification_log (receipt_number, verified_at, result, verifier_ip, user_agent)
         VALUES (?, ?, ?, ?, ?)`,
        [receiptNumber || '', new Date().toISOString(), result, '', navigator.userAgent.substring(0, 120)]
      );
    } catch (e) {
      console.warn('[HashEngine] verification_log write skipped:', e.message);
    }
  }

  return {

    async prepareRecord(formData) {
      const timestamp = getServerTimestamp();
      const receiptNumber = await DB.getNextReceiptNumber();
      const { prevHash, nextIndex } = await getChainState();

      const record = {
        receipt_number  : receiptNumber,
        order_id        : (formData.order_id        || '').trim(),
        txn_type        : formData.txn_type,
        amount_pkr      : parseFloat(formData.amount_pkr)      || 0,
        exchange_rate   : parseFloat(formData.exchange_rate)   || 0,
        amount_usdt     : parseFloat(formData.amount_usdt)     || 0,
        client_name     : (formData.client_name     || '').trim(),
        client_cnic     : (formData.client_cnic     || '').trim(),
        bank_name       : (formData.bank_name       || '').trim(),
        bank_last4      : (formData.bank_last4      || '').trim(),
        payment_ref     : (formData.payment_ref     || '').trim(),
        notes           : (formData.notes           || '').trim(),
        screenshot_path : (formData.screenshot_path || '').trim(),
        timestamp       : timestamp,
        chain_index     : nextIndex,
        prev_hash       : prevHash,
        is_locked       : 1
      };

      const payload     = buildHashPayload(record, prevHash);
      record.hash       = await sha256(payload);

      return record;
    },

    async insertTransaction(formData) {
      try {
        const validation = this.validateFormData(formData);
        if (!validation.valid) {
          return { success: false, error: validation.error };
        }

        const record = await this.prepareRecord(formData);

        await DB.run(
          `INSERT INTO transactions (
            receipt_number, order_id, txn_type,
            amount_pkr, exchange_rate, amount_usdt,
            client_name, client_cnic,
            bank_name, bank_last4, payment_ref,
            notes, screenshot_path,
            timestamp, hash, prev_hash, chain_index, is_locked
          ) VALUES (
            ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?, ?, ?, ?
          )`,
          [
            record.receipt_number,  record.order_id,     record.txn_type,
            record.amount_pkr,      record.exchange_rate, record.amount_usdt,
            record.client_name,     record.client_cnic,
            record.bank_name,       record.bank_last4,   record.payment_ref,
            record.notes,           record.screenshot_path,
            record.timestamp,       record.hash,         record.prev_hash,
            record.chain_index,     record.is_locked
          ]
        );

        // Auto-synchronize client KYC record representing transaction data
        await this.syncClientForTransaction(record);

        AuditLog.add(
          'TRANSACTION_ADDED',
          `Receipt: ${record.receipt_number} | Type: ${record.txn_type.toUpperCase()} | PKR: ${record.amount_pkr.toLocaleString()} | Chain: #${record.chain_index}`
        );

        return {
          success       : true,
          record        : record,
          receiptNumber : record.receipt_number
        };

      } catch (e) {
        console.error('[HashEngine] insertTransaction error:', e);
        AuditLog.add('TRANSACTION_ERROR', `Insert failed: ${e.message}`);
        return { success: false, error: e.message };
      }
    },

    async syncClientForTransaction(record) {
      if (!record.client_name && !record.client_cnic) {
        return;
      }

      const name = (record.client_name || '').trim();
      const cnic = (record.client_cnic || '').trim();
      const amount = parseFloat(record.amount_pkr) || 0;
      const t = record.timestamp;

      let client = null;
      if (cnic) {
        client = await DB.get(`SELECT * FROM clients WHERE cnic = ?`, [cnic]);
      } else if (name) {
        client = await DB.get(`SELECT * FROM clients WHERE full_name = ? AND cnic IS NULL`, [name]);
      }

      if (client) {
        // Update existing client stats
        const totalTxns = (client.total_txns || 0) + 1;
        const totalVolume = (client.total_volume_pkr || 0) + amount;
        const firstTxn = client.first_txn_date || t;
        const lastTxn = t;

        const bName  = record.bank_name  || client.bank_name  || '';
        const bLast4 = record.bank_last4 || client.bank_last4 || '';

        await DB.run(
          `UPDATE clients SET
             full_name = COALESCE(NULLIF(full_name, ''), ?),
             total_txns = ?,
             total_volume_pkr = ?,
             first_txn_date = ?,
             last_txn_date = ?,
             bank_name = ?,
             bank_last4 = ?,
             updated_at = ?
           WHERE id = ?`,
          [name || client.full_name, totalTxns, totalVolume, firstTxn, lastTxn, bName, bLast4, t, client.id]
        );
      } else {
        // Insert new client
        await DB.run(
          `INSERT INTO clients (
             cnic, full_name, phone, whatsapp, bank_name, bank_account, bank_last4,
             is_verified, is_flagged, flag_reason,
             total_txns, total_volume_pkr, first_txn_date, last_txn_date,
             notes, created_at, updated_at
           ) VALUES (?, ?, '', '', ?, '', ?, 0, 0, '', 1, ?, ?, ?, '', ?, ?)`,
          [
            cnic || null,
            name || 'Unknown',
            record.bank_name || '',
            record.bank_last4 || '',
            amount,
            t,
            t,
            t,
            t
          ]
        );
      }
    },

    async verifyRecord(txn) {
      const payload      = buildHashPayload(txn, txn.prev_hash);
      const computedHash = await sha256(payload);
      const valid        = computedHash === txn.hash;

      return {
        valid        : valid,
        storedHash   : txn.hash,
        computedHash : computedHash,
        tampered     : !valid,
        receiptNumber: txn.receipt_number,
        chainIndex   : txn.chain_index
      };
    },

    verifyChainLink(txn, prevTxn) {
      const expected = prevTxn ? prevTxn.hash : GENESIS_HASH;
      const actual   = txn.prev_hash;
      const linked   = expected === actual;

      return {
        linked   : linked,
        expected : expected,
        actual   : actual,
        broken   : !linked
      };
    },

    async verifyChain(onProgress = null) {
      const startTime = Date.now();

      try {
        const transactions = await DB.all(
          `SELECT * FROM transactions ORDER BY chain_index ASC`
        );

        const total   = transactions.length;
        const results = [];
        let   broken  = false;
        let   firstBreakAt = null;

        if (total === 0) {
          return {
            status          : 'EMPTY',
            message         : 'No transactions in chain yet.',
            total           : 0,
            verified        : 0,
            tampered        : 0,
            brokenLinks     : 0,
            chainIntact     : true,
            verificationTime: Date.now() - startTime,
            results         : []
          };
        }

        for (let i = 0; i < total; i++) {
          const txn     = transactions[i];
          const prevTxn = i > 0 ? transactions[i - 1] : null;

          const hashCheck = await this.verifyRecord(txn);
          const linkCheck = this.verifyChainLink(txn, prevTxn);
          const recordOk = hashCheck.valid && linkCheck.linked;

          if (!recordOk && !broken) {
            broken       = true;
            firstBreakAt = txn.chain_index;
          }

          results.push({
            chainIndex    : txn.chain_index,
            receiptNumber : txn.receipt_number,
            timestamp     : txn.timestamp,
            hashValid     : hashCheck.valid,
            linkValid     : linkCheck.linked,
            intact        : recordOk,
            storedHash    : txn.hash.substring(0, 16) + '…',
            computedHash  : hashCheck.computedHash.substring(0, 16) + '…'
          });

          if (onProgress) {
            onProgress(i + 1, total, Math.round(((i + 1) / total) * 100));
          }
        }

        const tampered    = results.filter(r => !r.intact).length;
        const intact      = results.filter(r =>  r.intact).length;
        const brokenLinks = results.filter(r => !r.linkValid).length;

        const status = tampered === 0 ? 'INTACT' : 'COMPROMISED';

        AuditLog.add(
          'CHAIN_VERIFIED',
          `Status: ${status} | Total: ${total} | Tampered: ${tampered} | Time: ${Date.now() - startTime}ms`
        );

        return {
          status          : status,
          message         : tampered === 0
            ? `All ${total} transactions verified. Chain is intact.`
            : `WARNING: ${tampered} tampered record(s) detected. First breach at chain index #${firstBreakAt}.`,
          total           : total,
          verified        : intact,
          tampered        : tampered,
          brokenLinks     : brokenLinks,
          chainIntact     : tampered === 0,
          firstBreakAt    : firstBreakAt,
          verificationTime: Date.now() - startTime,
          results         : results
        };

      } catch (e) {
        console.error('[HashEngine] verifyChain error:', e);
        AuditLog.add('CHAIN_VERIFY_ERROR', e.message);
        return {
          status      : 'ERROR',
          message     : 'Chain verification failed: ' + e.message,
          chainIntact : false,
          error       : e.message
        };
      }
    },

    async verifyByReceiptNumber(receiptNumber) {
      try {
        const txn = await DB.get(
          `SELECT * FROM transactions WHERE receipt_number = ?`,
          [receiptNumber]
        );

        if (!txn) {
          await logVerification(receiptNumber, 'NOT_FOUND');
          return {
            found         : false,
            status        : 'NOT_FOUND',
            receiptNumber : receiptNumber,
            message       : 'No transaction found with this receipt number.'
          };
        }

        const hashCheck = await this.verifyRecord(txn);

        let prevTxn = null;
        if (txn.chain_index > 0) {
          prevTxn = await DB.get(
            `SELECT * FROM transactions WHERE chain_index = ?`,
            [txn.chain_index - 1]
          );
        }
        const linkCheck = this.verifyChainLink(txn, prevTxn);

        const overallIntact = hashCheck.valid && linkCheck.linked;

        AuditLog.add(
          'RECEIPT_VERIFIED',
          `Receipt: ${receiptNumber} | Result: ${overallIntact ? 'ORIGINAL' : 'TAMPERED'}`
        );
        await logVerification(txn.receipt_number, overallIntact ? 'ORIGINAL' : 'TAMPERED');

        return {
          found         : true,
          status        : overallIntact ? 'ORIGINAL' : 'TAMPERED',
          receiptNumber : txn.receipt_number,
          chainIndex    : txn.chain_index,
          timestamp     : txn.timestamp,
          txnType       : txn.txn_type,
          amountPkr     : txn.amount_pkr,
          clientName    : txn.client_name,
          hashValid     : hashCheck.valid,
          linkValid     : linkCheck.linked,
          intact        : overallIntact,
          storedHash    : txn.hash,
          computedHash  : hashCheck.computedHash,
          message       : overallIntact
            ? 'This is a verified ORIGINAL document. It has not been tampered with.'
            : 'WARNING: This document has been TAMPERED. Data may have been modified.'
        };

      } catch (e) {
        console.error('[HashEngine] verifyByReceiptNumber error:', e);
        return {
          found   : false,
          status  : 'ERROR',
          message : 'Verification error: ' + e.message
        };
      }
    },

    async verifyByHash(hash) {
      try {
        const cleanHash = (hash || '').trim().toLowerCase();

        const txn = await DB.get(
          `SELECT * FROM transactions WHERE hash = ?`,
          [cleanHash]
        );

        if (!txn) {
          await logVerification('', 'NOT_FOUND');
          return {
            found   : false,
            status  : 'NOT_FOUND',
            hash    : cleanHash,
            message : 'No transaction found with this hash.'
          };
        }

        const hashCheck = await this.verifyRecord(txn);

        let prevTxn = null;
        if (txn.chain_index > 0) {
          prevTxn = await DB.get(
            `SELECT * FROM transactions WHERE chain_index = ?`,
            [txn.chain_index - 1]
          );
        }
        const linkCheck = this.verifyChainLink(txn, prevTxn);

        const overallIntact = hashCheck.valid && linkCheck.linked;

        AuditLog.add(
          'HASH_VERIFIED',
          `Hash: ${this.formatHashShort(cleanHash)} | Result: ${overallIntact ? 'ORIGINAL' : 'TAMPERED'}`
        );
        await logVerification(txn.receipt_number, overallIntact ? 'ORIGINAL' : 'TAMPERED');

        return {
          found         : true,
          status        : overallIntact ? 'ORIGINAL' : 'TAMPERED',
          receiptNumber : txn.receipt_number,
          chainIndex    : txn.chain_index,
          timestamp     : txn.timestamp,
          txnType       : txn.txn_type,
          amountPkr     : txn.amount_pkr,
          clientName    : txn.client_name,
          hashValid     : hashCheck.valid,
          linkValid     : linkCheck.linked,
          intact        : overallIntact,
          storedHash    : txn.hash,
          computedHash  : hashCheck.computedHash,
          message       : overallIntact
            ? 'This is a verified ORIGINAL document. It has not been tampered with.'
            : 'WARNING: This document has been TAMPERED. Data may have been modified.'
        };

      } catch (e) {
        console.error('[HashEngine] verifyByHash error:', e);
        return {
          found   : false,
          status  : 'ERROR',
          message : 'Verification error: ' + e.message
        };
      }
    },

    async startupCheck() {
      try {
        const total = await DB.get(
          `SELECT COUNT(*) as cnt, MAX(chain_index) as maxIdx FROM transactions`
        );

        if (!total || total.cnt === 0) {
          return { ok: true, status: 'EMPTY', message: 'No transactions yet.', count: 0 };
        }

        const tip = await DB.get(
          `SELECT * FROM transactions ORDER BY chain_index DESC LIMIT 1`
        );

        const tipCheck = await this.verifyRecord(tip);
        const expectedCount = tip.chain_index + 1;
        const countMismatch = total.cnt !== expectedCount;

        const ok = tipCheck.valid && !countMismatch;

        AuditLog.add(
          'STARTUP_CHECK',
          `Status: ${ok ? 'OK' : 'ALERT'} | Chain tip: #${tip.chain_index} | Count: ${total.cnt} | Tip hash: ${tipCheck.valid ? 'valid' : 'INVALID'}`
        );

        if (!ok) {
          return {
            ok      : false,
            status  : 'ALERT',
            message : countMismatch
              ? `Chain count mismatch: ${total.cnt} records found but sequence expects ${expectedCount}. Records may have been deleted.`
              : `Chain tip hash is invalid. Last record (${tip.receipt_number}) may have been tampered.`,
            count   : total.cnt,
            tipReceipt: tip.receipt_number
          };
        }

        return {
          ok         : true,
          status     : 'OK',
          message    : `Chain OK — ${total.cnt} records verified at tip.`,
          count      : total.cnt,
          tipReceipt : tip.receipt_number
        };

      } catch (e) {
        console.error('[HashEngine] startupCheck error:', e);
        return { ok: false, status: 'ERROR', message: e.message };
      }
    },

    async computeHash(input) {
      return await sha256(input);
    },

    getGenesisHash() {
      return GENESIS_HASH;
    },

    formatHashShort(hash) {
      if (!hash || hash.length < 16) return hash;
      return `${hash.substring(0, 8)}…${hash.substring(hash.length - 8)}`;
    },

    validateFormData(formData) {
      if (!formData.txn_type || !['buy', 'sell'].includes(formData.txn_type)) {
        return { valid: false, error: 'Transaction type must be "buy" or "sell".' };
      }
      const amount = parseFloat(formData.amount_pkr);
      if (!amount || amount <= 0) {
        return { valid: false, error: 'Amount PKR must be a positive number.' };
      }
      const rate = parseFloat(formData.exchange_rate);
      if (!rate || rate <= 0) {
        return { valid: false, error: 'Exchange rate must be a positive number.' };
      }
      return { valid: true };
    },

    async getChainSummary() {
      try {
        const row = await DB.get(
          `SELECT
             COUNT(*)             as total,
             MAX(chain_index)     as tip_index,
             MIN(timestamp)       as first_txn,
             MAX(timestamp)       as last_txn,
             SUM(amount_pkr)      as total_volume
           FROM transactions`
        );
        const tip = await DB.get(
          `SELECT hash, receipt_number FROM transactions ORDER BY chain_index DESC LIMIT 1`
        );
        return {
          total       : row?.total       || 0,
          tipIndex    : row?.tip_index   ?? -1,
          firstTxn    : row?.first_txn   || null,
          lastTxn     : row?.last_txn    || null,
          totalVolume : row?.total_volume || 0,
          tipHash     : tip?.hash        || GENESIS_HASH,
          tipReceipt  : tip?.receipt_number || null
        };
      } catch {
        return { total: 0, tipIndex: -1, tipHash: GENESIS_HASH };
      }
    }

  };

})();
