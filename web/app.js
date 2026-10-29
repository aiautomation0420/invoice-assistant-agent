// Invoice Assistant web UI. No framework: the server streams each turn as lines of JSON, this file draws them.
const $ = (id) => document.getElementById(id);
const log = $("log");
const input = $("input");
const sendBtn = $("send");
const showSteps = $("show-steps");

const ICONS = {
  bot: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  tool: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
};

// What each tool is doing, in words, while it runs.
const TOOL_LABELS = {
  search_invoices: "Searching invoices",
  get_invoice: "Opening the invoice",
  vendor_summary: "Summarizing vendors",
  weekly_report: "Building the weekly report",
  list_errors: "Checking workflow errors",
  list_statement_files: "Finding statement files",
  reconcile_vendor_statement: "Reconciling the vendor statement",
  reconcile_bank_statement: "Reconciling the bank statement",
  draft_vendor_email: "Drafting the email",
  update_invoice_status: "Approve or reject (asks you first)",
};
const STATUSES = ["clean", "flagged", "approved", "rejected"];

// ── Safe markdown: everything is escaped first, then a small set of formatting is added back ──────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/\breports\/([\w.-]+\.csv)\b/g, '<a href="/api/reports/$1" download>reports/$1</a>');
}

function cell(text, header) {
  const value = text.trim();
  const status = STATUSES.find((s) => value.replace(/\*/g, "").toLowerCase() === s);
  const html = status ? `<span class="badge s-${status}"><span class="t">${esc(status[0].toUpperCase() + status.slice(1))}</span></span>` : inline(value);
  const numeric = /^[-+−]?\$?[\d,]+(\.\d+)?%?$|^—$/.test(value.replace(/\*/g, ""));
  const tag = header ? "th" : "td";
  return `<${tag}${numeric && !header ? ' class="num"' : ""}>${html}</${tag}>`;
}

const splitRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|");

function markdown(src) {
  const lines = String(src).replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      const head = splitRow(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(splitRow(lines[i]));
      const body = rows.map((r) => `<tr>${r.map((c) => cell(c, false)).join("")}</tr>`).join("");
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => cell(c, true)).join("")}</tr></thead><tbody>${body}</tbody></table></div>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) { out.push(`<h${heading[1].length < 3 ? 3 : 4}>${inline(heading[2])}</h${heading[1].length < 3 ? 3 : 4}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*> ?/, ""));
      out.push(`<blockquote>${markdown(quote.join("\n"))}</blockquote>`);
      continue;
    }
    const list = line.match(/^\s*([-*•]|\d+[.)])\s+/);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const items = [];
      for (; i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ""))}</li>`);
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^\s*(\||#{1,4}\s|>|```|[-*•]\s|\d+[.)]\s)/.test(lines[i]); i++) para.push(inline(lines[i]));
    if (!para.length) { para.push(inline(lines[i])); i++; }
    out.push(`<p>${para.join("<br>")}</p>`);
  }
  return out.join("");
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────
function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}
const nf = new Intl.NumberFormat("en-US");
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
function scrollDown() { log.scrollTop = log.scrollHeight; }
const pretty = (v) => esc(JSON.stringify(v, null, 2));

function store(key, value) { try { localStorage.setItem(key, value); } catch {} }
function load(key) { try { return localStorage.getItem(key); } catch { return null; } }

// ── Sidebar: suggestions and app info ───────────────────────────────────────────────────────────
function suggestionGroups(month) {
  return [
    ["Invoices", ["Which invoices are flagged and waiting for review?", "What's overdue?", "Show me what was approved or rejected this week and why."]],
    ["Vendors & reports", ["How much did we spend with Summit Logistics this month?", "Which vendors send the most problem invoices?", "What were the top problem reasons last week?"]],
    ["Reconciliation", [`Reconcile Summit Logistics' ${month} statement.`, `Reconcile the ${month} bank statement.`, "Draft an email to Summit asking for the missing invoices."]],
    ["System", ["Have there been any workflow errors recently?"]],
  ];
}

const STARTERS = (month) => [
  ["Review", "Which invoices are flagged and waiting for review?"],
  ["Reconcile", `Reconcile Summit Logistics' ${month} statement.`],
  ["Spend", "How much did we spend with Summit Logistics this month?"],
  ["Bank", `Reconcile the ${month} bank statement.`],
];

