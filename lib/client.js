/**
 * dsh-md-picker v1.3.0 — browser side (self-contained injector)
 *
 * Delivered as a plain <script> by the host shell (lib/index.js):
 * webServer route "/dsh-md-picker/client.js" + tapIndex script-tag injection.
 * The host replaces the __DMP_TOKEN__ placeholder with the per-process token
 * on every serve, so the browser never needs to know it in advance.
 * Dependency-free IIFE on purpose (frozen boot manifest: unknown ids are never
 * materialized by the client module system).
 *
 * Routing by type:
 *   - images (png/jpeg/webp/gif) -> synthetic drop -> OFFICIAL attachment
 *     pipeline (thumbnails, limit checks, upload with message)
 *   - .txt .md .markdown         -> RAW bytes POSTed to /dsh-md-picker/store
 *     (XHR, token + optional session headers); host detects encoding
 *     (BOM/UTF-8/GB18030...) and stores UTF-8 under the resolved base dir;
 *     short receipt only.
 *   - convertible (doc/docx/docm/rtf/odt/ods/odp/ppt/pptx/xls/xlsx/csv/epub/pdf)
 *     -> RAW bytes POSTed to /dsh-md-picker/convert with XHR upload progress;
 *     host runs the anydoc CLI and stores converted Markdown; receipt only.
 *
 * Receipts keep document bodies out of the conversation context; the agent
 * reads the stored files with normal file tools on demand. Files can be
 * dropped anywhere on the composer card — non-image files are routed here,
 * image-only drops keep flowing through the official pipeline.
 */
