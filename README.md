# dsh-permission-gate

A **UI-level access gate** and **process-wide agent tool brake** for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

Log in once → every open DSH page unlocks. Nobody logged in → the agent itself
can't run a single tool.

---

## ⚠️ Read this first: this is NOT authentication

DSH's `/api` surface has **no authentication of its own** — that is a deliberate
property of the harness, not a bug this plugin fixes. The harness's own source
describes its request fence like this:

> `trustedHosts` is a DNS-rebinding fence, **explicitly not authentication**

**Any client that can reach the DSH port can bypass this plugin entirely** by
calling the HTTP API directly. This plugin gates:

- ✅ the **browser page** (a full-screen lock page injected into every page load)
- ✅ the **agent's tool calls** (a process-wide `tools.guard` brake)

It does **not** gate the HTTP surface. It is not a reverse proxy, not a
session layer, and not an authorization system.

**Always pair it with a real boundary:**

| Real boundary | What it gives you |
|---|---|
| Bind DSH to loopback (`dsh web`, the default) | Nothing on the network can reach it at all |
| A VPN / overlay (WireGuard, Tailscale, ZeroTier) | Only your own devices can route to the port |
| A TLS reverse proxy that performs **real** authentication | The only place a real auth layer can live |

If you deploy this on a public port and believe you are protected, you are
**worse off than having nothing**, because you will stop looking for the real
problem.

---

## What it does

- **Full-screen lock page.** Injected into every DSH page load via the
  documented `webserver/index-inject` channel — no client bundle, no module
  loader, nothing to keep in sync with the SPA.
- **Global shared session.** One session per process, one idle clock. Log in on
  your phone → your desktop page unlocks on its next poll. The clock expires →
  **every** page falls back to the login page.
- **Strict 60-minute idle lock.** No grace period, not even for a running task.
  This is intentional: the gate is a dead-man switch.
- **Process-wide tool brake.** While nobody is logged in, `ctx.tools.guard`
  denies every agent tool call. The agent cannot read files, run commands, open
  the network, or spawn subagents.
- **Real credentials.** scrypt + random salt, stored at
  `~/.dsh/permission-gate.json` (mode `0600`). The **session** lives in memory
  only, so a restart always requires a fresh login — but your password is never
  reset.
- **Server-rendered escape hatch.** `/gate` is plain HTML served by the host
  half. It works even if the injected script fails or is cached out.
- **Native settings module.** A `权限闸门` page inside DSH's own Settings,
  where the gate can be disabled — and disabling requires the password.
- **Collapsible status chip.** A countdown chip in the corner; collapse it to a
  slim tab on the right edge and click the tab to bring it back. The preference
  persists in `localStorage`.

## Install

```bash
# 1. install into your profile (out-of-tree plugin, resolved from its own node_modules)
dsh plugin --profile web add dsh-permission-gate

# 2. add a row to your profile's composition patch
#    ~/.dsh/profiles/web/cordis.patch.yml
```

```yaml
- insert:
    - id: permission-gate
      name: dsh-permission-gate
```

```bash
# 3. restart DSH — the client roster is scanned once at startup
```

On the next page load you get the lock page. The first visit asks you to
**set** a password; every visit after that asks you to **enter** it.

## Endpoints

All of them are served by the host half and sit behind the same origin as DSH.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/gate` | Server-rendered login page. Always available. |
| `GET` | `/gate/ui.js` | The injected browser script (`cache-control: no-store`). |
| `GET` | `/gate/status` | `{ state, expires, remainingMs, idleMs, hasCredential, authenticated }` |
| `POST` | `/gate/login` | `{ password, mode }` — `mode: "setup"` on first run. Sets the session cookie. |
| `POST` | `/gate/touch` | "A human is present" — extends the idle clock. |
| `POST` | `/gate/lock` | Drop the session and clear the cookie. |
| `POST` | `/gate/mode` | `{ password, enable }` — disable/enable the gate. **Requires the password.** |

`state` is one of `setup` · `locked` · `unlocked` · `disabled`.

## Threat model

| Scenario | Covered? |
|---|---|
| Someone picks up your unlocked phone/laptop and opens the browser | ✅ full-screen lock page |
| You walk away and an autonomous agent keeps working | ✅ strict idle lock + tool brake |
| A page is left open on a second device | ✅ shared session logic; all pages mirror the server state |
| Someone in your tailnet calls `/api` directly | ❌ **not covered** — that is what the real boundary is for |
| Someone can edit `cordis.patch.yml` or the package directory | ❌ **not covered** — a plugin cannot defend the composition that loads it |
| Someone restarts the DSH process | ❌ **not covered** — the gate lives in the process; a restart also clears the session |

### Deliberate exemption

Three tools stay callable while the gate is locked, because they touch **no
files, commands, session content, or credentials**:

```
get_goal · update_goal · todo_write
```

They exist so a locked agent can still report state and close out its own
bookkeeping. Remove the `BOOKKEEPING_TOOLS` line in `lib/index.js` if you want
a zero-exemption gate.

## Recovery

| Situation | What to do |
|---|---|
| Forgot the password | Delete `~/.dsh/permission-gate.json` → next visit asks you to set a new one |
| The injected UI is broken / cached | Visit `/gate` directly — it is server-rendered |
| Locked out completely | Set `disabled: true` on the row in `cordis.patch.yml`, or remove the row. `cordis.patch.yml` is watched live, so no restart is usually needed |
| Want to inspect state | `curl http://127.0.0.1:3080/gate/status` |

## Design notes

Built while running DSH remotely from a phone. Three bugs are baked into the
comments and the test suite, because each one is a trap anyone building
injected UI for DSH will hit:

1. **A silent render crash is worse than a visible error.** The lock page used
   to throw on every render in the common path (`appendChild(null)` when the
   "confirm password" field is absent) — the host-side guard kept working while
   the UI showed nothing, i.e. *"no permissions, but you can still chat."*
   Fix: never append `null`, and wrap the whole render in a fallback that puts
   the error on screen.
2. **Never re-render a form on a timer.** A 5-second status poll rebuilt the
   login form and wiped whatever the password field contained. Fix: re-render
   only when the state actually changes, and carry typed values across renders.
3. **A global session must not require a per-browser cookie.** `/gate/touch`
   originally demanded a cookie matching the session token. After a restart only
   the browser that logged in held a valid cookie, so every other page's activity
   was rejected with 401 — the countdown only ever went down. Fix: `touch`
   grants nothing; it only requires that the shared session is unlocked.

## Development

The smoke test runs the real `lib/ui.js` against a minimal DOM stub whose
`appendChild` throws on `null`, exactly like a real DOM. **No browser needed.**

```bash
npm test
```

## Compatibility

Developed against DSH `0.1.1-rc.2` / cordis `4.x`, and depends on these
harness capabilities:

- host: `webServer.register` · `webserver/index-inject` · `tools.guard`
- client: the `settings.section` slot · `slots` and `timer` services

These are internal-ish APIs; a DSH upgrade may require a matching update here.

## License

MIT
