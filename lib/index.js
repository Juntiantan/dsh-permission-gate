/**
 * DSH 权限闸门 —— 持久化 Cordis 插件（宿主半边）
 *
 * 设计要点
 * ─────────────────────────────────────────────────────────────
 * 1. 全局共享会话：整个进程只有【一个】会话与【一个】60 分钟空闲时钟。
 *    任一端登录 → 所有端解锁；任一端有动作 → 时钟续期；
 *    时钟到期 → 所有端在下一次轮询时一起弹回登录页。
 *
 * 2. 凭据落盘（node:fs），会话不落盘：
 *    - 口令摘要写在 ~/.dsh/permission-gate.json（scrypt + 随机盐）
 *    - 会话只在内存 → DSH 重启 = 必须重新登录，但口令不会被重置
 *
 * 3. 全进程工具拦截：ctx.tools.guard() —— 锁定时拒绝一切工具调用。
 *    这是唯一与「入口」无关的制动点：不管请求从手机、电脑还是本机进程来。
 *
 * 4. 界面通过 webServer 的 index-inject 注入（官方结构化注入通道），
 *    不需要客户端插件包、不需要模块加载器、不需要 Remote RPC。
 *
 * 退出通道（重要）
 * ─────────────────────────────────────────────────────────────
 *   · 浏览器访问 /gate  → 始终可用的服务端登录页（不依赖注入的脚本）
 *   · 口令             → 唯一能关闭闸门的东西
 *   · 删除/编辑 ~/.dsh/permission-gate.json → 重置为「首次设置」状态
 *   （持久插件没有 cordis_stop 那种工具逃生门 —— 那套只属于动态插件。）
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_PATH = join(HERE, 'ui.js')

const IDLE_MS = 60 * 60 * 1000
const COOKIE_NAME = 'dsh_gate'
const STATE_FILE = join(homedir(), '.dsh', 'permission-gate.json')
const MAX_BODY_BYTES = 4096
const SCRYPT_KEYLEN = 64
const MAX_FAILS = 5
const BLOCK_MS = 60 * 1000
const SESSION_TOKEN_BYTES = 32

const LOCK_REASON =
  '⛔ DSH 权限闸门（严格模式）：当前没有「已登录且活跃」的会话 —— 尚未登录，或已空闲满 60 分钟。' +
  '按闸门设置，任务运行中也不例外，正在进行的任务可能因此中断。请在 DSH 界面（或 /gate）登录解锁后重试。'

// ── 状态 ────────────────────────────────────────────────────────────────

/** @type {{ version: number, enabled: boolean, salt: string, hash: string, createdAt: number }} */
let persisted = { version: 1, enabled: true, salt: '', hash: '', createdAt: 0 }

/** 全局唯一会话（内存态，重启即失效）。 */
let session = { token: '', lastActivity: 0, issuedAt: 0 }
let failures = 0
let blockedUntil = 0

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return
    const raw = readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      persisted = {
        version: 1,
        enabled: parsed.enabled !== false,
        salt: typeof parsed.salt === 'string' ? parsed.salt : '',
        hash: typeof parsed.hash === 'string' ? parsed.hash : '',
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
      }
    }
  } catch (error) {
    console.error('[permission-gate] 读取状态文件失败，按未初始化处理：', error)
  }
}

function saveState() {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(persisted, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    console.error('[permission-gate] 写入状态文件失败：', error)
  }
}

const hasCredential = () => persisted.salt !== '' && persisted.hash !== ''

function derive(password, salt) {
  return scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
}

function verify(password) {
  if (!hasCredential()) return false
  const expected = Buffer.from(persisted.hash, 'hex')
  const actual = Buffer.from(derive(password, persisted.salt), 'hex')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

function setPassword(password) {
  const salt = randomBytes(16).toString('hex')
  persisted.salt = salt
  persisted.hash = derive(password, salt)
  persisted.createdAt = Date.now()
  saveState()
}

// ── 会话 ────────────────────────────────────────────────────────────────

function unlock() {
  session = {
    token: randomBytes(SESSION_TOKEN_BYTES).toString('hex'),
    lastActivity: Date.now(),
    issuedAt: Date.now(),
  }
  return session.token
}

function lockSession() {
  session = { token: '', lastActivity: 0, issuedAt: 0 }
}

function sessionState() {
  if (!persisted.enabled) return { state: 'disabled', remainingMs: 0 }
  if (session.token === '') return { state: hasCredential() ? 'locked' : 'setup', remainingMs: 0 }
  const remainingMs = session.lastActivity + IDLE_MS - Date.now()
  if (remainingMs <= 0) {
    lockSession()
    return { state: 'locked', remainingMs: 0, expired: true }
  }
  return { state: 'unlocked', remainingMs }
}

/** 工具拦截判定：闸门关闭 → 放行；有活跃会话 → 放行；否则拒绝。 */
function toolDenial() {
  if (!persisted.enabled) return undefined
  const current = sessionState()
  if (current.state === 'unlocked') return undefined
  return LOCK_REASON
}

// ── HTTP 工具函数 ───────────────────────────────────────────────────────

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
    ...extraHeaders,
  })
  res.end(html)
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        resolve('')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