async function loadInfo() {
  let info = {};
  try { info = await (await fetch("/api/info")).json(); } catch {}
  const month = info.statementMonth
    ? new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(`${info.statementMonth}-01T00:00:00Z`))
    : new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date());

  const nav = $("suggestions");
  nav.innerHTML = "";
  for (const [title, questions] of suggestionGroups(month)) {
    const group = el("div", "suggestion-group", `<h3>${esc(title)}</h3>`);
    for (const q of questions) {
      const b = el("button", "suggestion", esc(q));
      b.type = "button";
      b.addEventListener("click", () => { closeMenu(); ask(q); });
      group.append(b);
    }
    nav.append(group);
  }
  const starters = $("starters");
  starters.innerHTML = "";
  for (const [kind, q] of STARTERS(month)) {
    const b = el("button", "starter", `<span class="starter-kind">${esc(kind)}</span><span class="starter-text">${esc(q)}</span>`);
    b.type = "button";
    b.addEventListener("click", () => ask(q));
    starters.append(b);
  }
  const mode = info.provider === "anthropic-api" ? "Anthropic API" : info.provider === "claude-code" ? "Claude subscription (local)" : "—";
  $("meta").innerHTML = `<dt>AI</dt><dd>${esc(mode)}</dd><dt>Model</dt><dd>${esc(info.model ?? "—")}</dd><dt>Data</dt><dd>${esc(info.scope === "demo" ? "Demo rows (read-only key)" : info.scope ?? "—")}</dd><dt>Tools</dt><dd>${info.tools?.length ?? "—"}</dd>`;
}

// ── Dialogs: the program asks you, not Claude ───────────────────────────────────────────────────
function confirmDialog(question) {
  return new Promise((resolve) => {
    const dialog = $("confirm-dialog");
    $("confirm-text").textContent = question;
    const verb = question.split(" ")[0];
    const yes = $("confirm-yes");
    yes.textContent = `Yes, ${verb.toLowerCase()}`;
    yes.className = `btn ${/^reject/i.test(verb) ? "btn-danger" : "btn-primary"}`;
    dialog.returnValue = "no";
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes" ? "yes" : "no"), { once: true });
    dialog.showModal();
    dialog.querySelector('button[value="no"]').focus();
  });
}

function askDialog(question) {
  return new Promise((resolve) => {
    const dialog = $("ask-dialog");
    const field = $("ask-input");
    const help = $("ask-help");
    const required = /required/i.test(question);
    $("ask-label").textContent = question.replace(/:\s*$/, "");
    field.value = "";
    field.required = required;
    help.className = "field-help";
    help.textContent = required ? "Required for rejections and invoices over the $5,000 approval limit. Saved with the decision." : "Optional. Saved with the decision.";
    $("ask-cancel").textContent = required ? "Cancel" : "Skip";
    dialog.returnValue = "cancel";
    const onSubmit = (e) => {
      if (e.submitter?.value === "ok" && required && !field.value.trim()) {
        e.preventDefault();
        help.className = "field-help error";
        help.textContent = "Please write a short reason, or cancel to leave the invoice flagged.";
        field.focus();
      }
    };
    $("ask-form").addEventListener("submit", onSubmit);
    dialog.addEventListener("close", () => {
      $("ask-form").removeEventListener("submit", onSubmit);
      resolve(dialog.returnValue === "ok" ? field.value.trim() : "");
    }, { once: true });
    dialog.showModal();
    field.focus();
  });
}

// ── One turn ────────────────────────────────────────────────────────────────────────────────────
let busy = false;

function setBusy(value) {
  busy = value;
  sendBtn.disabled = value || !input.value.trim();
  log.setAttribute("aria-busy", String(value));
  document.querySelectorAll(".suggestion, .starter, #new-chat").forEach((b) => (b.disabled = value));
}

function addUser(text) {
  $("empty")?.remove();
  const msg = el("div", "msg user");
  msg.append(el("div", "bubble"));
  msg.firstChild.textContent = text;
  log.append(msg);
}

