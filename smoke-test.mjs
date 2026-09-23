/**
 * ui.js 渲染冒烟测试（开发用，不随包发布）
 *
 * 目的：在没有浏览器的情况下证明各种状态下界面都能渲染出来，
 *       并且【正在输入的口令不会因为轮询而被清空】。
 *
 * 关键设计：DOM 桩的 appendChild 对 null 抛 TypeError —— 与真实 DOM 一致。
 * 这样它就能复现当初那个 bug：renderLock() 在「非首次登录」时传 null 进来，
 * 导致整个渲染函数崩掉、锁页永远不出现（表现为「没权限但还能聊天」）。
 *
 * 运行： node smoke-test.mjs
 */

import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./lib/ui.js', import.meta.url), 'utf8')
const POLL_MS = 5000

function makeDocument() {
  const byId = new Map()

  function makeEl(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      _text: '',
      _value: undefined,
      set textContent(value) {
        this._text = value
      },
      get textContent() {
        return this._text
      },
      /** 与真实 input 一致：先看「用户输入」的值，否则回落到 value 属性。 */
      get value() {
        if (this._value !== undefined) return this._value
        return this.attrs.value !== undefined ? this.attrs.value : ''
      },
      set value(next) {
        this._value = String(next)
      },
      setAttribute(name, value) {
        this.attrs[name] = value
        if (name === 'id') byId.set(value, node)
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
      },
      addEventListener() {},
      removeEventListener() {},
      remove() {
        if (this.attrs.id !== undefined) byId.delete(this.attrs.id)
      },
      closest() {
        return null
      },
      focus() {},
      appendChild(child) {
        if (child === null || child === undefined) {
          throw new TypeError(
            "Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.",
          )
        }
        node.children.push(child)
        return child
      },
    }
    return node
  }

  const head = makeEl('head')
  const body = makeEl('body')
  const html = makeEl('html')
  html.appendChild(head)
  html.appendChild(body)

  const document = {
    readyState: 'complete',
    hidden: false,
    head,
    body,
    documentElement: html,
    createElement: makeEl,
    getElementById: (id) => (byId.has(id) ? byId.get(id) : null),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  }

  return { document, byId }
}

function bootstrap(statusPayload, options = {}) {
  const { document, byId } = makeDocument()
  const timers = []
  const store = new Map(options.collapsed === true ? [['dsh-permission-gate.collapsed', '1']] : [])

  const globals = {
    window: {},
    document,
    fetch: async () => ({ status: 200, json: async () => statusPayload }),
    location: { hostname: '127.0.0.1', protocol: 'http:' },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    crypto: undefined,
    setInterval: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearInterval: () => {},
    setTimeout: (fn) => {
      fn()
      return 1
    },
    console,
  }

  const names = Object.keys(globals)
  let failure = ''
  try {
    // eslint-disable-next-line no-new-func
    new Function(...names, source)(...names.map((name) => globals[name]))
  } catch (error) {
    failure = `同步执行抛错: ${error.message}`
  }

  return { byId, timers, failure }
}

const settle = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)))

function describe(byId) {
  if (byId.get('dsh-permission-gate') !== undefined) return '全屏锁页 #dsh-permission-gate'
  if (byId.get('pg-chip') !== undefined) return '胶囊 #pg-chip'
  if (byId.get('pg-tab') !== undefined) return '右侧窄把手 #pg-tab'
  return '什么都没渲染'
}

async function runRenderCase(label, statusPayload, options) {
  const { byId, failure } = bootstrap(statusPayload, options)
  await settle()
  const what = describe(byId)
  return { label, ok: failure === '' && what === options.expect, what, expect: options.expect, failure }
}

/** 回归测试：锁定时正在输入口令，经过多次轮询后内容必须还在。 */
async function runTypingCase() {
  const label = '锁定 + 正在输入口令 + 连过 3 次轮询 → 内容不被清空'
  const { byId, timers, failure } = bootstrap({
    state: 'locked',
    idleMs: 3600000,
    remainingMs: 0,
    hasCredential: true,
  })
  await settle()

  const input = byId.get('pg-password')
  if (input === undefined) {
    return { label, ok: false, what: '登录页压根没渲染', expect: '输入框存在', failure }
  }
  input.value = 'typed-secret-123'

  const pollTimer = timers.find((timer) => timer.ms === POLL_MS)
  if (pollTimer === undefined) {
    return { label, ok: false, what: '没找到轮询定时器', expect: '存在 5s 轮询', failure }
  }
  for (let i = 0; i < 3; i += 1) {
    pollTimer.fn()
    await settle()
  }

  const after = byId.get('pg-password')
  const kept = after !== undefined ? after.value : '(输入框没了)'
  return {
    label,
    ok: failure === '' && kept === 'typed-secret-123',
    what: `value=${JSON.stringify(kept)}`,
    expect: 'value="typed-secret-123"',
    failure,
  }
}

const renderCases = [
  ['锁定（已设过口令 → confirm 为 null）', { state: 'locked', idleMs: 3600000, remainingMs: 0, hasCredential: true }, { expect: '全屏锁页 #dsh-permission-gate' }],
  ['首次设置口令（confirm 是真实节点）', { state: 'setup', idleMs: 3600000, remainingMs: 0, hasCredential: false }, { expect: '全屏锁页 #dsh-permission-gate' }],
  ['已解锁 → 胶囊', { state: 'unlocked', idleMs: 3600000, remainingMs: 3599000, hasCredential: true }, { expect: '胶囊 #pg-chip' }],
  ['闸门已关闭 → 灰胶囊', { state: 'disabled', idleMs: 3600000, remainingMs: 0, hasCredential: true }, { expect: '胶囊 #pg-chip' }],
  ['已解锁 + 已收起 → 右侧窄把手', { state: 'unlocked', idleMs: 3600000, remainingMs: 3599000, hasCredential: true }, { expect: '右侧窄把手 #pg-tab', collapsed: true }],
  ['锁定 + 已收起 → 仍是锁页（收起只影响胶囊）', { state: 'locked', idleMs: 3600000, remainingMs: 0, hasCredential: true }, { expect: '全屏锁页 #dsh-permission-gate', collapsed: true }],
]

const results = []
for (const [label, payload, options] of renderCases) results.push(await runRenderCase(label, payload, options))
results.push(await runTypingCase())

let pass = 0
for (const result of results) {
  console.log(`${result.ok ? '✅' : '❌'} ${result.label}`)
  console.log(`    ${result.what}（期望 ${result.expect}）${result.failure === '' ? '' : ` | ${result.failure}`}`)
  if (result.ok) pass += 1
}
console.log(`\n${pass}/${results.length} 通过`)
process.exit(pass === results.length ? 0 : 1)
