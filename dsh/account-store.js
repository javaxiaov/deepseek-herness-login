// Persistent login-gate credential store.
//
// Owns <profile>/login-gate-accounts.json (the profile root) as the single
// source of truth for the gate: the account username, the password as a
// salted scrypt hash, and the active session token. Reads at boot, writes
// atomically (write-temp + rename) on every mutation, so account/password
// edits survive a host restart and a crash never leaves a partial file.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Anchor on the profile root: this file lives at
// <profile>/node_modules/@dsh-login-gate/auth-gate/dsh/ (a symlink to
// <profile>/bundles/auth-gate/dsh/), so four directory hops up is the profile
// root, where the account document lives.
const PROFILE_DIR = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
export const ACCOUNT_FILE = join(PROFILE_DIR, 'login-gate-accounts.json')

// scrypt cost parameters. Iteration/logN stepped down for an interactive
// dialog box: modest and fixed (not tunable), matching the gate's role as a
// page-access check rather than a defence of high-value secrets.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }
const TOKEN_BYTES = 24

/** Parse the on-disk account document, tolerating absence and old shapes. */
function readAccount() {
  if (!existsSync(ACCOUNT_FILE)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8'))
    if (
      parsed &&
      typeof parsed.username === 'string' &&
      typeof parsed.password === 'string'
    ) {
      return {
        username: parsed.username,
        password: parsed.password,
        sessionToken: typeof parsed.sessionToken === 'string' ? parsed.sessionToken : null,
      }
    }
  } catch {
    // Fall through to a fresh default account.
  }
  return null
}

/** Atomically persist the account document. */
function writeAccount(account) {
  const temp = `${ACCOUNT_FILE}.tmp`
  writeFileSync(temp, JSON.stringify(account, null, 2), 'utf8')
  renameSync(temp, ACCOUNT_FILE)
}

/**
 * Create the default account (admin / admin123) when none exists. Used at
 * boot and as an explicit reset. Returns the created account with the hash
 * already applied.
 */
export function ensureAccount() {
  const existing = readAccount()
  if (existing) return existing
  const account = {
    username: 'admin',
    password: hashPassword('admin123'),
    sessionToken: null,
  }
  writeAccount(account)
  return account
}

/** The live account: ensure the default exists, then read current state. */
export function getAccount() {
  return ensureAccount()
}

/** Re-derive and persist the account after an edit. */
export function setAccount(account) {
  const next = {
    username: account.username,
    password: account.password,
    sessionToken: account.sessionToken,
  }
  writeAccount(next)
  return next
}

/** Hash a plaintext password into the versioned scrypt record. */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('base64')
  const derived = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  }).toString('base64')
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${derived}`
}

/**
 * Constant-time password check against a stored record. Handles both the
 * current scrypt format and a legacy plaintext record.
 */
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts[0] === 'scrypt') {
    try {
      const [, N, r, p, salt, expected] = parts
      const actual = scryptSync(password, salt, SCRYPT.keylen, {
        N: Number(N),
        r: Number(r),
        p: Number(p),
      })
      return timingSafeEqual(actual, Buffer.from(expected, 'base64'))
    } catch {
      return false
    }
  }
  // Legacy format from the earlier dynamic plugin, kept so an existing
  // pre-hash account still authenticates.
  const bufA = Buffer.from(String(password), 'utf8')
  const bufB = Buffer.from(stored, 'base64')
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/** Fresh opaque session token. */
export function issueToken() {
  return randomBytes(TOKEN_BYTES).toString('base64')
}
