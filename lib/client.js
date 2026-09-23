/**
 * DSH 权限闸门 —— 客户端半边（DSH 原生设置页里的模块）
 *
 * 形态与仓库里其他客户端包一致：
 *   · 由 window.__ModuleLoader__ 装载（无 JSX、无 import，React 经 require 取得）
 *   · 导出 apply / inject；inject 是【服务名】数组（cordis fiber inject）
 *   · 通过 ctx.slots.inject + ctx.slots.register 注册到 settings.section
 *
 * 为什么不用 Remote RPC：宿主半边已经把 /gate/* 做成了同源 HTTP 接口，
 * 这里直接 fetch 即可 —— 少一层协议，少一处出错的地方。
 *
 * 关闭闸门必须输入口令：POST /gate/mode { password, enable }
 * 口令错误由宿主返回 401，这里原样显示。
 */
window.__ModuleLoader__.load({
	id: "dsh-permission-gate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");

		// 用 DSH 主题 token，跟设置页其他部分保持一致外观
		var CSS = [
			".pgSettings{max-width:640px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary)}",
			".pgSettings h3{margin:0;font-size:14px;font-weight:600;line-height:22px}",
			".pgSettings .pgRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			".pgSettings .pgBadge{font-size:12px;line-height:20px;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2)}",
			".pgSettings .pgBadge[data-state=unlocked]{color:var(--dsw-alias-state-success-primary,#3fa96a);border-color:currentColor}",
			".pgSettings .pgBadge[data-state=locked]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}",
			".pgSettings .pgBadge[data-state=disabled]{color:var(--dsw-alias-label-tertiary)}",
			".pgSettings .pgTime{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}",
			".pgSettings p{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
			".pgSettings .pgCard{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}",
			".pgSettings input{height:36px;box-sizing:border-box;padding:0 12px;border-radius:8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);outline:none;flex:1 1 200px;min-width:0}",
			".pgSettings input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}",
			".pgSettings button{height:36px;padding:0 16px;border-radius:8px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}",
			".pgSettings button[disabled]{opacity:.5;cursor:default}",
			".pgSettings button.pgDanger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
			".pgSettings .pgMsg{font-size:12px;line-height:18px;min-height:18px}",
			".pgSettings .pgMsg[data-kind=error]{color:var(--dsw-alias-state-error-primary)}",
			".pgSettings .pgMsg[data-kind=ok]{color:var(--dsw-alias-state-success-primary,#3fa96a)}",
			".pgSettings .pgMeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
		].join("\n");

		var CSS_TAG_ID = "dsh-permission-gate/settings.css";

		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') !== null) return;
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-permission-gate";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** 需要的客户端服务：槽位注册表 + 定时器。 */
		const inject = ["slots", "timer"];

		function fmtClock(ms) {
			var total = Math.max(0, Math.floor(ms / 1000));
			var mm = Math.floor(total / 60);
			var ss = total % 60;
			return (mm < 10 ? "0" + mm : "" + mm) + ":" + (ss < 10 ? "0" + ss : "" + ss);
		}

		function describe(state) {
			if (state === "unlocked") return "已解锁";
			if (state === "locked") return "已锁定";
			if (state === "disabled") return "闸门已关闭";
			if (state === "setup") return "等待设置口令";
			return "未知";
		}

		/**
		 * Client plugin body: register one settings page.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			injectCss();

			function GateSettings() {
				var infoPair = react.useState({ phase: "loading", state: "", remainingMs: 0, hasCredential: true });
				var info = infoPair[0];
				var setInfo = infoPair[1];

				var pwPair = react.useState("");
				var password = pwPair[0];
				var setPassword = pwPair[1];

				var msgPair = react.useState({ kind: "", text: "" });
				var message = msgPair[0];
				var setMessage = msgPair[1];

				var busyPair = react.useState(false);
				var busy = busyPair[0];
				var setBusy = busyPair[1];

				function refresh() {
					fetch("/gate/status", { credentials: "same-origin", cache: "no-store" })
						.then(function (response) {
							return response.json();
						})
						.then(function (data) {
							setInfo({
								phase: "ready",
								state: typeof data.state === "string" ? data.state : "",
								remainingMs: typeof data.remainingMs === "number" ? data.remainingMs : 0,
								hasCredential: data.hasCredential === true,
							});
						})
						.catch(function (error) {
							setInfo({ phase: "error", state: "", remainingMs: 0, hasCredential: true, error: String(error && error.message ? error.message : error) });
						});
				}

				react.useEffect(function () {
					refresh();
					var stop = ctx.interval(refresh, 5000);
					return function () {
						stop();
					};
				}, []);

				function submit(enable) {
					if (busy) return;
					setBusy(true);
					setMessage({ kind: "", text: "" });
					fetch("/gate/mode", {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ password: password, enable: enable }),
					})
						.then(function (response) {
							return response.json();
						})
						.then(function (data) {
							setBusy(false);
							if (data && data.ok === true) {
								setPassword("");
								setMessage({ kind: "ok", text: enable ? "闸门已开启，工具拦截已恢复。" : "闸门已关闭，工具拦截已停止。" });
								refresh();
								return;
							}
							setMessage({ kind: "error", text: data && data.error ? data.error : "操作失败。" });
						})
						.catch(function (error) {
							setBusy(false);
							setMessage({ kind: "error", text: String(error && error.message ? error.message : error) });
						});
				}

				var state = info.state;
				var active = state === "unlocked" || state === "locked" || state === "setup";
				var statusText = info.phase === "loading" ? "读取中…" : info.phase === "error" ? "读取失败" : describe(state);

				return react.createElement(
					"div",
					{ className: "pgSettings" },
					react.createElement("h3", null, "权限闸门"),
					react.createElement(
						"div",
						{ className: "pgRow" },
						react.createElement("span", { className: "pgBadge", "data-state": state || "unknown" }, statusText),
						state === "unlocked"
							? react.createElement("span", { className: "pgTime" }, "剩余 " + fmtClock(info.remainingMs))
							: null,
					),
					react.createElement(
						"p",
						null,
						"关机自启、界面上不可启停；全局共享一个 60 分钟空闲时钟，任一端登录即全端解锁，到期后所有端一起回落。",
					),
					react.createElement(
						"div",
						{ className: "pgCard" },
						react.createElement(
							"p",
							null,
							active
								? "关闭闸门需要输入访问口令。关闭后界面锁消失、工具拦截停止，直到重新开启。"
								: "闸门当前已关闭。重新开启需要输入访问口令。",
						),
						react.createElement(
							"div",
							{ className: "pgRow" },
							react.createElement("input", {
								type: "password",
								value: password,
								placeholder: "访问口令",
								autoComplete: "off",
								disabled: busy,
								onChange: function (event) {
									setPassword(event.target.value);
								},
								onKeyDown: function (event) {
									if (event.key === "Enter") submit(!active);
								},
							}),
							react.createElement(
								"button",
								{
									type: "button",
									className: active ? "pgDanger" : "",
									disabled: busy || password === "",
									onClick: function () {
										submit(!active);
									},
								},
								busy ? "处理中…" : active ? "关闭闸门" : "开启闸门",
							),
						),
						react.createElement(
							"div",
							{ className: "pgMsg", "data-kind": message.kind },
							message.text,
						),
					),
					react.createElement(
						"div",
						{ className: "pgMeta" },
						"凭据保存在 ~/.dsh/permission-gate.json；会话只在内存，重启后需重新登录（口令不会被重置）。",
					),
					react.createElement(
						"div",
						{ className: "pgMeta" },
						"退路：服务端登录页永远可用 —— 直接访问 /gate。",
					),
				);
			}

			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register(
					{
						name: "settings.section",
						id: "permission-gate",
						order: 30,
						label: function () {
							return "权限闸门";
						},
					},
					GateSettings,
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