;(function () {
	"use strict";

	var STORE_ROUTE = "/dsh-md-picker/store";
	var CONVERT_ROUTE = "/dsh-md-picker/convert";
	// Placeholder replaced server-side per process; while still a placeholder
	// (e.g. a stale cached copy) the token header is omitted and uploads fall
	// back to inline once the host rejects them.
	var TOKEN = "__DMP_TOKEN__";
	var INLINE_PER_FILE_CHAR_CAP = 30000;
	var INLINE_TOTAL_CHAR_CAP = 60000;
	var PREVIEW_CHARS = 120;
	var TEXT_RE = /\.(txt|md|markdown)$/i;
	var CONVERTIBLE_RE = /\.(doc|docx|docm|rtf|odt|ods|odp|ppt|pps|pot|pptx|pptm|ppsx|ppsm|xls|xlsx|xlsm|xlsb|csv|epub|pdf)$/i;
	var IMAGE_RE = /^image\//;
	var currentBtn = null;

	/** Best-effort text decode: BOM -> strict UTF-8 -> GB18030 -> latin1. */
	function decodeBytes(bytes) {
		try {
			if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
				return new TextDecoder("utf-8").decode(bytes.subarray(3));
			}
			if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
				return new TextDecoder("utf-16le").decode(bytes.subarray(2));
			}
			if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
				return new TextDecoder("utf-16be").decode(bytes.subarray(2));
			}
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (err) {
			try { return new TextDecoder("gb18030").decode(bytes); }
			catch (err2) { return new TextDecoder("latin1").decode(bytes); }
		}
	}

	/** Read a text-ish file as raw bytes. Returns Promise<{name,text,bytes,origLen}> */
	function readTextFile(file) {
		return file.arrayBuffer().then(function (ab) {
			var bytes = new Uint8Array(ab);
			return { name: file.name, bytes: bytes, text: decodeBytes(bytes), origLen: bytes.length };
		});
	}

	/**
	 * Best-effort session id detection from the address bar (e.g.
	 * ?session=..., ?sid=..., /s/<id>, /session/<id>). The host uses it to
	 * resolve the exact workspace owning that session; when absent it falls
	 * back to its most-recent-workspace heuristic.
	 */
	function detectSessionId() {
		try {
			var href = window.location.href;
			var m = href.match(/[?&](?:session|sessionId|sid)=([^&#]+)/);
			if (m) return decodeURIComponent(m[1]);
			m = window.location.pathname.match(/\/(?:s|session)\/([^/?#]+)/);
			if (m) return decodeURIComponent(m[1]);
		} catch (e) {}
		return undefined;
	}

	function headersFor(name) {
		var h = { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(name) };
		if (TOKEN && TOKEN.indexOf("__DMP_TOKEN__") === -1) h["X-Dsh-Md-Picker-Token"] = TOKEN;
		var sid = detectSessionId();
		if (sid) h["X-Session-Id"] = sid;
		return h;
	}

	/** XHR upload with optional progress callback; resolves to the JSON receipt. */
	function xhrPost(route, bytes, name, onProgress) {
		return new Promise(function (resolve, reject) {
			var xhr = new XMLHttpRequest();
			xhr.open("POST", route, true);
			var h = headersFor(name);
			for (var k in h) xhr.setRequestHeader(k, h[k]);
			xhr.onload = function () {
				var j = null;
				try { j = JSON.parse(xhr.responseText); } catch (e) {}
				if (xhr.status < 200 || xhr.status >= 300) {
					reject(new Error((j && j.error) || ("HTTP " + xhr.status)));
					return;
				}
				if (j && j.ok === true) resolve(j);
				else reject(new Error((j && j.error) || "upload failed"));
			};
			xhr.onerror = function () { reject(new Error("network error")); };
			if (onProgress && xhr.upload) {
				xhr.upload.onprogress = function (ev) {
					if (ev.lengthComputable) onProgress(Math.round(ev.loaded / ev.total * 100));
				};
			}
			xhr.send(bytes);
		});
	}

	/** Stage raw text bytes server-side (server detects encoding); resolves to a receipt item. */
	function stagePart(part) {
		return xhrPost(STORE_ROUTE, part.bytes, part.name)
			.then(function (j) {
				var dup = j.duplicate ? "（已存在,未重复存储）" : "";
				return "[附件已暂存" + dup + " · " + j.path + "]\n"
					+ part.name + " · " + j.chars + " 字符 · agent 可按上述路径按需读取\n"
					+ "预览: " + (j.preview || "") + (j.chars > PREVIEW_CHARS ? "…" : "");
			});
	}

	/** Convert a binary document to Markdown server-side (anydoc); receipt. */
	function convertPart(part, onProgress) {
		return xhrPost(CONVERT_ROUTE, part.bytes, part.name, onProgress)
			.then(function (j) {
				var dup = j.duplicate ? "（已存在,未重复存储）" : "";
				return "[附件已转为 Markdown" + dup + " · " + j.path + "]\n"
					+ "原文件 " + part.name + " · " + j.chars + " 字符 · agent 可按上述路径按需读取\n"
					+ "预览: " + (j.preview || "") + (j.chars > PREVIEW_CHARS ? "…" : "");
			});
	}

	/**
	 * Inline fallback for one text file when the store route is unavailable.
	 * Applies the per-file cap plus a running total budget (INLINE_TOTAL_CHAR_CAP);
	 * returns { block, used } where used is chars consumed from the budget.
	 */
	function inlineBlockBudgeted(part, budget) {
		var head = "[附件 · " + part.name + " · " + part.origLen + " 字节 · 暂存服务不可用,内容内联";
		var bodyLen = Math.min(part.text.length, INLINE_PER_FILE_CHAR_CAP);
		if (bodyLen < part.text.length) head += " · 单文件截断至 " + INLINE_PER_FILE_CHAR_CAP;
		var overhead = head.length + "<<<ATTACHMENT-BEGIN>>>\n".length + "\n<<<ATTACHMENT-END>>>".length;
		var usable = Math.max(0, budget - overhead);
		if (bodyLen > usable) {
			bodyLen = usable;
			head = "[附件 · " + part.name + " · " + part.origLen + " 字节 · 暂存服务不可用且内联总量超限,已截断]";
		}
		var block = head + "\n<<<ATTACHMENT-BEGIN>>>\n" + part.text.slice(0, bodyLen) + "\n<<<ATTACHMENT-END>>>";
		return { block: block, used: block.length };
	}

	/** Inline fallback for one text file, unbounded total budget (kept for direct use). */
	function inlineBlock(part) {
		return inlineBlockBudgeted(part, Infinity).block;
	}

	/** Insert text at the end of the composer draft (React-safe value setter). */
	function insertIntoDraft(text) {
		var card = document.querySelector("[data-composer-card]");
		var ta = card ? card.querySelector("textarea") : document.querySelector("textarea");
		if (!ta) return false;
		var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
		var cur = ta.value;
		setter.call(ta, cur ? cur.replace(/\s*$/, "") + "\n\n" + text : text);
		ta.dispatchEvent(new Event("input", { bubbles: true }));
		ta.focus();
		return true;
	}

	// ---- pure-core export for node-side tests -------------------------------
	var Core = { readTextFile: readTextFile, inlineBlock: inlineBlock, inlineBlockBudgeted: inlineBlockBudgeted, decodeBytes: decodeBytes, detectSessionId: null };
	if (typeof globalThis !== "undefined") globalThis.__DMP_CORE__ = Core;
	if (typeof window === "undefined") return;

	// ---- UI bootstrap -------------------------------------------------------
	if (window.__DSH_MD_PICKER__) return;
	window.__DSH_MD_PICKER__ = true;

	var CSS = ".dmp-btn{display:inline-grid;place-items:center;width:28px;height:28px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:8px;transition:background .15s ease,color .15s ease}"
		+ ".dmp-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}"
		+ ".dmp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}"
		+ ".dmp-btn svg{display:block}"
		+ ".dmp-btn.dmp-flash{outline:2px solid var(--dsw-alias-brand-primary)}"
		+ "@keyframes dmp-spin{to{transform:rotate(360deg)}}"
		+ ".dmp-btn.dmp-busy svg{animation:dmp-spin .8s linear infinite}"
		+ "@media (prefers-reduced-motion:reduce){.dmp-btn.dmp-busy svg{animation:none}}"
		+ ".dmp-btn.dmp-success{color:#22c55e}"
		+ ".dmp-btn.dmp-error{color:#ef4444;outline:2px solid #ef4444}"
		+ ".dmp-btn.dmp-dragover{outline:2px dashed var(--dsw-alias-brand-primary)}"
		+ "[data-composer-card].dmp-composer-dragover{outline:2px dashed var(--dsw-alias-brand-primary);outline-offset:-2px;border-radius:12px}";
	// 图标:文档(带折角) + Markdown 的"M↓"字形 —— 表达"文档自动转为 Markdown"
	var ICON_DOC = "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z";
	var ICON_FOLD = "M15 2v5h5";
	var ICON_MD = "M7.5 17.5v-6l2.75 3.5 2.75-3.5v6";
	var ICON_ARROW = "M16.6 11.5v6m-2.1-2.1 2.1 2.1 2.1-2.1";
	var TITLE = "\u9009\u62E9\u6587\u4EF6\uFF08\u56FE\u7247\u76F4\u4F20\uFF1B\u6587\u6863\u81EA\u52A8\u8F6C\u4E3A Markdown\uFF0C\u4EC5\u56DE\u6267\u63D2\u5165\uFF09\uFF1B\u4E5F\u53EF\u76F4\u63A5\u62D6\u5165\u8F93\u5165\u6846";
	var TIP_BUSY = "正在转换文档为 Markdown…";
	var TIP_SUCCESS = "转换完成，回执已插入草稿";
	var TIP_ERROR = "转换失败，详见回执与控制台";

	function svgWrap(content) {
		return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' + content + '</svg>';
	}

	/** idle=文档+M↓ busy=旋转弧线 success=绿勾 error=红叉 */
	function renderIcon(state) {
		if (state === "busy") return svgWrap('<path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>');
		if (state === "success") return svgWrap('<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>');
		if (state === "error") return svgWrap('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>');
		return svgWrap(
			'<path d="' + ICON_DOC + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
			+ '<path d="' + ICON_FOLD + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
			+ '<path d="' + ICON_MD + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
			+ '<path d="' + ICON_ARROW + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
		);
	}

	/** 按钮状态机:busy 常驻直至解除;success/error 显示后自动回弹 idle */
	var pending = 0, stateTimer = null;
	function setState(btn, state, revertMs) {
		if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
		btn.classList.remove("dmp-busy", "dmp-success", "dmp-error", "dmp-flash");
		if (state !== "idle") btn.classList.add("dmp-" + state);
		btn.setAttribute("aria-busy", state === "busy" ? "true" : "false");
		btn.title = state === "busy" ? TIP_BUSY : state === "success" ? TIP_SUCCESS : state === "error" ? TIP_ERROR : TITLE;
		btn.innerHTML = renderIcon(state);
		if (state === "success") announce(TIP_SUCCESS);
		else if (state === "error") announce(TIP_ERROR);
		if (revertMs) stateTimer = setTimeout(function () { setState(btn, "idle"); }, revertMs);
	}

	function ensureStyle() {
		if (document.querySelector('style[data-plugin-css="dsh-md-picker"]')) return;
		var tag = document.createElement("style");
		tag.dataset.plugin = "dsh-md-picker";
		tag.dataset.pluginCss = "dsh-md-picker";
		tag.textContent = CSS;
		document.head.appendChild(tag);
	}

	function ensureLive() {
		if (document.querySelector('[data-plugin-live="dsh-md-picker"]')) return;
		var el = document.createElement("div");
		el.dataset.plugin = "dsh-md-picker";
		el.dataset.pluginLive = "dsh-md-picker";
		el.setAttribute("aria-live", "polite");
		el.setAttribute("role", "status");
		el.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap";
		document.body.appendChild(el);
	}

	/** Announce a result to screen readers through the aria-live region. */
	function announce(msg) {
		var el = document.querySelector('[data-plugin-live="dsh-md-picker"]');
		if (!el) return;
		el.textContent = "";
		setTimeout(function () { el.textContent = msg; }, 50);
	}

	function feedImages(files) {
		var dt = new DataTransfer();
		for (var k = 0; k < files.length; k++) dt.items.add(files[k]);
		var card = document.querySelector("[data-composer-card]");
		var target = card || document.body;
		var types = ["dragenter", "dragover", "drop"];
		for (var i = 0; i < types.length; i++) {
			target.dispatchEvent(new DragEvent(types[i], { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
		}
		window.dispatchEvent(new DragEvent("dragend"));
	}

	function hasNonImageFiles(dt) {
		try {
			var files = dt && dt.files ? Array.prototype.slice.call(dt.files) : [];
			return files.some(function (f) { return !IMAGE_RE.test(f.type); });
		} catch (e) { return false; }
	}

	/** 输入框卡片级拖放:含非图片文件时接管,纯图片继续走官方管线。 */
	function bindComposerDrop(card) {
		if (card.__dmpDropBound) return;
		card.__dmpDropBound = true;
		card.addEventListener("dragover", function (e) {
			if (!hasNonImageFiles(e.dataTransfer)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			card.classList.add("dmp-composer-dragover");
		});
		card.addEventListener("dragleave", function () { card.classList.remove("dmp-composer-dragover"); });
		card.addEventListener("drop", function (e) {
			card.classList.remove("dmp-composer-dragover");
			if (!hasNonImageFiles(e.dataTransfer)) return;
			e.preventDefault();
			e.stopPropagation();
			var all = Array.prototype.slice.call(e.dataTransfer.files || []);
			var imgs = all.filter(function (f) { return IMAGE_RE.test(f.type); });
			var others = all.filter(function (f) { return !IMAGE_RE.test(f.type); });
			if (others.length > 0 && currentBtn) handlePicked(others, currentBtn);
			if (imgs.length > 0) feedImages(imgs);
		});
	}

	function handlePicked(files, btn) {
		var imgs = [], textJobs = [], docJobs = [], skipped = [];
		for (var k = 0; k < files.length; k++) {
			(function (f) {
				if (IMAGE_RE.test(f.type)) { imgs.push(f); return; }
				if (TEXT_RE.test(f.name)) { textJobs.push(readTextFile(f)); return; }
				if (CONVERTIBLE_RE.test(f.name)) {
					docJobs.push(f.arrayBuffer().then(function (ab) {
						return { name: f.name, bytes: new Uint8Array(ab) };
					}));
					return;
				}
				skipped.push(f.name);
			})(files[k]);
		}
		if (imgs.length > 0) feedImages(imgs);

		var jobs = [];
		var convertFailed = false;
		for (var t = 0; t < textJobs.length; t++) {
			(function (p) {
				jobs.push(p.then(function (part) {
					return stagePart(part)["catch"](function (e) {
						console.warn("[dsh-md-picker] store failed, inlining:", e.message);
						return { kind: "inline", part: part };
					});
				}));
			})(textJobs[t]);
		}
		for (var c = 0; c < docJobs.length; c++) {
			(function (p) {
				pending++;
				if (pending === 1) setState(btn, "busy");
				jobs.push(p.then(function (part) {
					return convertPart(part, function (pct) {
						btn.title = "正在上传 " + part.name + " · " + pct + "%";
					})["catch"](function (e) {
						convertFailed = true;
						console.warn("[dsh-md-picker] convert failed:", e.message);
						return { block: "[dsh-md-picker] 转换失败(" + part.name + "): " + e.message + " —— 请重新选择该文件重试" };
					});
				}).then(function (item) {
					pending--;
					if (pending === 0) setState(btn, convertFailed ? "error" : "success", 1500);
					return item;
				}));
			})(docJobs[c]);
		}

		Promise.all(jobs).then(function (items) {
			var blocks = [], inlineUsed = 0;
			for (var i = 0; i < items.length; i++) {
				var it = items[i];
				if (!it) continue;
				if (it.kind === "inline") {
					if (inlineUsed >= INLINE_TOTAL_CHAR_CAP) {
						blocks.push("[附件 · " + it.part.name + " · 暂存服务不可用且内联总量超限,正文未内联]");
						continue;
					}
					var r = inlineBlockBudgeted(it.part, INLINE_TOTAL_CHAR_CAP - inlineUsed);
					inlineUsed += r.used;
					blocks.push(r.block);
				} else {
					blocks.push(it.block);
				}
			}
			if (skipped.length > 0) blocks.push("[dsh-md-picker] 未处理: " + skipped.join(", "));
			if (!insertIntoDraft(blocks.join("\n\n"))) console.warn("[dsh-md-picker] composer textarea not found");
		})["catch"](function (e) { console.error("[dsh-md-picker]", e); setState(btn, "error", 1500); });
	}

	function buildButton() {
		var btn = document.createElement("button");
		btn.type = "button";
		btn.className = "dmp-btn";
		btn.title = TITLE;
		btn.setAttribute("aria-label", TITLE);
		btn.addEventListener("mousedown", function (e) { e.preventDefault(); });
		btn.innerHTML = renderIcon("idle");
		currentBtn = btn;
		var input = document.createElement("input");
		input.type = "file";
		input.accept = "image/png,image/jpeg,image/webp,image/gif,.txt,.md,.markdown,.doc,.docx,.docm,.rtf,.odt,.ods,.odp,.ppt,.pps,.pot,.pptx,.pptm,.ppsx,.ppsm,.xls,.xlsx,.xlsm,.xlsb,.csv,.epub,.pdf";
		input.multiple = true;
		input.style.display = "none";
		input.addEventListener("change", function () {
			var picked = Array.prototype.slice.call(input.files || []);
			input.value = "";
			if (picked.length > 0) handlePicked(picked, btn);
		});
		btn.addEventListener("click", function () { input.click(); });
		btn.addEventListener("dragover", function (e) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			btn.classList.add("dmp-dragover");
		});
		btn.addEventListener("dragleave", function () { btn.classList.remove("dmp-dragover"); });
		btn.addEventListener("drop", function (e) {
			e.preventDefault();
			e.stopPropagation();
			btn.classList.remove("dmp-dragover");
			var picked = Array.prototype.slice.call(e.dataTransfer.files || []);
			if (picked.length > 0) handlePicked(picked, btn);
		});
		var wrap = document.createDocumentFragment();
		wrap.appendChild(btn);
		wrap.appendChild(input);
		return wrap;
	}

	function findHost() {
		var card = document.querySelector("[data-composer-card]");
		if (!card || card.querySelector(".dmp-btn")) return null;
		var addBtn = card.querySelector("button[class*='_add']");
		if (addBtn && addBtn.parentElement) return { card: card, parent: addBtn.parentElement, ref: addBtn.nextSibling };
		var tools = card.querySelector("[class*='_tools']");
		if (tools) return { card: card, parent: tools, ref: tools.firstChild };
		return null;
	}

	function tick() {
		var spot = findHost();
		if (!spot) return;
		ensureStyle();
		ensureLive();
		bindComposerDrop(spot.card);
		spot.parent.insertBefore(buildButton(), spot.ref);
	}

	function start() {
		tick();
		new MutationObserver(function () { tick(); }).observe(document.body, { childList: true, subtree: true });
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
	else start();
})();