async function readJsonBody(req) {
  const text = await readBody(req)
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function parseCookies(req) {
  const header = req.headers.cookie
  const out = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return out
}

function requestIsHttps(req) {
  const proto = req.headers['x-forwarded-proto']
  if (typeof proto === 'string') return proto.split(',')[0].trim() === 'https'
  return false
}

function cookieHeader(req, token, maxAgeSeconds) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (requestIsHttps(req)) parts.push('Secure')
  return parts.join('; ')
}

function tokenFromRequest(req) {
  const cookies = parseCookies(req)
  const token = cookies[COOKIE_NAME]
  return typeof token === 'string' ? token : ''
}

/** 该请求是否持有一个仍活跃的会话（不看请求来源，只管凭据）。 */
function requestIsUnlocked(req) {
  const current = sessionState()
  if (current.state !== 'unlocked') return false
  const token = tokenFromRequest(req)
  return token !== '' && token === session.token
}

// ── 服务端登录页（永远可用的退路） ──────────────────────────────────────

function loginPage(message) {
  const current = sessionState()
  const isSetup = current.state === 'setup'
  const note = message === '' ? '' : `<p class="err">${message}</p>`
  const title = isSetup ? '设置访问口令' : '需要登录才能继续'
  const hint = isSetup
    ? '首次使用：为 DSH 设置访问口令。口令摘要保存在 ~/.dsh/permission-gate.json，DSH 重启后依然有效。'
    : '会话已锁定。输入访问口令以恢复权限。'
  const extra = isSetup
    ? '<input name="confirm" type="password" placeholder="再输入一次口令" autocomplete="off" required>'
    : ''
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 权限闸门</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
 background:radial-gradient(1100px 680px at 50% -18%,rgba(88,124,255,.20),transparent 62%),
 radial-gradient(820px 560px at 92% 114%,rgba(232,195,122,.14),transparent 58%),#05070c;
 color:#e9eefb;font-family:ui-sans-serif,system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.card{width:min(440px,100%);border-radius:20px;padding:26px;background:linear-gradient(180deg,rgba(20,26,40,.94),rgba(10,14,23,.97));
 border:1px solid rgba(255,255,255,.09);box-shadow:0 30px 80px rgba(0,0,0,.6)}
