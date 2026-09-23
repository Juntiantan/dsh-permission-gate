# dsh-permission-gate

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的
**界面级访问闸门** + **全进程 agent 工具制动**。

登录一次 → 所有打开的 DSH 页面解锁。没人登录 → **连 agent 自己都跑不动一个工具**。

---

## ⚠️ 先读这一段：这不是身份认证

DSH 的 `/api` 表面**本身没有认证** —— 这是 harness 的设计事实，不是本插件能修的东西。
harness 自己的源码是这么描述它那道请求围栏的：

> `trustedHosts` is a DNS-rebinding fence, **explicitly not authentication**

**任何能连上 DSH 端口的客户端，都可以直接调用 HTTP API 完全绕过本插件。** 本插件只拦两件事：

- ✅ **浏览器页面**（每次页面加载注入的全屏锁页）
- ✅ **agent 的工具调用**（`tools.guard` 全进程制动）

它**不**拦 HTTP 表面。它既不是反向代理，也不是会话层，更不是授权系统。

**务必配合一道真实边界使用：**

| 真实边界 | 它能给你什么 |
|---|---|
| 把 DSH 绑在回环（`dsh web` 的默认行为） | 网络上根本没有任何东西能碰到它 |
| VPN / overlay（WireGuard、Tailscale、ZeroTier） | 只有你自己的设备能路由到这个端口 |
| 带**真实认证**的 TLS 反向代理 | 真正的认证层只能落在这里 |

**如果你把它丢在公网端口上，然后以为安全了 —— 那比什么都不装更糟**，因为你不会再去找真正的问题。

---

## 它做什么

- **全屏锁页。** 通过官方文档化的 `webserver/index-inject` 通道注入到每次页面加载 ——
  不需要客户端插件包、不需要模块加载器、不需要跟 SPA 保持同步。
- **全局共享会话。** 整个进程只有一个会话、一个空闲时钟。手机登录 → 电脑页面在下一次轮询时自动解锁；
  时钟到期 → **所有**页面一起回落登录页。
- **严格 60 分钟空闲锁。** 没有宽限期，**任务运行中也不例外**。这是刻意的：闸门就是一道亡灵开关。
- **全进程工具制动。** 无人登录期间，`ctx.tools.guard` 拒绝 agent 的每一个工具调用 ——
  读不了文件、跑不了命令、上不了网、起不了子代理。
- **真实凭据。** scrypt + 随机盐，存于 `~/.dsh/permission-gate.json`（权限 `0600`）。
  **会话只在内存**，所以重启后必须重新登录 —— 但口令**不会**被重置。
- **服务端退路。** `/gate` 是宿主半边直出的纯 HTML 页面，即使注入脚本坏掉或被缓存住也一定能用。
- **原生设置模块。** DSH 设置里多出一个「权限闸门」页，可以关闭闸门 —— 而**关闭需要输入口令**。
- **可收起的悬浮胶囊。** 角上的倒计时胶囊可以收起到右侧边缘变成一条窄把手，点一下就展开；
  偏好记在 `localStorage` 里。

## 安装

本包声明了 `dsh.bundle`，所以它是一个 **profile layer**：**装就是一行命令**，
组合由 DSH 自动对账，**没有需要你手改的补丁文件**。

```bash
dsh plugin --profile web add dsh-permission-gate

# 重启 DSH 一次 —— 客户端名单只在启动时扫描
```

bundle 会自己插入这一行（见 [`cordis.patch.yml`](./cordis.patch.yml)）：

```yaml
- insert:
    - id: permission-gate
      name: dsh-permission-gate
```

> **从手动安装迁移过来的？** 请先把你**自己**的
> `~/.dsh/profiles/web/cordis.patch.yml` 里同样那一行删掉 ——
> 现在由 bundle 插入，同一个 `id` 出现两次会冲突。

下一次页面加载就会出现锁页。首次访问让你**设置**口令，之后每次让你**输入**口令。

## HTTP 接口