function addTurn() {
  const msg = el("div", "msg assistant");
  msg.append(el("div", "avatar", ICONS.bot));
  const turn = el("div", "turn");
  const steps = el("div", "steps");
  steps.dataset.open = String(showSteps.checked);
  steps.hidden = true;
  const head = el("button", "steps-head", `<span class="spinner" aria-hidden="true"></span><span class="steps-title">Working…</span>${ICONS.chev}`);
  head.type = "button";
  head.setAttribute("aria-expanded", steps.dataset.open);
  head.addEventListener("click", () => {
    steps.dataset.open = String(steps.dataset.open !== "true");
    head.setAttribute("aria-expanded", steps.dataset.open);
  });
  const list = el("ol", "steps-list");
  steps.append(head, list);
  const typing = el("div", "typing", "<span></span><span></span><span></span>");
  typing.setAttribute("aria-label", "Thinking");
  turn.append(steps, typing);
  msg.append(turn);
  log.append(msg);
  scrollDown();
  return { turn, steps, head, list, typing, count: 0, pendingStep: null };
}

function onToolCall(t, name, inputArgs) {
  t.steps.hidden = false;
  t.count++;
  const step = el("li", "step");
  step.dataset.state = "running";
  step.innerHTML = `<div class="step-row"><span class="step-state"><span class="spinner" aria-hidden="true"></span></span><span class="tool-name">${esc(name)}</span><span class="step-label">${esc(TOOL_LABELS[name] ?? "Running a tool")}</span></div>
    <details><summary>Input and result</summary><span class="code-label">Input</span><pre class="code">${pretty(inputArgs)}</pre><span class="code-label">Result</span><pre class="code result">…</pre></details>`;
  t.list.append(step);
  t.head.querySelector(".steps-title").textContent = `${TOOL_LABELS[name] ?? "Working"}…`;
  t.pendingStep = step;
  scrollDown();
}

function onToolResult(t, name, ok, result) {
  const step = t.pendingStep ?? t.list.lastElementChild;
  if (step) {
    step.dataset.state = ok ? "ok" : "error";
    step.querySelector(".step-state").innerHTML = ok ? ICONS.check : ICONS.x;
    step.querySelector(".result").innerHTML = pretty(result);
  }
  t.pendingStep = null;
  // Extra cards for results a person acts on.
  if (name === "draft_vendor_email" && result?.drafted) t.extras = [...(t.extras ?? []), emailCard(result)];
  if (typeof result?.report === "string" && result.report.startsWith("Saved to ")) t.extras = [...(t.extras ?? []), reportCard(result.report.slice(9))];
  if (name === "update_invoice_status" && result) t.extras = [...(t.extras ?? []), decisionCard(result)];
}

function emailCard(r) {
  const card = el("div", "card");
  card.innerHTML = `<div class="card-head">${ICONS.mail}<strong>Email draft</strong><span class="pill">Not sent</span><span class="spacer"></span>
      <button class="btn btn-sm" type="button">${ICONS.copy}<span>Copy email</span></button></div>
    <dl class="email-meta"><dt>To</dt><dd>${esc(r.to)}</dd><dt>Subject</dt><dd>${esc(r.subject)}</dd></dl>
    <pre class="email-body">${esc(r.body)}</pre>`;
  const btn = card.querySelector("button");
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`Subject: ${r.subject}\n\n${r.body}`);
      btn.querySelector("span").textContent = "Copied";
    } catch {
      btn.querySelector("span").textContent = "Copy failed: select the text instead";
    }
    setTimeout(() => (btn.querySelector("span").textContent = "Copy email"), 2000);
  });
  return card;
}

