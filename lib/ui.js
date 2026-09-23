/**
 * DSH 权限闸门 —— 注入浏览器的界面脚本
 *
 * 由宿主半边通过 webServer 的 index-inject 通道注入到每个页面的 <body> 之后，
 * 通过同源 fetch 与宿主通信（不需要客户端插件包、不需要 Remote RPC）。
 *
 * 状态源只有一个：服务端。本脚本不做任何本地裁决 —— 它只是渲染服务端状态。
 * 所以「任一端登录 → 所有端解锁」「到期 → 所有端一起弹回」是自动成立的。
 */
(function () {
  'use strict'

  if (window.__DSH_PERMISSION_GATE__) return
  window.__DSH_PERMISSION_GATE__ = true

  var POLL_MS = 5000
  // 与轮询同频：用户一动就续期，倒计时会稳定停在 59:5x–60:00，
  // 一眼就能看出「活动被记录到了」。
  var TOUCH_MS = 5000
  var ROOT_ID = 'dsh-permission-gate'

  // 「收起 / 呼出」偏好：收起到右侧后，刷新页面依然保持收起。
  var COLLAPSE_KEY = 'dsh-permission-gate.collapsed'
  function readCollapsed() {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch (error) {
      return false
    }
  }
  function writeCollapsed(value) {
    try {
      localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0')
    } catch (error) {
      /* 隐私模式等场景下静默忽略 */
    }
  }

  var state = {
    status: 'boot', // boot | setup | locked | unlocked | disabled
    remainingMs: 0,
    idleMs: 60 * 60 * 1000,
    error: '',
    busy: false,
    lastTouch: 0,
    panelOpen: false,
    localDeadline: 0,
    collapsed: readCollapsed(),
    listeners: []
  }

  var css =
    '#' + ROOT_ID + '{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;' +
    'padding:24px;box-sizing:border-box;pointer-events:auto;' +
    'background:radial-gradient(1100px 680px at 50% -18%,rgba(88,124,255,.20),transparent 62%),' +
    'radial-gradient(820px 560px at 92% 114%,rgba(232,195,122,.14),transparent 58%),#05070c;' +
    'color:#e9eefb;font-family:ui-sans-serif,system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}' +
    '#' + ROOT_ID + ' .pg-card{position:relative;width:min(452px,100%);box-sizing:border-box;border-radius:20px;' +
    'padding:24px 26px 18px;background:linear-gradient(180deg,rgba(20,26,40,.94),rgba(10,14,23,.97));' +
    'border:1px solid rgba(255,255,255,.09);box-shadow:0 30px 80px rgba(0,0,0,.6)}' +
    '#' + ROOT_ID + ' .pg-brand{font-size:11px;letter-spacing:.16em;color:#8d9ab4;font-weight:600;margin-bottom:18px}' +
    '#' + ROOT_ID + ' h1{margin:0 0 10px;font-size:21px;font-weight:650;color:#f2f6ff}' +
    '#' + ROOT_ID + ' p{margin:0 0 16px;font-size:12.5px;line-height:1.7;color:#94a2bb}' +
    '#' + ROOT_ID + ' .pg-err{margin:0 0 12px;padding:9px 12px;border-radius:10px;font-size:12.5px;line-height:1.6;' +
    'color:#ffb4b4;background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.24)}' +
    '#' + ROOT_ID + ' form{display:flex;flex-direction:column;gap:10px}' +
    '#' + ROOT_ID + ' input{height:44px;box-sizing:border-box;padding:0 14px;border-radius:11px;' +
    'background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.12);color:#eef3ff;font-size:14px;' +
    'letter-spacing:.06em;outline:none}' +
    '#' + ROOT_ID + ' input:focus{border-color:rgba(232,195,122,.6);background:rgba(255,255,255,.07)}' +
    '#' + ROOT_ID + ' button{height:44px;border:none;border-radius:11px;cursor:pointer;font-size:14px;font-weight:650;' +
    'color:#17130a;background:linear-gradient(180deg,#f0d293,#d3ab63)}' +
    '#' + ROOT_ID + ' button[disabled]{opacity:.55;cursor:default}' +
    '#' + ROOT_ID + ' .pg-foot{margin-top:16px;padding-top:13px;border-top:1px solid rgba(255,255,255,.07);' +
    'font-size:11px;line-height:1.9;color:#6f7d97}' +
    '#' + ROOT_ID + ' .pg-foot b{color:#a9b6cc}' +
    // 胶囊
    '#pg-chip{position:fixed;right:14px;bottom:14px;z-index:2147483000;display:flex;align-items:center;gap:8px;' +
    'padding:5px 6px 5px 11px;border-radius:999px;background:rgba(9,13,20,.86);border:1px solid rgba(255,255,255,.11);' +
    'box-shadow:0 10px 30px rgba(0,0,0,.42);backdrop-filter:blur(9px);color:#c8d3e6;font-size:11.5px;' +
    'font-family:ui-sans-serif,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;opacity:.75;transition:opacity .15s}' +
    '#pg-chip:hover{opacity:1}' +
    '#pg-chip .pg-dot{width:7px;height:7px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 3px rgba(74,222,128,.15)}' +
    '#pg-chip .pg-dot.off{background:#8d9ab4;box-shadow:0 0 0 3px rgba(141,154,180,.15)}' +
    '#pg-chip .pg-time{font-variant-numeric:tabular-nums;color:#8fe6b0}' +
    '#pg-chip button{height:24px;padding:0 10px;border-radius:999px;border:1px solid rgba(255,255,255,.14);' +
    'background:rgba(255,255,255,.05);color:#c8d3e6;font-size:11px;cursor:pointer}' +
    '#pg-chip button:hover{background:rgba(255,107,107,.14);border-color:rgba(255,107,107,.32);color:#ffb4b4}' +
    // 设置面板
    '#pg-panel{position:fixed;right:14px;bottom:56px;z-index:2147483000;width:min(360px,calc(100vw - 28px));' +
    'box-sizing:border-box;padding:16px 18px;border-radius:16px;background:linear-gradient(180deg,rgba(20,26,40,.97),rgba(10,14,23,.98));' +
    'border:1px solid rgba(255,255,255,.11);box-shadow:0 24px 60px rgba(0,0,0,.6);color:#e9eefb;' +
    'font-family:ui-sans-serif,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;font-size:12.5px}' +
    '#pg-panel h2{margin:0 0 6px;font-size:14px;font-weight:650;color:#f2f6ff}' +
    '#pg-panel p{margin:0 0 12px;color:#94a2bb;line-height:1.7;font-size:11.5px}' +
    '#pg-panel input{width:100%;height:38px;margin-bottom:8px}' +
    '#pg-panel .pg-row{display:flex;gap:8px}' +
    '#pg-panel .pg-row button{flex:1;height:38px;font-size:12.5px}' +
    '#pg-panel .pg-danger{background:linear-gradient(180deg,#ffb4b4,#e08a8a)}' +
    '#pg-panel .pg-ok{background:linear-gradient(180deg,#a9e6c3,#7fcf9f)}' +
    '#pg-panel .pg-msg{margin:8px 0 0;font-size:11.5px;color:#ffb4b4;min-height:16px}' +
    // 收起后贴在右侧边缘的窄把手（点它呼出胶囊）
    '#pg-tab{position:fixed;right:0;top:46%;transform:translateY(-50%);z-index:2147483000;' +
    'display:flex;flex-direction:column;align-items:center;gap:7px;padding:11px 5px;' +
    'border-radius:10px 0 0 10px;cursor:pointer;background:rgba(9,13,20,.86);' +
    'border:1px solid rgba(255,255,255,.11);border-right:none;box-shadow:0 10px 30px rgba(0,0,0,.42);' +
    'backdrop-filter:blur(9px);color:#c8d3e6;opacity:.72;transition:opacity .15s ease}' +
    '#pg-tab:hover{opacity:1}' +
    '#pg-tab span{writing-mode:vertical-rl;font-size:11px;letter-spacing:.08em;' +
    'font-family:ui-sans-serif,system-ui,"PingFang SC","Microsoft YaHei",sans-serif}' +
    '#pg-tab .pgTabTime{font-variant-numeric:tabular-nums;color:#8fe6b0}' +
    '#pg-tab .pgTabDot{writing-mode:horizontal-tb;width:7px;height:7px;border-radius:50%;background:#4ade80;' +
    'box-shadow:0 0 0 3px rgba(74,222,128,.15)}' +
    '#pg-tab .pgTabDot.off{background:#8d9ab4;box-shadow:0 0 0 3px rgba(141,154,180,.15)}' +
    '#pg-chip button.pgCollapse:hover{background:rgba(255,255,255,.14);color:#fff}'

  function injectCss() {
    if (document.getElementById('pg-style') !== null) return
    var tag = document.createElement('style')
    tag.id = 'pg-style'
    tag.textContent = css
    document.head.appendChild(tag)
  }

  function el(tag, props, children) {
    var node = document.createElement(tag)
    if (props) {
      for (var key in props) {
        if (key === 'text') node.textContent = props[key]
        else if (key === 'onClick') node.addEventListener('click', props[key])
        else if (key === 'onSubmit') node.addEventListener('submit', props[key])
        else if (key === 'onInput') node.addEventListener('input', props[key])
        else node.setAttribute(key, props[key])
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        // 【修掉的 bug】以前直接 appendChild(children[i])，而 renderLock()
        // 在「非首次登录」时会传一个 null 进来（那时没有「确认口令」输入框）→
        // appendChild(null) 抛 TypeError → 整个 renderLock 挂掉 → 遮罩永远不出现。
        // 症状极具欺骗性：键盘监听器已经挂上（按键被拦），宿主侧工具拦截也正常，
        // 但锁页看不见 —— 表现为「没有权限，但还能聊天」。
        if (children[i] !== null && children[i] !== undefined) node.appendChild(children[i])
      }
    }
    return node
  }

  function pad(n) {
    return n < 10 ? '0' + n : '' + n
  }

  function clock(ms) {
    var total = Math.max(0, Math.floor(ms / 1000))
    return pad(Math.floor(total / 60)) + ':' + pad(total % 60)
  }

  function remaining() {
    if (state.status !== 'unlocked') return 0
    var left = state.localDeadline - Date.now()
    return left > 0 ? left : 0
  }

  function removeNodes() {
    var root = document.getElementById(ROOT_ID)
    if (root !== null) root.remove()
    var chip = document.getElementById('pg-chip')
    if (chip !== null) chip.remove()
    var panel = document.getElementById('pg-panel')
    if (panel !== null) panel.remove()
    var tab = document.getElementById('pg-tab')
    if (tab !== null) tab.remove()
  }

  // ── 与服务端通信 ────────────────────────────────────────────────────

  function request(path, body) {
    var options = { credentials: 'same-origin', cache: 'no-store' }
    if (body !== undefined) {
      options.method = 'POST'
      options.headers = { 'content-type': 'application/json' }
      options.body = JSON.stringify(body)
    }
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () {
        return { ok: false, error: 'HTTP ' + response.status }
      })
    })
  }

  function poll() {
    return request('/gate/status').then(function (data) {
      applyStatus(data)
    }).catch(function () {
      // 主机不可达时保持现状，不擅自解锁
    })
  }

  function applyStatus(data) {
    if (!data || typeof data.state !== 'string') return
    var previous = state.status
    var wasUnlocked = previous === 'unlocked'
    state.status = data.state
    state.idleMs = typeof data.idleMs === 'number' ? data.idleMs : state.idleMs
    state.remainingMs = typeof data.remainingMs === 'number' ? data.remainingMs : 0
    state.localDeadline = Date.now() + state.remainingMs
    if (data.state === 'unlocked') {
      state.error = ''
    } else if (data.expires === true && wasUnlocked) {
      state.error = '空闲满 60 分钟，已按严格模式自动锁定。请重新登录。'
    }
    // 【修掉的 bug】以前这里无条件 render()，而轮询是每 5 秒一次 ——
    // render() → renderLock() 会重建整个登录表单，把用户【正在输入的口令清空】。
    // 手机上打字慢，5 秒必被清一次，表现为「口令动不动就被清空、要重新输入」。
    // 现在只在【状态真的变了】或【该有的节点不在】时才重绘。
    var expectedId =
      data.state === 'unlocked' || data.state === 'disabled'
        ? state.collapsed
          ? 'pg-tab'
          : 'pg-chip'
        : ROOT_ID
    if (data.state !== previous || document.getElementById(expectedId) === null) render()
  }

  function touch() {
    var now = Date.now()
    if (state.status !== 'unlocked') return
    if (now - state.lastTouch < TOUCH_MS) return
    state.lastTouch = now
    request('/gate/touch', {}).then(function (data) {
      if (data && data.ok === true) {
        state.remainingMs = data.remainingMs
        state.localDeadline = Date.now() + data.remainingMs
      } else {
        poll()
      }
    }).catch(function () {})
  }

  // ── 渲染 ────────────────────────────────────────────────────────────

  function render() {
    if (state.status === 'boot') return
    try {
      if (state.status === 'unlocked') {
        renderChip(true)
        return
      }
      if (state.status === 'disabled') {
        renderChip(false)
        return
      }
      renderLock()
    } catch (error) {
      // 【兜底】渲染绝不允许静默失败。
      // 当初那个 appendChild(null) 的 bug 之所以难查，就是因为渲染崩掉后
      // 屏幕上什么都不出现，而宿主侧拦截照常 —— 表现为「没有权限但还能聊天」。
      // 现在只要渲染出错，就把错误摆到屏幕上，并给出一定能用的入口。
      try {
        removeNodes()
        var box = el('div', { id: ROOT_ID })
        box.appendChild(
          el('div', { class: 'pg-card' }, [
            el('div', { class: 'pg-brand', text: '◈ DEEPSEEK HARNESS · 权限闸门' }),
            el('h1', { text: '闸门界面渲染出错' }),
            el('p', {
              text: '闸门仍在拦截工具调用，但界面脚本出错了，所以你看不到正常的登录页。',
            }),
            el('div', { class: 'pg-err', text: '错误：' + String(error && error.message ? error.message : error) }),
            el('p', {}, [
              el('a', {
                href: '/gate',
                style: 'color:#e8c37a;font-weight:600',
                text: '→ 点这里打开服务端登录页 /gate',
              }),
            ]),
          ]),
        )
        document.body.appendChild(box)
      } catch (inner) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[permission-gate] 兜底渲染同样失败：', inner, '原始错误：', error)
        }
      }
    }
  }

  function setCollapsed(value) {
    state.collapsed = value
    writeCollapsed(value)
    if (value) state.panelOpen = false
    render()
  }

  /** 收起态：贴在右侧边缘的窄把手（竖排），点它呼出胶囊。 */
  function renderTab(active) {
    injectCss()
    var timeNode = el('span', { class: 'pgTabTime', text: active ? clock(remaining()) : '已关闭' })
    var tab = el(
      'div',
      {
        id: 'pg-tab',
        title: '展开权限状态',
        onClick: function () {
          setCollapsed(false)
        },
      },
      [
        el('span', { class: 'pgTabDot' + (active ? '' : ' off') }),
        timeNode,
        el('span', { text: '权限' }),
      ],
    )
    if (active) {
      state.tick = function () {
        timeNode.textContent = clock(remaining())
      }
    }
    document.body.appendChild(tab)
  }

  function renderChip(active) {
    removeNodes()
    injectCss()
    if (state.collapsed) {
      renderTab(active)
      return
    }
    var dot = el('span', { class: 'pg-dot' + (active ? '' : ' off') })
    var chip = el('div', { id: 'pg-chip' }, [
      dot,
      el('span', { text: active ? '权限已开放' : '闸门已关闭' }),
    ])
    if (active) {
      var time = el('span', { class: 'pg-time', text: clock(remaining()) })
      chip.appendChild(time)
      state.tick = function () {
        time.textContent = clock(remaining())
      }
    }
    chip.appendChild(
      el('button', {
        text: active ? '锁定' : '启用',
        onClick: function () {
          if (!active) {
            state.panelOpen = true
            renderPanel()
            return
          }
          request('/gate/lock', {}).then(function () {
            return poll()
          })
        },
      }),
    )
    chip.appendChild(
      el('button', {
        text: '闸门设置',
        onClick: function () {
          state.panelOpen = !state.panelOpen
          renderPanel()
        },
      }),
    )
    chip.appendChild(
      el('button', {
        class: 'pgCollapse',
        text: '收起',
        title: '收起到右侧边缘，点竖条可再呼出',
        onClick: function () {
          setCollapsed(true)
        },
      }),
    )
    document.body.appendChild(chip)
    if (state.panelOpen) renderPanel()
  }

  function renderPanel() {
    var old = document.getElementById('pg-panel')
    if (old !== null) old.remove()
    if (!state.panelOpen) return
    injectCss()
    var active = state.status === 'unlocked'
    var input = el('input', { type: 'password', placeholder: '访问口令', autocomplete: 'off' })
    var message = el('div', { class: 'pg-msg', text: state.error })
    function submitMode(enable) {
      state.error = ''
      message.textContent = ''
      request('/gate/mode', { password: input.value, enable: enable }).then(function (data) {
        if (data && data.ok === true) {
          state.panelOpen = false
          state.error = ''
          return poll()
        }
        state.error = data && data.error ? data.error : '操作失败。'
        message.textContent = state.error
      })
    }
    var panel = el('div', { id: 'pg-panel' }, [
      el('h2', { text: '权限闸门设置' }),
      el('p', {
        text: active
          ? '关闭闸门需要输入访问口令。关闭后：界面锁消失、工具拦截停止，直到重新开启。'
          : '闸门当前已关闭。重新开启需要输入访问口令。',
      }),
      input,
      el('div', { class: 'pg-row' }, [
        el('button', {
          class: active ? 'pg-danger' : 'pg-ok',
          text: active ? '关闭闸门' : '开启闸门',
          onClick: function () {
            submitMode(!active)
          },
        }),
      ]),
      message,
      el('p', {
        text: '全局共享：任一端登录即全端解锁；空闲满 60 分钟，所有端一起回落。',
      }),
    ])
    document.body.appendChild(panel)
  }

  function renderLock() {
    // 【修掉的 bug】重绘前先把已输入的内容捞回来。
    // 配合 applyStatus 的「只在状态变化时重绘」，双保险：即使因为别的原因重绘
    // （比如输错口令后的那次），用户也不用从头再敲一遍。
    var keepPassword = ''
    var keepConfirm = ''
    var oldPassword = document.getElementById('pg-password')
    if (oldPassword !== null && typeof oldPassword.value === 'string') keepPassword = oldPassword.value
    var oldConfirm = document.getElementById('pg-confirm')
    if (oldConfirm !== null && typeof oldConfirm.value === 'string') keepConfirm = oldConfirm.value

    removeNodes()
    injectCss()
    var isSetup = state.status === 'setup'
    var password = el('input', {
      id: 'pg-password',
      type: 'password',
      value: keepPassword,
      placeholder: isSetup ? '设置口令（至少 4 位）' : '访问口令',
      autocomplete: 'off',
      autofocus: 'autofocus',
    })
    var confirm = isSetup
      ? el('input', {
          id: 'pg-confirm',
          type: 'password',
          value: keepConfirm,
          placeholder: '再输入一次口令',
          autocomplete: 'off',
        })
      : null
    var error = state.error
      ? el('div', { class: 'pg-err', text: state.error })
      : null
    var button = el('button', { type: 'submit', text: isSetup ? '设置口令并进入' : '登录解锁' })

    var form = el(
      'form',
      {
        onSubmit: function (event) {
          event.preventDefault()
          if (state.busy) return
          var value = password.value
          if (isSetup) {
            if (value.length < 4) {
              state.error = '口令至少需要 4 位。'
              renderLock()
              return
            }
            if (confirm !== null && value !== confirm.value) {
              state.error = '两次输入的口令不一致。'
              renderLock()
              return
            }
          }
          state.busy = true
          button.disabled = true
          button.textContent = '校验中…'
          request('/gate/login', { password: value, mode: isSetup ? 'setup' : 'login' }).then(function (data) {
            state.busy = false
            if (data && data.ok === true) {
              state.error = ''
              return poll()
            }
            state.error = data && data.error ? data.error : '登录失败。'
            renderLock()
          })
        },
      },
      [password, confirm, button],
    )

    var card = el('div', { class: 'pg-card' }, [
      el('div', { class: 'pg-brand', text: '◈ DEEPSEEK HARNESS · 权限闸门' }),
      el('h1', { text: isSetup ? '设置访问口令' : '需要登录才能继续' }),
      el('p', {
        text: isSetup
          ? '首次使用：为 DSH 设置访问口令。口令摘要保存在 ~/.dsh/permission-gate.json，重启后依然有效。'
          : '会话、文件、命令与工具调用当前全部封禁。严格模式：空闲满 60 分钟立即锁定，即使有任务正在运行也不宽限。',
      }),
    ])
    if (error !== null) card.appendChild(error)
    card.appendChild(form)
    card.appendChild(
      el('div', { class: 'pg-foot' }, [
        el('div', { text: '空闲上限 60:00 · 严格模式，到点即锁' }),
        el('div', { text: '全局共享：任一端登录即全端解锁，到期后所有端一起回落' }),
        el('div', { text: '与入口无关：工具拦截在整个进程内生效' }),
      ]),
    )
    document.body.appendChild(el('div', { id: ROOT_ID }, [card]))
    try {
      password.focus()
    } catch (e) {
      /* 忽略 */
    }
  }

  // ── 活动侦测 ────────────────────────────────────────────────────────

  function markActivity() {
    touch()
  }

  function onKey(event) {
    touch()
    // 只在遮罩真的渲染出来时才拦快捷键，而且只拦带修饰键的组合。
    //
    // 【修掉的 bug】原先这里对除 Tab/Shift/Ctrl/Alt/Meta 之外的**所有**按键
    // 调 preventDefault，结果在手机上把输入框的【空格】和【退格】一起吞了：
    // 移动端输入法的字母走 composition 事件，不受 keydown 影响，所以看起来
    // 「能打字」，而空格/退格是真实按键，被这里干掉。
    // 教训：遮罩不该靠「拦截一切按键」来实现 —— 那会穿透到真实输入框。
    if (document.getElementById(ROOT_ID) === null) return
    if (!event.ctrlKey && !event.metaKey && !event.altKey) return
    event.preventDefault()
    event.stopPropagation()
  }

  function start() {
    injectCss()
    document.addEventListener('pointerdown', markActivity, true)
    document.addEventListener('pointermove', markActivity, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('wheel', markActivity, { capture: true, passive: true })
    document.addEventListener('visibilitychange', function () {
      if (document.hidden === false) poll()
    })
    poll()
    setInterval(function () {
      if (state.status === 'unlocked') {
        var left = remaining()
        if (left <= 0) {
          state.status = 'locked'
          state.error = '空闲满 60 分钟，已按严格模式自动锁定。请重新登录。'
          render()
          poll()
          return
        }
        if (typeof state.tick === 'function') state.tick()
      }
    }, 1000)
    setInterval(poll, POLL_MS)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
