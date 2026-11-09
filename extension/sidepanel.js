// Side panel UI: read the current tab (or pasted text), send it to the
// FastAPI backend, and render the extracted action items.

const MAX = 30000;
const DEFAULT_BACKEND = "http://localhost:8000";
const REQUEST_TIMEOUT_MS = 60000;
const SOURCE_LABELS = { gmail: "Gmail", yahoo: "Yahoo Mail", outlook: "Outlook" };

const $ = (id) => document.getElementById(id);
const textEl = $("text"), countEl = $("count"), submitBtn = $("submit"), readBtn = $("readBtn");
const results = $("results"), sourceEl = $("source");

let backendUrl = DEFAULT_BACKEND;
let busy = false;

if (/Mac/.test(navigator.platform)) $("mod").textContent = "⌘";

// ---- theme -----------------------------------------------------------------------
// "light" (default) | "dark" | "auto" (follow the OS). Mirrored to localStorage so
// it applies synchronously on open, before chrome.storage answers (no dark flash).

function applyTheme(theme) {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const radio = document.querySelector(`input[name="theme"][value="${theme}"]`);
  if (radio) radio.checked = true;
  try { localStorage.setItem("theme", theme); } catch { /* ignore */ }
}
try { applyTheme(localStorage.getItem("theme") || "light"); } catch { applyTheme("light"); }

/** Tiny DOM helper: el("div", {class: "x"}, child, "text"). Text is always set via text nodes. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

// ---- persisted state ---------------------------------------------------------
// Settings (backend URL, tone) live in storage.sync. The current draft and last
// result live in storage.session so closing and reopening the panel keeps them,
// but they're cleared when the browser closes.

const store = {
  async get(area, keys) { try { return await chrome.storage[area].get(keys); } catch { return {}; } },
  async set(area, obj) { try { await chrome.storage[area].set(obj); } catch { /* ignore */ } },
};

const tone = () => document.querySelector('input[name="tone"]:checked').value;

let saveTimer;
function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set("session", { text: textEl.value }), 300);
}

// ---- backend -------------------------------------------------------------------