function reportCard(path) {
  const name = path.replace(/^reports\//, "");
  return el("div", "card report-card", `${ICONS.file}<div><strong>Reconciliation report saved</strong><div class="file">${esc(path)}</div></div>
    <a class="btn btn-sm" href="/api/reports/${encodeURIComponent(name)}" download>${ICONS.download}Download CSV</a>`);
}

function decisionCard(r) {
  return el("div", "card decision-card", `${r.done ? ICONS.shield : ICONS.alert}<div><strong>${r.done ? "Decision saved" : "Nothing was changed"}</strong><div>${esc(r.message)}</div>${r.review_note ? `<div class="usage">Note: ${esc(r.review_note)} · by ${esc(r.reviewed_by)}</div>` : ""}</div>`);
}

function finishTurn(t, answer) {
  t.typing.remove();
  t.head.querySelector(".spinner")?.remove();
  if (t.count) {
    const u = answer?.usage;
    const cost = answer?.costUsd != null ? ` · est. $${answer.costUsd.toFixed(4)}` : "";
    t.head.querySelector(".steps-title").innerHTML = `${ICONS.tool}<span>${t.count} tool ${t.count === 1 ? "call" : "calls"}</span>${u ? `<span class="usage"> · ${compact(u.input + u.cacheRead + u.cacheWrite)} in · ${compact(u.output)} out${cost}</span>` : ""}`;
  }
}

async function ask(text) {
  text = text.trim();
  if (!text || busy) return;
  input.value = "";
  autosize();
  setBusy(true);
  addUser(text);
  const t = addTurn();
  let answered = false;
  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text }) });
    if (!res.ok || !res.body) throw new Error((await res.text()) || `The server answered ${res.status}.`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === "tool_call") onToolCall(t, ev.name, ev.input);
        else if (ev.type === "tool_result") onToolResult(t, ev.name, ev.ok, ev.result);
        else if (ev.type === "confirm") reply(ev.id, await confirmDialog(ev.question));
        else if (ev.type === "ask") reply(ev.id, await askDialog(ev.question));
        else if (ev.type === "answer") {
          answered = true;
          finishTurn(t, ev);
          t.turn.append(el("div", "answer", markdown(ev.text)));
          for (const card of t.extras ?? []) t.turn.append(card);
        } else if (ev.type === "error") {
          answered = true;
          finishTurn(t);
          t.turn.append(el("div", "card error-card", `${ICONS.alert}<div>${esc(ev.message)}</div>`));
        }
        scrollDown();
      }
    }
    if (!answered) throw new Error("The answer was cut off. Please try again.");
  } catch (err) {
    finishTurn(t);
    t.turn.append(el("div", "card error-card", `${ICONS.alert}<div>${esc(err.message === "Failed to fetch" ? "Can't reach the app. Is npm run app still running?" : err.message)}</div>`));
  } finally {
    if (!t.steps.hidden && !t.count) t.steps.hidden = true;
    if (!t.count) t.steps.remove();
    setBusy(false);
    scrollDown();
    input.focus();
  }
}

function reply(id, value) {
  fetch("/api/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, value }) }).catch(() => {});
}

// ── Composer, menu, settings ────────────────────────────────────────────────────────────────────
function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  sendBtn.disabled = busy || !input.value.trim();
}
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    ask(input.value);
  }
});
$("composer").addEventListener("submit", (e) => { e.preventDefault(); ask(input.value); });

$("new-chat").addEventListener("click", async () => {
  if (busy) return;
  const res = await fetch("/api/reset", { method: "POST" }).catch(() => null);
  if (!res?.ok) return;
  log.innerHTML = "";
  const empty = el("div", "empty");
  empty.id = "empty";
  empty.innerHTML = `<div class="empty-mark" aria-hidden="true">${ICONS.bot}</div><h2>What do you need from AP today?</h2><p>A new conversation. Earlier questions are forgotten.</p><div class="starter-grid" id="starters"></div>`;
  log.append(empty);
  closeMenu();
  loadInfo();
  input.focus();
});

const sidebar = $("sidebar");
const scrim = $("scrim");
function closeMenu() { sidebar.dataset.open = "false"; scrim.hidden = true; $("menu-btn").setAttribute("aria-expanded", "false"); }
$("menu-btn").addEventListener("click", () => {
  const open = sidebar.dataset.open !== "true";
  sidebar.dataset.open = String(open);
  scrim.hidden = !open;
  $("menu-btn").setAttribute("aria-expanded", String(open));
});
scrim.addEventListener("click", closeMenu);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sidebar.dataset.open === "true") closeMenu(); });

// "Show agent steps" = the --verbose of the web app. Remembered on this computer.
showSteps.checked = load("showSteps") !== "false";
showSteps.addEventListener("change", () => {
  store("showSteps", String(showSteps.checked));
  document.querySelectorAll(".steps").forEach((s) => {
    s.dataset.open = String(showSteps.checked);
    s.querySelector(".steps-head")?.setAttribute("aria-expanded", String(showSteps.checked));
  });
});

loadInfo();
autosize();
input.focus();