.brand{font-size:11px;letter-spacing:.16em;color:#8d9ab4;font-weight:600;margin-bottom:16px}
h1{margin:0 0 10px;font-size:21px;font-weight:650;color:#f2f6ff}
p{margin:0 0 16px;font-size:12.5px;line-height:1.7;color:#94a2bb}
.err{color:#ffb4b4;background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.24);
 border-radius:10px;padding:9px 12px;margin-bottom:12px}
form{display:flex;flex-direction:column;gap:10px}
input{height:44px;padding:0 14px;border-radius:11px;background:rgba(255,255,255,.045);
 border:1px solid rgba(255,255,255,.12);color:#eef3ff;font-size:14px;letter-spacing:.06em;outline:none}
input:focus{border-color:rgba(232,195,122,.6)}
button{height:44px;border:none;border-radius:11px;cursor:pointer;font-size:14px;font-weight:650;
 color:#17130a;background:linear-gradient(180deg,#f0d293,#d3ab63)}
.foot{margin-top:16px;padding-top:13px;border-top:1px solid rgba(255,255,255,.07);
 font-size:11px;line-height:1.9;color:#6f7d97}
</style></head>
<body><div class="card">
<div class="brand">◈ DEEPSEEK HARNESS · 权限闸门</div>
<h1>${title}</h1>
<p>${hint}</p>
${note}
<form method="POST" action="/gate/login" autocomplete="off">
<input name="password" type="password" placeholder="${isSetup ? '设置口令（至少 4 位）' : '访问口令'}" autofocus required>
${extra}
<input type="hidden" name="mode" value="${isSetup ? 'setup' : 'login'}">
<button type="submit">${isSetup ? '设置口令并进入' : '登录解锁'}</button>
</form>
<div class="foot">
<div>空闲上限 <b>60:00</b> · 严格模式，到点即锁（所有端共享一个时钟）</div>
<div>全局共享：任一端登录，所有端解锁；到期后所有端一起回落</div>
</div>
</div></body></html>`
}

// ── 插件本体 ────────────────────────────────────────────────────────────

export const name = 'permission-gate'
export const inject = ['webServer', 'tools']

export function apply(ctx) {
  loadState()
  console.log(
    `[permission-gate] 已装载 · 闸门${persisted.enabled ? '开启' : '关闭'} · ` +
      `凭据${hasCredential() ? '已设置' : '未设置'} · 状态文件 ${STATE_FILE}`,
  )

  // ── 工具层制动：与「入口」无关，全进程生效 ──────────────────────────
  //
  // guard 是单调的（官方语义：no guard can force-allow a call another guard
  // denied），所以只要这里拒绝，别的插件无法翻案。
  //
  // 关于豁免：只有下面这一组「记账类工具」被放行，而且刻意收得极小 ——
  //   get_goal / update_goal / todo_write 只读写【本会话的任务与目标状态】，
  //   碰不到任何文件、命令、会话内容、凭据或网络。
  // 为什么需要它：零豁免时，闸门一合上我就连「汇报状态、关闭任务」都做不到，
  //   只能干等（这个死结真实发生过，会让被锁住的 agent 彻底无法汇报和收尾）。
  //   它不削弱「锁定时无法访问 DSH 里任何东西」这条要求本身。
  // 不想要它：删掉下面 if 那一行即可（改动源码需重启生效）。
  const BOOKKEEPING_TOOLS = new Set(['get_goal', 'update_goal', 'todo_write'])

  ctx.effect(() =>
    ctx.tools.guard((execution) => {
      let toolName = ''
      try {
        toolName =
          execution !== null && execution !== undefined && typeof execution.name === 'string'
            ? execution.name
            : ''
      } catch {
        toolName = ''
      }
      if (BOOKKEEPING_TOOLS.has(toolName)) return undefined
      return toolDenial()
    }),
  )

  // ── 把界面注入每一个页面（官方结构化注入通道） ─────────────────────
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script-src', placement: 'body', src: '/gate/ui.js' })
  })

  // ── 路由 ────────────────────────────────────────────────────────────
  const routes = []

  routes.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/gate',
      handler: (req, res) => {
        if (requestIsUnlocked(req)) {
          res.writeHead(302, { location: '/', 'cache-control': 'no-store' })
          res.end()
          return
        }
        sendHtml(res, 200, loginPage(''))
      },
    }),
  )

  routes.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/gate/ui.js',
      handler: (_req, res) => {
        try {
          const script = readFileSync(UI_PATH, 'utf8')
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(script),
          })
          res.end(script)
        } catch (error) {
          console.error('[permission-gate] 读取 ui.js 失败：', error)
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('permission gate ui unavailable')
        }
      },
    }),
  )

  // 状态：不刷新活动时间（否则开着的标签页会让闸门永不失效）
  routes.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/gate/status',
      handler: (req, res) => {
        const current = sessionState()
        sendJson(res, 200, {
          state: current.state,
          expires: current.expired === true,
          remainingMs: current.remainingMs,
          idleMs: IDLE_MS,
          hasCredential: hasCredential(),
          authenticated: requestIsUnlocked(req),
        })
      },
    }),
  )

  routes.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/gate/login',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          res.writeHead(302, { location: '/gate', 'cache-control': 'no-store' })
          res.end()
          return
        }

        const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : ''
        let password = ''
        let mode = 'login'
        if (contentType.includes('application/json')) {
          const body = await readJsonBody(req)
          password = typeof body.password === 'string' ? body.password : ''
          mode = body.mode === 'setup' ? 'setup' : 'login'
        } else {
          const text = await readBody(req)
          const params = new URLSearchParams(text)
          password = params.get('password') ?? ''
          mode = params.get('mode') === 'setup' ? 'setup' : 'login'
          const confirm = params.get('confirm') ?? ''
          if (mode === 'setup' && password !== confirm) {
            sendHtml(res, 400, loginPage('两次输入的口令不一致。'))
            return
          }
        }

        const wantsJson = contentType.includes('application/json')
        const now = Date.now()

        if (blockedUntil > now) {
          const waitSec = Math.ceil((blockedUntil - now) / 1000)
          if (wantsJson) sendJson(res, 429, { ok: false, error: `尝试过于频繁，请 ${waitSec} 秒后再试。` })
          else sendHtml(res, 429, loginPage(`尝试过于频繁，请 ${waitSec} 秒后再试。`))
          return
        }

        if (mode === 'setup' && hasCredential()) {
          if (wantsJson) sendJson(res, 409, { ok: false, error: '口令已经设置过了，请直接登录。' })
          else sendHtml(res, 409, loginPage('口令已经设置过了，请直接登录。'))
          return
        }

        if (mode === 'setup') {
          if (password.length < 4) {
            if (wantsJson) sendJson(res, 400, { ok: false, error: '口令至少需要 4 位。' })
            else sendHtml(res, 400, loginPage('口令至少需要 4 位。'))
            return
          }
          setPassword(password)
          console.log('[permission-gate] 口令已设置')
        } else if (!verify(password)) {
          failures += 1
          if (failures >= MAX_FAILS) {
            failures = 0
            blockedUntil = now + BLOCK_MS
          }
          const message = blockedUntil > now ? '口令错误达到上限，已临时封锁 60 秒。' : '口令错误。'
          if (wantsJson) sendJson(res, 401, { ok: false, error: message })
          else sendHtml(res, 401, loginPage(message))
          return
        }

        failures = 0
        blockedUntil = 0
        const token = unlock()
        const maxAge = Math.floor(IDLE_MS / 1000)
        const headers = { 'set-cookie': cookieHeader(req, token, maxAge) }
        if (wantsJson) {
          sendJson(res, 200, { ok: true, remainingMs: IDLE_MS, idleMs: IDLE_MS }, headers)
        } else {
          res.writeHead(302, { location: '/', 'cache-control': 'no-store', ...headers })
          res.end()
        }
      },
    }),
  )

  // 活动上报：只要全局会话处于解锁状态，任何一端都能续期。
  //
  // 【修掉的 bug】原先这里用 requestIsUnlocked(req) 要求 cookie 与
  // 当前会话 token 匹配。但会话是【全局】的，cookie 是【按浏览器】的：
  // DSH 重启后（或从另一端重新登录后）只有登录的那个浏览器拿到新 cookie，
  // 其它页面的 cookie 一律失效 → touch 全部 401 → 活动永远不续期 →
  // 表现为「我一直在操作，倒计时却只减不增」，直到 60 分钟到点被锁。
  //
  // 语义澄清：touch 不授予任何权限，它只声明「有个人在」。创建会话仍然
  // 只有一条路 —— 口令。而这条接口本身已位于 ZeroTier + Caddy 来源白名单
  // + DSH 同源围栏之后，所以放开 cookie 校验不构成新的越权面。
  routes.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/gate/touch',
      handler: async (req, res) => {
        await readBody(req)
        const current = sessionState()
        if (current.state !== 'unlocked') {
          sendJson(res, 401, { ok: false, ...current })
          return
        }
        session.lastActivity = Date.now()
        sendJson(res, 200, { ok: true, state: 'unlocked', remainingMs: IDLE_MS, idleMs: IDLE_MS })
      },
    }),
  )

  routes.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/gate/lock',
      handler: async (req, res) => {
        await readBody(req)
        lockSession()
        sendJson(res, 200, { ok: true, ...sessionState() }, {
          'set-cookie': cookieHeader(req, '', 0),
        })
      },
    }),
  )

  // 关闭 / 重新开启闸门 —— 唯一需要口令的管理动作
  routes.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/gate/mode',
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        const password = typeof body.password === 'string' ? body.password : ''
        const enable = body.enable === true
        if (!hasCredential()) {
          sendJson(res, 409, { ok: false, error: '尚未设置口令。' })
          return
        }
        if (!verify(password)) {
          sendJson(res, 401, { ok: false, error: '口令错误。' })
          return
        }
        persisted.enabled = enable
        saveState()
        if (!enable) lockSession()
        else unlock()
        console.log(`[permission-gate] 闸门已${enable ? '开启' : '关闭'}`)
        sendJson(res, 200, { ok: true, ...sessionState() })
      },
    }),
  )

  ctx.effect(() => () => {
    for (const dispose of routes) {
      try {
        dispose()
      } catch (error) {
        console.error('[permission-gate] 路由卸载失败：', error)
      }
    }
  })

  console.log('[permission-gate] 路由与工具拦截已就位')
}

export default { name, inject, apply }
