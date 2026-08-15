// DeepSeek Harness (dsh) web-profile plugin: a login gate + account settings.
//
// Host half. Registers four webServer routes (`/login-gate/*`) that the
// browser half calls for status/login/logout/update. Credentials live on disk
// (see account-store.js): the password is stored only as a salted scrypt hash,
// and account/username/token edits persist across host restarts.
//
// Loaded via a row this bundle's cordis.patch.yml inserts. `webServer` is
// provided by the web-app bundle's `webserver` row, always present under the
// web profile. It is a hard injection here because under this profile the
// route surface is the entire reason the plugin exists.
import { ensureAccount, getAccount, hashPassword, issueToken, setAccount, verifyPassword } from './account-store.js'

export const name = 'login-gate'
export const inject = ['webServer']

const OK = 'application/json'

// sendError carries a stable `code` (not localized text): the browser half
// translates codes into the active locale, so one response serves both
// languages.
function sendError(res, httpCode, code, fallback) {
  res.writeHead(httpCode, { 'content-type': OK })
  res.end(JSON.stringify({ ok: false, code: code, error: fallback || code }))
}
function sendOk(res, payload = {}) {
  res.writeHead(200, { 'content-type': OK })
  res.end(JSON.stringify({ ok: true, ...payload }))
}

/** Collect the request body up to a size cap; null past the cap. */
async function readBody(req, cap = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > cap) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parsePayload(body) {
  if (!body) return null
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

export function apply(ctx) {
  // Ensure the default account exists at boot, before any client can ask.
  ensureAccount()

  function route(path, handler) {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          if (req.method === 'OPTIONS') {
            res.writeHead(204)
            res.end()
            return
          }
          try {
            await handler(req, res)
          } catch (error) {
            sendError(res, 500, 'server-error', error && error.message ? error.message : 'server error')
          }
        },
      }),
    )
  }

  // GET /login-gate/status?token=... -> { valid, username }
  route('/login-gate/status', async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const token = url.searchParams.get('token')
    const account = getAccount()
    const valid = token === account.sessionToken
    sendOk(res, { valid, username: account.username })
  })

  // POST /login-gate/login -> { token, username }
  route('/login-gate/login', async (req, res) => {
    const payload = parsePayload(await readBody(req))
    const username = payload && payload.username
    const password = payload && payload.password
    if (typeof username !== 'string' || typeof password !== 'string') {
      sendError(res, 400, 'missing-credentials')
      return
    }
    const account = getAccount()
    if (username === account.username && verifyPassword(password, account.password)) {
      const token = issueToken()
      setAccount({ ...account, sessionToken: token })
      sendOk(res, { token, username: account.username })
      return
    }
    sendError(res, 401, 'bad-credentials')
  })

  // POST /login-gate/logout -> clears the session (idempotent)
  route('/login-gate/logout', async (req, res) => {
    const payload = parsePayload(await readBody(req))
    const account = getAccount()
    if (payload && typeof payload.token === 'string' && payload.token === account.sessionToken) {
      setAccount({ ...account, sessionToken: null })
    }
    sendOk(res)
  })

  // POST /login-gate/update -> change username and/or password
  route('/login-gate/update', async (req, res) => {
    const payload = parsePayload(await readBody(req))
    const token = payload && payload.token
    const account = getAccount()
    if (token !== account.sessionToken) {
      sendError(res, 401, 'session-expired')
      return
    }
    const currentPassword = payload && payload.currentPassword
    if (!verifyPassword(currentPassword, account.password)) {
      sendError(res, 401, 'wrong-current-password')
      return
    }
    const next = { ...account, sessionToken: token }
    let changed = false
    const newUsername = payload && payload.newUsername
    if (typeof newUsername === 'string' && newUsername.trim().length > 0) {
      next.username = newUsername.trim()
      changed = true
    }
    const newPassword = payload && payload.newPassword
    if (typeof newPassword === 'string' && newPassword.length > 0) {
      if (newPassword.length < 4) {
        sendError(res, 400, 'password-too-short')
        return
      }
      next.password = hashPassword(newPassword)
      changed = true
    }
    if (!changed) {
      sendError(res, 400, 'nothing-to-save')
      return
    }
    const saved = setAccount(next)
    sendOk(res, { username: saved.username })
  })

  route('/login-gate/ping', async (_req, res) => {
    sendOk(res, { ready: true })
  })
}