全部由宿主半边提供，与 DSH 同源。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/gate` | 服务端渲染的登录页，永远可用 |
| `GET` | `/gate/ui.js` | 注入浏览器的脚本（`cache-control: no-store`） |
| `GET` | `/gate/status` | `{ state, expires, remainingMs, idleMs, hasCredential, authenticated }` |
| `POST` | `/gate/login` | `{ password, mode }` —— 首次用 `mode: "setup"`，成功后下发会话 cookie |
| `POST` | `/gate/touch` | 「有人在」—— 续期空闲时钟 |
| `POST` | `/gate/lock` | 丢弃会话并清除 cookie |
| `POST` | `/gate/mode` | `{ password, enable }` —— 关闭/开启闸门，**必须输入口令** |

`state` 取值：`setup` · `locked` · `unlocked` · `disabled`。

## 威胁模型

| 场景 | 挡得住吗 |
|---|---|
| 有人拿起你没锁屏的手机/电脑，打开浏览器 | ✅ 全屏锁页 |
| 你走开了，自治 agent 还在继续干活 | ✅ 严格空闲锁 + 工具制动 |
| 另一台设备上开着的页面 | ✅ 共享会话逻辑，所有页面镜像服务端状态 |
| 你 tailnet 里的人直接调 `/api` | ❌ **挡不住** —— 这正是真实边界的职责 |
| 有人能改 `cordis.patch.yml` 或插件目录 | ❌ **挡不住** —— 插件无法对抗加载它的 composition |
| 有人重启 DSH 进程 | ❌ **挡不住** —— 闸门活在进程里，重启同时清空会话 |

### 刻意保留的豁免

锁定时仍有三个工具可调用，因为它们**碰不到任何文件、命令、会话内容或凭据**：

```
get_goal · update_goal · todo_write
```

它们的存在是为了让被锁住的 agent 仍能汇报状态、收尾自己的记账。
想要零豁免闸门，删掉 `lib/index.js` 里 `BOOKKEEPING_TOOLS` 那一行即可。

## 出事怎么办

| 情况 | 做法 |
|---|---|
| 忘了口令 | 删掉 `~/.dsh/permission-gate.json` → 下次访问会让你设一个新的 |
| 注入的界面坏了 / 被缓存 | 直接访问 `/gate`，它是服务端渲染的 |
| 彻底被锁在外面 | 把 `cordis.patch.yml` 里那一行改成 `disabled: true`，或删掉整块。该文件是热加载的，通常不用重启 |
| 想看当前状态 | `curl http://127.0.0.1:3080/gate/status` |

## 设计笔记

这个插件是在「用手机远程操控 DSH」的实战里长出来的。三个 bug 被我写进了注释和测试，
因为任何人给 DSH 写注入式界面都会踩到它们：

1. **静默的渲染崩溃比看得见的报错危险得多。** 锁页曾经在**最常见的路径上**每次渲染都抛异常
   （没有「确认口令」输入框时 `appendChild(null)`）—— 宿主侧拦截照常工作，而界面上什么都没有，
   表现为「**没有权限，但还能聊天**」。修法：永不 append `null`，并把整个渲染包进会显示错误的兜底。
2. **绝不要用定时器重绘表单。** 一次 5 秒的状态轮询会重建登录表单、**清空你正在输入的口令**。
   修法：只在状态真的变化时重绘，并且把已输入内容跨重绘带过去。
3. **全局会话不能要求按浏览器的 cookie。** `/gate/touch` 原本要求 cookie 与会话 token 匹配。
   重启后只有登录过的那个浏览器持有有效 cookie，其它页面全部 401 —— 倒计时只减不增。
   修法：`touch` 不授予任何权限，它只要求共享会话处于解锁状态。

## 开发

冒烟测试会把真实的 `lib/ui.js` 跑在一个最小 DOM 桩上 —— 那个桩的 `appendChild`
遇到 `null` 会像真实 DOM 一样抛错。**不需要浏览器。**

```bash
npm test
```

## 兼容性

针对 DSH `0.1.1-rc.2` / cordis `4.x` 开发，依赖这些 harness 能力：

- 宿主：`webServer.register` · `webserver/index-inject` · `tools.guard`
- 客户端：`settings.section` 槽位 · `slots` 与 `timer` 服务

它们属于偏内部的 API，DSH 升级后可能需要同步更新本插件。

## 许可

MIT