function normalizeUrl(raw) {
  const u = new URL(raw.trim());
  if (!/^https?:$/.test(u.protocol)) throw new Error("URL must start with http:// or https://");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

let offline = false;

async function checkHealth({ quiet = false } = {}) {
  const dot = $("statusDot"), text = $("statusText"), pill = $("status");
  if (!quiet) { dot.className = "dot"; text.textContent = "…"; }
  let ok = false;
  offline = false;
  try {
    const r = await fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
    const h = await r.json();
    if (h.status === "ok") {
      dot.className = "dot ok";
      text.textContent = h.model || h.provider;
      pill.title = `Connected to ${backendUrl} (${h.provider} · ${h.model})`;
      ok = true;
    } else {
      dot.className = "dot bad";
      text.textContent = "Not configured";
      pill.title = h.detail || "Backend is running but misconfigured.";
    }
  } catch {
    offline = true;
    dot.className = "dot bad";
    text.textContent = "Offline";
    pill.title = `Can't reach ${backendUrl}. Is the backend running?`;
  }
  $("offline").hidden = !offline;
  $("offlineUrl").textContent = `Looking for it at ${backendUrl} (change under ⚙).`;
  return ok;
}

// While offline, quietly re-check so the panel recovers once the server starts.
setInterval(() => { if (offline && !document.hidden) checkHealth({ quiet: true }); }, 4000);

/** Make sure we're allowed to call the backend origin (localhost:8000 is in the manifest). */
async function ensureBackendPermission(url) {
  const origins = [`${new URL(url).origin}/*`];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

// ---- settings panel ------------------------------------------------------------

$("settingsBtn").addEventListener("click", () => {
  const open = $("settings").hidden;
  $("settings").hidden = !open;
  $("settingsBtn").setAttribute("aria-expanded", String(open));
  if (open) $("backendUrl").focus();
});

$("settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const note = $("settingsNote");
  let url;
  try {
    url = normalizeUrl($("backendUrl").value);
  } catch (err) {
    note.className = "note bad";
    note.textContent = err.message.includes("http") ? err.message : "That doesn't look like a valid URL.";
    return;
  }
  if (!(await ensureBackendPermission(url))) {
    note.className = "note bad";
    note.textContent = "Permission to reach that address was declined.";
    return;
  }
  backendUrl = url;
  $("backendUrl").value = url;
  await store.set("sync", { backendUrl: url });
  const ok = await checkHealth();
  note.className = ok ? "note ok" : "note bad";
  note.textContent = ok ? "Saved. Backend is reachable." : "Saved, but the backend isn't responding at that address.";
});

// ---- reading the current tab ---------------------------------------------------

function showSource(kind, ...content) {
  sourceEl.className = `source${kind ? " " + kind : ""}`;
  sourceEl.replaceChildren(...content);
  sourceEl.hidden = false;
}

function describeSource(r) {
  const chars = `${r.text.length.toLocaleString()} chars`;
  if (r.source === "selection") return `Read your highlighted text · ${chars}`;
  if (SOURCE_LABELS[r.source]) {
    const msgs = `${r.messageCount} message${r.messageCount === 1 ? "" : "s"}`;
    return `Read from ${SOURCE_LABELS[r.source]} · ${msgs}${r.subject ? ` · “${r.subject}”` : ""}`;
  }
  return `Read page${r.subject ? ` “${r.subject}”` : ""} · ${chars}. Tip: highlight the email first for cleaner results.`;
}

async function readCurrentTab() {
  readBtn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error("No active tab found.");

    let injection;
    try {
      [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch (err) {
      return handleReadError(err);
    }

    const r = injection?.result;
    if (!r || !r.text) {
      showSource("warn", "Couldn't find any text on this page. Try highlighting the email, or paste it below.");
      return;
    }
    textEl.value = r.text;
    updateCount();
    saveDraft();

    const label = describeSource(r);
    if (r.truncated) showSource("warn", `${label} · Trimmed to the first ${MAX.toLocaleString()} characters.`);
    else showSource("", label);
    store.set("session", { source: { kind: r.truncated ? "warn" : "", label } });
  } finally {
    readBtn.disabled = false;
  }
}

function handleReadError(err) {
  const msg = String(err?.message || err);
  // chrome://, the Web Store, other extensions, and the new-tab page can never be scripted.
  if (/chrome:\/\/|chrome-extension:\/\/|extensions gallery|cannot be scripted|edge:\/\//i.test(msg)) {
    showSource("bad", "Chrome doesn't let extensions read this page. Open the email in a normal tab, or paste the text below.");
    return;
  }
  if (/file:\/\//i.test(msg)) {
    showSource("bad", "To read local files, enable “Allow access to file URLs” for this extension in chrome://extensions.");
    return;
  }
  // Most likely: no host permission for this site (and activeTab wasn't granted).
  const grant = el("button", { type: "button", class: "link", onclick: grantAllSites }, "Allow on all sites");
  showSource("bad",
    "No permission to read this tab. Click the extension's toolbar icon while on this tab, or ",
    grant, ".");
}

async function grantAllSites() {
  // Must be called from a user gesture (the button click).
  const granted = await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
  if (granted) readCurrentTab();
  else showSource("bad", "Permission declined. You can still paste the text below.");
}

// ---- rendering -----------------------------------------------------------------

function updateCount() {
  const n = textEl.value.length;
  countEl.textContent = `${n.toLocaleString()} / ${MAX.toLocaleString()}`;
  countEl.classList.toggle("over", n > MAX);
  submitBtn.disabled = busy || !textEl.value.trim() || n > MAX;
}

/** Clipboard API first; fall back to execCommand where it's blocked. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el("textarea", { readonly: true, style: "position:fixed;top:0;left:0;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

/** Split text into plain strings and highlighted [placeholder] spans. */
function withPlaceholders(text) {
  return text.split(/(\[[^\]\n]+\])/g).filter(Boolean)
    .map((part) => /^\[[^\]]+\]$/.test(part) ? el("mark", { class: "ph" }, part) : part);
}

function renderLoading() {
  results.replaceChildren(el("div", { class: "card loading" }, el("div", { class: "spinner" }), "Reading the message…"));
}

function renderError(title, detail) {
  results.replaceChildren(el("div", { class: "card error", role: "alert" }, el("strong", {}, title), detail));
}

