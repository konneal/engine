"use strict";

const chat = document.getElementById("chat");
const form = document.getElementById("askform");
const input = document.getElementById("q");
const send = document.getElementById("send");
const langSel = document.getElementById("lang");
const quotaEl = document.getElementById("quota");

let busy = false;

function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

function addUser(text) {
  const m = el("div", "msg user", chat);
  const b = el("div", "bubble", m);
  b.textContent = text;
}

function addBot() {
  const m = el("div", "msg bot", chat);
  const b = el("div", "bubble", m);
  const cur = el("span", "cursor", b);
  cur.innerHTML = "&nbsp;";
  return { m, b };
}

function renderCites(container, cites) {
  if (!cites || !cites.length) return;
  const wrap = el("div", "cites", container);
  const h = el("h4", null, wrap);
  h.textContent = "Sources";
  for (const c of cites) {
    const d = el("div", "cite", wrap);
    const label = document.createElement("b");
    label.textContent = `${c.docidentifier || c.doc_id}${c.edition ? ":" + c.edition : ""}`;
    d.appendChild(label);
    const rest = document.createElement("span");
    const clause = c.clause_anchor ? ` §${c.clause_anchor}` : "";
    const title = c.clause_title ? ` — ${c.clause_title}` : "";
    const lang = c.language ? ` · ${c.language}` : "";
    rest.textContent = `${clause}${title}${lang}\n${(c.snippet || "").slice(0, 220)}${(c.snippet || "").length > 220 ? "…" : ""}`;
    d.appendChild(rest);
  }
}

function renderFeedback(container, queryHash) {
  const fb = el("div", "fb", container);
  const up = el("button", null, fb);
  up.textContent = "👍";
  const down = el("button", null, fb);
  down.textContent = "👎";
  const note = el("span", null, fb);
  let voted = 0;
  const vote = async (r) => {
    if (voted) return;
    voted = r;
    (r === 1 ? up : down).classList.add("on");
    note.textContent = "Thanks";
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query_hash: queryHash, rating: r }),
      });
    } catch { /* non-critical */ }
  };
  up.onclick = () => vote(1);
  down.onclick = () => vote(-1);
}

function fail(message) {
  const m = el("div", "msg bot err", chat);
  const b = el("div", "bubble", m);
  b.textContent = message;
}

async function ask(question) {
  addUser(question);
  const { b } = addBot();
  let answer = "";
  let cites = null;
  let queryHash = null;

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: question, lang: langSel.value || undefined, stream: true }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const msg = body?.error?.message || `Request failed (${res.status})`;
      fail(msg);
      if (body?.error?.code === "quota_exceeded" && body?.error?.message?.match(/\d+/)) {
        quotaEl.textContent = "Daily limit reached — answers resume tomorrow UTC.";
      }
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let done = false;

    while (!done) {
      const { done: rdDone, value } = await reader.read();
      if (rdDone) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (evt.type === "citations") {
          cites = evt.citations;
          if (evt.quota && typeof evt.quota.used === "number") {
            quotaEl.textContent = `${evt.quota.used} / ${evt.quota.limit} questions today`;
          }
        } else if (evt.type === "token") {
          answer += evt.v;
          b.textContent = answer;
          const cur = el("span", "cursor", b);
          cur.innerHTML = "&nbsp;";
        } else if (evt.type === "done") {
          queryHash = evt.query_hash;
          done = true;
        } else if (evt.type === "error") {
          fail(evt.message || "Stream error");
          done = true;
        }
      }
    }

    b.textContent = answer || "…";
    if (cites) renderCites(b, cites);
    if (queryHash) renderFeedback(b, queryHash);
  } catch (e) {
    fail("Network error — please retry.");
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q || busy) return;
  busy = true;
  send.disabled = true;
  input.value = "";
  input.focus();
  await ask(q);
  busy = false;
  send.disabled = false;
  chat.scrollTop = chat.scrollHeight;
});

const ro = new ResizeObserver(() => { chat.scrollTop = chat.scrollHeight; });
ro.observe(chat);
