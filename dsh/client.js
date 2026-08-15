// DeepSeek Harness (dsh) web-profile plugin: login gate + account settings.
//
// Browser half. Written in the lazy-CJS bundle protocol
// (window.__ModuleLoader__.load with a factory returning cordis-plugin
// exports), so it needs no build step and no imports from dsh client packages
// beyond the platform-seeded ones — like the modlens client half.
//
// Registers two surfaces:
//   - a full-screen gate in `shell.overlay` that blocks page interaction until
//     a valid session is present;
//   - an "账号设置" page in `settings.section` for changing username/password
//     and logging out.
//
// RPC is plain same-origin fetch to the host routes (/login-gate/*).
window.__ModuleLoader__.load({
  id: '@dsh-login-gate/auth-gate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var ReactDom = require('react-dom')

    // ---- persisted login state ------------------------------------------------
    // A valid `token` kept in localStorage marks the user as logged in. The
    // token is server-side state (the host writes it to the account file), so
    // a refresh stays logged in and a host restart still authenticates.
    function readSession() {
      try {
        var raw = localStorage.getItem('dsh-login-gate-session')
        if (raw) return JSON.parse(raw)
      } catch (e) {
        return null
      }
      return null
    }
    function writeSession(value) {
      try {
        if (value) localStorage.setItem('dsh-login-gate-session', JSON.stringify(value))
        else localStorage.removeItem('dsh-login-gate-session')
      } catch (e) {
        // storage unavailable: fall through
      }
    }

    // ---- host RPC --------------------------------------------------------
    function apiGet(path, params) {
      var url = path
      if (params) {
        url += '?' + Object.keys(params).map(function (k) {
          return encodeURIComponent(k) + '=' + encodeURIComponent(params[k])
        }).join('&')
      }
      return fetch(url).then(function (res) {
        return res.json().then(function (j) { j._status = res.status; return j })
      })
    }
    function apiPost(path, payload) {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      }).then(function (res) {
        return res.json().then(function (j) { j._status = res.status; return j })
      })
    }

    // ---- shared auth store ------------------------------------------------
    // Module-level store with a subscribe hook so the gate and the settings
    // page read and react to the same login state.
    var store = { status: 'checking', token: null, username: null }
    var listeners = []
    function emit() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i]() } catch (e) { /* a dead subscriber must not break emit */ }
      }
    }
    function setStore(patch) {
      Object.keys(patch).forEach(function (k) { store[k] = patch[k] })
      emit()
    }
    function subscribe(listener) {
      listeners.push(listener)
      return function () {
        var i = listeners.indexOf(listener)
        if (i >= 0) listeners.splice(i, 1)
      }
    }
    // Stable snapshot identity: useSyncExternalStore requires getSnapshot to
    // return the SAME object reference unless the store actually changed,
    // otherwise React treats the store as perpetually dirty and re-renders in
    // an infinite loop. Cache the last snapshot and reuse it until a field
    // differs.
    var lastSnapshot = null
    function snapshot() {
      var cur = { status: store.status, token: store.token, username: store.username }
      if (
        lastSnapshot === null ||
        lastSnapshot.status !== cur.status ||
        lastSnapshot.token !== cur.token ||
        lastSnapshot.username !== cur.username
      ) {
        lastSnapshot = cur
      }
      return lastSnapshot
    }

    function bootstrap() {
      var saved = readSession()
      if (!saved || !saved.token) {
        setStore({ status: 'out' })
        return
      }
      apiGet('/login-gate/status', { token: saved.token }).then(function (res) {
        if (res && res.ok && res.valid) {
          setStore({ status: 'in', token: saved.token, username: res.username })
        } else {
          writeSession(null)
          setStore({ status: 'out' })
        }
      }).catch(function () {
        // Host unreachable (e.g. mid-restart): don't lock the user out.
        setStore({ status: 'in', token: saved.token, username: saved.username })
      })
    }

    function login(username, password) {
      return apiPost('/login-gate/login', { username: username, password: password }).then(function (res) {
        if (res && res.ok) {
          writeSession({ token: res.token, username: res.username })
          setStore({ status: 'in', token: res.token, username: res.username })
          return { ok: true }
        }
        return { ok: false, error: (res && res.error) || '登录失败' }
      }).catch(function () {
        return { ok: false, error: '无法连接服务，请稍后重试' }
      })
    }

    function logout() {
      var token = store.token
      if (token) apiPost('/login-gate/logout', { token: token }).catch(function () {})
      writeSession(null)
      setStore({ status: 'out', token: null, username: null })
    }

    function updateAccount(currentPassword, newUsername, newPassword) {
      return apiPost('/login-gate/update', {
        token: store.token,
        currentPassword: currentPassword,
        newUsername: newUsername,
        newPassword: newPassword,
      }).then(function (res) {
        if (res && res.ok) {
          writeSession({ token: store.token, username: res.username })
          setStore({ username: res.username })
          return { ok: true, username: res.username }
        }
        return { ok: false, error: (res && res.error) || '修改失败' }
      }).catch(function () {
        return { ok: false, error: '无法连接服务，请稍后重试' }
      })
    }

    // ---- React hooks --------------------------------------------------------
    // useSyncExternalStore when available (modern React), else a tick counter.
    function useAuth() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribe, snapshot)
      }
      var tick = React.useState(0)[1]
      React.useEffect(function () {
        return subscribe(function () { tick(function (t) { return t + 1 }) })
      }, [])
      return snapshot()
    }

    // ---- React components ------------------------------------------------------
    function LoginGate() {
      var auth = useAuth()

      var usernameState = React.useState('')
      var username = usernameState[0]
      var setUsername = usernameState[1]
      var passwordState = React.useState('')
      var password = passwordState[0]
      var setPassword = passwordState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      // The gate renders into document.body via createPortal: the settings
      // panel is a fixed z-index:1000 overlay, while shell.overlay lives in a
      // z-index:20 stacking context that can never rise above it. A body-level
      // fixed backdrop (z-index 2147483000) guarantees the gate covers the
      // settings panel and everything else the moment the session ends.
      var body = document.body

      if (auth.status === 'checking') {
        return ReactDom.createPortal(
          React.createElement('div', { className: 'dshlg-backdrop' },
            React.createElement('div', { className: 'dshlg-card' },
              React.createElement('p', { className: 'dshlg-hint' }, '正在验证登录状态…'),
            ),
          ),
          body,
        )
      }
      if (auth.status === 'in') return null

      var onSubmit = function () {
        setBusy(true)
        setError('')
        login(username, password).then(function (res) {
          if (!res.ok) {
            setError(res.error || '登录失败')
            setBusy(false)
          }
        })
      }

      return ReactDom.createPortal(
        React.createElement('div', { className: 'dshlg-backdrop' },
          React.createElement('div', { className: 'dshlg-card' },
            React.createElement('h1', { className: 'dshlg-title' }, 'DeepSeek Harness'),
            React.createElement('p', { className: 'dshlg-sub' }, '登录后即可进入工作区'),
            React.createElement('label', { className: 'dshlg-label' }, '账号'),
            React.createElement('input', {
              className: 'dshlg-input',
              value: username,
              placeholder: '请输入账号',
              autoFocus: true,
              onChange: function (e) { setUsername(e.target.value) },
            }),
            React.createElement('label', { className: 'dshlg-label' }, '密码'),
            React.createElement('input', {
              className: 'dshlg-input',
              type: 'password',
              value: password,
              placeholder: '请输入密码',
              onChange: function (e) { setPassword(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter' && !busy) onSubmit() },
            }),
            error ? React.createElement('p', { className: 'dshlg-error' }, error) : null,
            React.createElement('button', { className: 'dshlg-btn', disabled: busy, onClick: onSubmit },
              busy ? '登录中…' : '登 录'),
          ),
        ),
        body,
      )
    }

    function AccountSettings(props) {
      var auth = useAuth()

      var currentPasswordState = React.useState('')
      var currentPassword = currentPasswordState[0]
      var setCurrentPassword = currentPasswordState[1]
      var newUsernameState = React.useState(auth.username || '')
      var newUsername = newUsernameState[0]
      var setNewUsername = newUsernameState[1]
      var newPasswordState = React.useState('')
      var newPassword = newPasswordState[0]
      var setNewPassword = newPasswordState[1]
      var confirmPasswordState = React.useState('')
      var confirmPassword = confirmPasswordState[0]
      var setConfirmPassword = confirmPasswordState[1]
      var msgState = React.useState('')
      var msg = msgState[0]
      var setMsg = msgState[1]
      var errState = React.useState('')
      var err = errState[0]
      var setErr = errState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      var onSave = function () {
        setMsg('')
        setErr('')
        if (!currentPassword) { setErr('请输入当前密码'); return }
        if (newPassword && newPassword !== confirmPassword) {
          setErr('两次输入的新密码不一致')
          return
        }
        setBusy(true)
        updateAccount(currentPassword, newUsername, newPassword).then(function (res) {
          setBusy(false)
          if (res.ok) {
            setMsg('账号设置已保存（当前账号：' + res.username + '）')
            setCurrentPassword('')
            setNewPassword('')
            setConfirmPassword('')
          } else {
            setErr(res.error || '修改失败')
          }
        })
      }

      return React.createElement('div', { className: 'dshac' },
        React.createElement('h2', { className: 'dshac-title' }, '账号设置'),
        React.createElement('p', { className: 'dshac-desc' },
          '修改登录账号与密码，保存后立即生效。默认账号为 admin / admin123。'),
        React.createElement('label', { className: 'dshac-label' }, '账号名'),
        React.createElement('input', {
          className: 'dshac-input',
          value: newUsername,
          placeholder: '新账号名',
          onChange: function (e) { setNewUsername(e.target.value) },
        }),
        React.createElement('label', { className: 'dshac-label' }, '当前密码'),
        React.createElement('input', {
          className: 'dshac-input',
          type: 'password',
          value: currentPassword,
          placeholder: '请输入当前密码以确认修改',
          onChange: function (e) { setCurrentPassword(e.target.value) },
        }),
        React.createElement('label', { className: 'dshac-label' }, '新密码（留空则不修改）'),
        React.createElement('input', {
          className: 'dshac-input',
          type: 'password',
          value: newPassword,
          placeholder: '至少 4 位',
          onChange: function (e) { setNewPassword(e.target.value) },
        }),
        React.createElement('label', { className: 'dshac-label' }, '确认新密码'),
        React.createElement('input', {
          className: 'dshac-input',
          type: 'password',
          value: confirmPassword,
          placeholder: '再次输入新密码',
          onChange: function (e) { setConfirmPassword(e.target.value) },
        }),
        msg ? React.createElement('p', { className: 'dshac-msg' }, msg) : null,
        err ? React.createElement('p', { className: 'dshac-err' }, err) : null,
        React.createElement('div', { className: 'dshac-row' },
          React.createElement('button', { className: 'dshac-save', disabled: busy, onClick: onSave },
            busy ? '保存中…' : '保存修改'),
          React.createElement('button', {
            className: 'dshac-logout',
            onClick: function () {
              // Only logs the account out (never the app); close the settings
              // panel when the section provided a close handle.
              if (props && typeof props.close === 'function') {
                try { props.close() } catch (e) { /* panel may already be gone */ }
              }
              logout()
            },
          }, '退出登录'),
        ),
      )
    }

    // ---- styles + registration ------------------------------------------------
    ;(function insertStyles() {
      var style = document.createElement('style')
      style.textContent =
        '.dshlg-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-base,#fff);pointer-events:auto;font-family:inherit;}' +
        '.dshlg-card{width:min(360px,calc(100vw - 48px));padding:28px 24px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#ddd);box-shadow:0 12px 40px rgba(0,0,0,.25);box-sizing:border-box;text-align:left;}' +
        '.dshlg-title{margin:0 0 6px;font-size:18px;color:var(--dsw-alias-label-primary,#111);}' +
        '.dshlg-sub{margin:0 0 18px;font-size:13px;color:var(--dsw-alias-label-secondary,#666);}' +
        '.dshlg-label{display:block;margin:12px 0 6px;font-size:13px;color:var(--dsw-alias-label-secondary,#666);}' +
        '.dshlg-input{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#ccc);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font-size:14px;outline:none;}' +
        '.dshlg-input:focus{border-color:var(--dsw-alias-brand-primary,#2563eb);}' +
        '.dshlg-error{margin:12px 0 0;font-size:13px;color:var(--dsw-alias-state-error-primary,#dc2626);}' +
        '.dshlg-hint{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary,#666);}' +
        '.dshlg-btn{width:100%;margin-top:18px;padding:10px 0;border:none;border-radius:8px;background:var(--dsw-alias-brand-primary,#2563eb);color:#fff;font-size:15px;cursor:pointer;}' +
        '.dshlg-btn:disabled{opacity:.6;cursor:default;}' +
        '.dshac{padding:4px 0 20px;text-align:left;}' +
        '.dshac-title{margin:0 0 6px;font-size:16px;color:var(--dsw-alias-label-primary,#111);}' +
        '.dshac-desc{margin:0 0 16px;font-size:13px;color:var(--dsw-alias-label-secondary,#666);}' +
        '.dshac-label{display:block;margin:14px 0 6px;font-size:13px;color:var(--dsw-alias-label-secondary,#666);}' +
        '.dshac-input{width:100%;max-width:420px;box-sizing:border-box;padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#ccc);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font-size:14px;outline:none;}' +
        '.dshac-input:focus{border-color:var(--dsw-alias-brand-primary,#2563eb);}' +
        '.dshac-msg{margin:12px 0 0;font-size:13px;color:var(--dsw-alias-state-success-primary,#16a34a);}' +
        '.dshac-err{margin:12px 0 0;font-size:13px;color:var(--dsw-alias-state-error-primary,#dc2626);}' +
        '.dshac-row{display:flex;gap:10px;margin-top:18px;}' +
        '.dshac-save,.dshac-logout{padding:9px 18px;border-radius:8px;font-size:14px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#ccc);}' +
        '.dshac-save{background:var(--dsw-alias-brand-primary,#2563eb);color:#fff;border-color:transparent;}' +
        '.dshac-save:disabled{opacity:.6;cursor:default;}' +
        '.dshac-logout{background:transparent;color:var(--dsw-alias-state-error-primary,#dc2626);}' +
        '.dshac-logout:hover{text-decoration:underline;}' +
        '.dshlg-settings-logout{background:transparent;border:1px solid var(--dsw-alias-state-error-primary,#dc2626);color:var(--dsw-alias-state-error-primary,#dc2626);padding:5px 12px;border-radius:8px;font-size:13px;cursor:pointer;}' +
        '.dshlg-settings-logout:hover{background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff;}'
      document.head.appendChild(style)
    })()

    // The loader invokes the exported `apply`, so registration and boot go here.
    function pluginApply(ctx) {
      // Settings header action: a prominent red 退出登录 visible from any
      // settings page. It only logs the account out (never the app); the gate
      // re-appears at body level and covers the still-open panel.
      var SettingsLogoutAction = function () {
        return React.createElement('button', {
          className: 'dshlg-settings-logout',
          onClick: function () { logout() },
        }, '退出登录')
      }

      ctx.effect(function () {
        var slots = ctx.slots
        if (!slots) return function () {}
        var disposes = []
        // Login gate: rendered at document.body level (createPortal) so it
        // covers the settings panel and every shell layer.
        disposes.push(slots.inject('shell.overlay', function () {
          return slots.register(
            { name: 'shell.overlay', id: 'login-gate', order: 100 },
            function () { return React.createElement(LoginGate, null) },
          )
        }))
        // Account settings section: change username/password and log out.
        disposes.push(slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'account', order: 30, label: '账号设置' },
            function (props) { return React.createElement(AccountSettings, props) },
          )
        }))
        // Settings header logout action.
        disposes.push(slots.inject('settings.action', function () {
          return slots.register(
            { name: 'settings.action', id: 'login-gate-logout', order: 0 },
            function () { return React.createElement(SettingsLogoutAction, null) },
          )
        }))
        return function () {
          disposes.forEach(function (d) {
            try { d() } catch (e) { /* already removed */ }
          })
        }
      })
      bootstrap()
    }

    exports.apply = pluginApply
    exports.inject = ['slots']

    return module.exports
  },
})