function renderResult(r, ms) {
  const isYou = (o) => o.trim().toLowerCase() === "you";
  const noDeadline = (d) => /^no hard deadline$/i.test(d.trim());

  const summary = el("div", { class: "card section" },
    el("div", { class: "summary" },
      el("span", { class: `badge ${r.priority}` }, r.priority),
      el("div", {},
        el("p", {}, r.priority_reason),
        el("div", { class: "meta" },
          `${r.is_group_thread ? "Group thread" : "1-on-1 message"}${ms ? ` · ${(ms / 1000).toFixed(1)}s` : ""}`),
      ),
    ),
  );

  const todos = r.action_items.length
    ? el("ul", { class: "todo" }, r.action_items.map((item) => {
        const li = el("li", {});
        li.append(
          el("input", { type: "checkbox", "aria-label": `Mark done: ${item.task}`,
            onchange: (e) => li.classList.toggle("done", e.target.checked) }),
          el("div", {},
            el("p", { class: "task" }, item.task),
            el("div", { class: "tags" },
              el("span", { class: `tag${isYou(item.owner) ? " you" : ""}` }, `👤 ${item.owner}`),
              el("span", { class: `tag${noDeadline(item.deadline) ? "" : " due"}` }, `⏰ ${item.deadline}`),
            ),
          ),
        );
        return li;
      }))
    : el("p", { class: "none" }, "No action items found.");

  const questions = r.questions_to_answer.length
    ? el("ol", { class: "questions" }, r.questions_to_answer.map((q) => el("li", {}, q)))
    : el("p", { class: "none" }, "Nothing you need to answer.");

  const copyBtn = el("button", { type: "button", class: "btn ghost", style: "margin-left:auto" }, "Copy Reply");
  copyBtn.addEventListener("click", async () => {
    copyBtn.textContent = (await copyText(r.draft_reply)) ? "Copied ✓" : "Copy failed";
    setTimeout(() => (copyBtn.textContent = "Copy Reply"), 1600);
  });

  results.replaceChildren(
    summary,
    el("div", { class: "card section" },
      el("h2", {}, "Action items", el("span", { class: "n" }, r.action_items.length)), todos),
    el("div", { class: "card section" },
      el("h2", {}, "Questions to answer", el("span", { class: "n" }, r.questions_to_answer.length)), questions),
    el("div", { class: "card section" },
      el("h2", {}, "Draft reply", copyBtn),
      el("pre", { class: "reply" }, withPlaceholders(r.draft_reply)),
      /\[[^\]]+\]/.test(r.draft_reply) ? el("p", { class: "reply-note" }, "Fill in the highlighted [placeholders] before sending.") : null,
    ),
  );
}

// ---- extract ---------------------------------------------------------------------

async function extract() {
  const text = textEl.value.trim();
  if (busy || !text || textEl.value.length > MAX) return;

  busy = true;
  submitBtn.disabled = true;
  submitBtn.replaceChildren(el("span", { class: "spinner" }), "Extracting…");
  renderLoading();
  results.scrollIntoView({ behavior: "smooth", block: "start" });
  const t0 = performance.now();

  try {
    const r = await fetch(`${backendUrl}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, tone: tone() }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = Array.isArray(body.detail) ? body.detail.map((d) => d.msg).join("; ") : body.detail || `HTTP ${r.status}`;
      const title = { 422: "Invalid input", 502: "The AI model returned an error", 503: "Backend not configured" }[r.status] || "Request failed";
      renderError(title, detail);
    } else {
      renderResult(body, performance.now() - t0);
      store.set("session", { result: body });
    }
  } catch (err) {
    if (err?.name === "TimeoutError") renderError("Request timed out", "The AI took too long to respond. Try again, or shorten the text.");
    else renderError("Can't reach the backend", `Is the server running at ${backendUrl}? Start it with: uvicorn main:app --reload`);
    checkHealth();
  } finally {
    busy = false;
    submitBtn.replaceChildren("Extract Action Items");
    updateCount();
  }
}

// ---- wiring ------------------------------------------------------------------------

readBtn.addEventListener("click", readCurrentTab);
submitBtn.addEventListener("click", extract);
textEl.addEventListener("input", () => { updateCount(); saveDraft(); });
textEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); extract(); }
});
document.querySelectorAll('input[name="theme"]').forEach((r) =>
  r.addEventListener("change", () => { applyTheme(r.value); store.set("sync", { theme: r.value }); }));
document.querySelectorAll('input[name="tone"]').forEach((r) =>
  r.addEventListener("change", () => store.set("sync", { tone: tone() })));
$("clearBtn").addEventListener("click", () => {
  textEl.value = "";
  sourceEl.hidden = true;
  results.replaceChildren();
  updateCount();
  chrome.storage.session.remove(["text", "source", "result"]).catch(() => {});
  textEl.focus();
});

(async function init() {
  const sync = await store.get("sync", ["backendUrl", "tone", "theme"]);
  if (sync.theme) applyTheme(sync.theme);
  backendUrl = sync.backendUrl || DEFAULT_BACKEND;
  $("backendUrl").value = backendUrl;
  if (sync.tone) {
    const radio = document.querySelector(`input[name="tone"][value="${sync.tone}"]`);
    if (radio) radio.checked = true;
  }

  const session = await store.get("session", ["text", "source", "result"]);
  if (session.text) textEl.value = session.text;
  if (session.source) showSource(session.source.kind, session.source.label);
  if (session.result) renderResult(session.result);

  updateCount();
  checkHealth();
})();
