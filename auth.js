// ══════════════════════════════════════════════════════════
//  auth.js — Authentication System
//  Digital Exchange Management System — Phase 01
//  Handles: PIN login, password login, session management,
//           lockout enforcement, credential storage
// ══════════════════════════════════════════════════════════

const Auth = (() => {

  // ── CONFIG ──────────────────────────────────────────────
  const SESSION_KEY    = 'dems_session';
  const CRED_KEY       = 'dems_credentials';

  // ── PRIVATE HELPERS ─────────────────────────────────────

  /**
   * Simple hash using Web Crypto API (SHA-256)
   * Returns hex string
   */
  async function hashValue(value) {
    const msgBuffer = new TextEncoder().encode(value + '_DEMS_SALT_2024');
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray  = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Get stored credentials from localStorage
   */
  function getCredentials() {
    try {
      const raw = localStorage.getItem(CRED_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /**
   * Get session timeout in milliseconds from profile
   */
  async function getTimeoutMs() {
    try {
      const profile = await Profile.get();
      const mins = profile?.sessionTimeout || 30;
      return mins * 60 * 1000;
    } catch {
      return 30 * 60 * 1000;
    }
  }

  // ── PUBLIC API ───────────────────────────────────────────
  return {

    /**
     * setupCredentials(pin, backupPassword?)
     * Called once during profile setup (Phase 01 step 3)
     * Stores hashed PIN and optional hashed backup password
     */
    async setupCredentials(pin, backupPassword = '') {
      const pinHash = await hashValue(pin);
      const pwHash  = backupPassword ? await hashValue(backupPassword) : null;
      const creds   = { pinHash, pwHash, createdAt: new Date().toISOString() };
      localStorage.setItem(CRED_KEY, JSON.stringify(creds));
      return true;
    },

    /**
     * login(credential, type)
     * type: 'pin' | 'password'
     * Returns { success: true } or { success: false, reason: '...' }
     */
    async login(credential, type = 'pin') {
      const creds = getCredentials();
      if (!creds) return { success: false, reason: 'No credentials setup' };

      const inputHash = await hashValue(credential);
      let match = false;

      if (type === 'pin') {
        match = (inputHash === creds.pinHash);
      } else if (type === 'password') {
        match = creds.pwHash && (inputHash === creds.pwHash);
      }

      if (match) {
        // Create session
        const timeoutMs = await getTimeoutMs();
        const session = {
          loggedInAt: Date.now(),
          expiresAt : Date.now() + timeoutMs,
          type      : type
        };
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        // Clear failed attempts on success
        localStorage.removeItem('failedAttempts');
        localStorage.removeItem('lockoutUntil');
        return { success: true };
      }

      return { success: false, reason: 'Invalid credential' };
    },

    /**
     * checkSession()
     * Returns true if a valid (non-expired) session exists
     */
    checkSession() {
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return false;
        const session = JSON.parse(raw);
        if (Date.now() > session.expiresAt) {
          localStorage.removeItem(SESSION_KEY);
          return false;
        }
        return true;
      } catch {
        return false;
      }
    },

    /**
     * isLoggedIn()
     * Helper mapping checkSession (prevents page crashes referenced in Bug 1)
     */
    isLoggedIn() {
      return this.checkSession();
    },

    /**
     * refreshSession()
     * Extends session expiry on user activity
     */
    async refreshSession() {
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return;
        const session = JSON.parse(raw);
        const timeoutMs = await getTimeoutMs();
        session.expiresAt = Date.now() + timeoutMs;
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      } catch {
        // silent fail
      }
    },

    /**
     * logout()
     * Clears session and redirects to login
     */
    logout() {
      localStorage.removeItem(SESSION_KEY);
      AuditLog.add('LOGOUT', 'User logged out');
      window.location.href = 'login.html';
    },

    /**
     * requireAuth()
     * Call at top of every protected page.
     * Redirects to login if no valid session.
     */
    requireAuth() {
      if (!this.checkSession()) {
        window.location.href = 'login.html';
        return false;
      }
      // Refresh session on activity
      this.refreshSession();
      return true;
    },

    /**
     * changePin(currentPin, newPin)
     * Returns { success, error? }
     */
    async changePin(currentPin, newPin) {
      const creds = getCredentials();
      if (!creds) return { success: false, error: 'No credentials found' };

      const currentHash = await hashValue(currentPin);
      if (currentHash !== creds.pinHash) return { success: false, error: 'Current PIN galat hai' };

      if (newPin === '0000' || newPin === '1234' || newPin === '1111') {
        return { success: false, error: 'Yeh PIN unsafe hai' };
      }

      const newHash = await hashValue(newPin);
      creds.pinHash = newHash;
      creds.updatedAt = new Date().toISOString();
      localStorage.setItem(CRED_KEY, JSON.stringify(creds));
      AuditLog.add('PIN_CHANGED', 'User changed their PIN');
      return { success: true };
    },

    /**
     * getSessionInfo()
     * Returns { loggedInAt, expiresAt, minutesRemaining }
     */
    getSessionInfo() {
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const session = JSON.parse(raw);
        const minsRemaining = Math.max(0, (session.expiresAt - Date.now()) / 60000);
        return { ...session, minutesRemaining: minsRemaining };
      } catch {
        return null;
      }
    },

    /**
     * hasCredentials()
     * Returns true if PIN/password has been set up
     */
    hasCredentials() {
      return !!getCredentials();
    }

  };

})();

// ── AUTO SESSION MONITOR ─────────────────────────────────
// Checks every minute if session has expired
setInterval(() => {
  if (!Auth.checkSession()) {
    const curPath = window.location.pathname;
    if (!curPath.includes('login.html') && !curPath.includes('setup-profile.html') && !curPath.includes('verify.html')) {
      AuditLog.add('SESSION_EXPIRED', 'Session timed out automatically');
      window.location.href = 'login.html';
    }
  }
}, 60000);

// ── ACTIVITY REFRESH ─────────────────────────────────────
// Refresh session on user interaction
['click', 'keypress', 'touchstart'].forEach(event => {
  document.addEventListener(event, () => {
    if (Auth.checkSession()) {
      Auth.refreshSession();
    }
  }, { passive: true });
});
