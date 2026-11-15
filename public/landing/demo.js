/* Troy staff pages: where the data comes from.
   The dashboard and the "under the hood" panel ask for everything through TroyData.api().
   - With the Troy server answering (John's Mac), every call is a plain fetch to /api/..., exactly as before.
   - Without it (the public site is static files), the first call fails, and from then on the page runs on the
     example files in demo-data/, kept in memory. Buttons change that copy only. Nothing is sent anywhere.
   The example files are made by scripts/build-demo-data.ts. */
(() => {
  "use strict";

  /** The pickup code the demo accepts. It opens nothing real; the real code never leaves the server. */
  const SAMPLE_CODE = "TRJN26";
  const BANNER = "Example data. This is a demo of the staff view; nothing here is a real student or report.";
  const FILES = { panel: "panel", settings: "settings", dps: "dps", repairs: "reports-repair", usg: "reports-usg", moderation: "moderation", staff: "staff", directory: "directory", eval: "eval", demo: "demo" };

  let demo = false;
  let state = null;
  let clockOffset = 0;
  let nextId = 9000;

  async function live(path, method, body) {
    const res = await fetch(path, { method: method || "GET", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    let json = {};
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }

  /** Live when the server answers /api/settings with its JSON. Anything else (no server, a 404 page) means demo. */
  async function probe() {
    try {
      const res = await fetch("/api/settings", { headers: { accept: "application/json" } });
      if (!res.ok || !/json/i.test(res.headers.get("content-type") || "")) return false;
      const json = await res.json();
      return !!(json && json.ok === true);
    } catch {
      return false;
    }
  }

  async function loadDemo() {
    const entries = await Promise.all(Object.entries(FILES).map(async ([key, name]) => {
      const res = await fetch("demo-data/" + name + ".json");
      if (!res.ok) throw new Error("demo data missing: " + name);
      return [key, await res.json()];
    }));
    state = Object.fromEntries(entries);
    // The example data has its own clock: it starts at the moment the files were made and runs from there.
    clockOffset = Date.now() - (state.panel.generatedAt || Date.now());
    demo = true;
    showBanner();
  }

  const ready = (async () => {
    if (await probe()) return "live";
    await loadDemo();
    return "demo";
  })();

  function showBanner() {
    const add = () => {
      if (document.getElementById("demo-banner")) return;
      const bar = document.createElement("div");
      bar.id = "demo-banner";
      bar.className = "demo-banner";
      bar.setAttribute("role", "note");
      const dot = document.createElement("i");
      dot.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = BANNER;
      bar.append(dot, text);
      document.body.prepend(bar);
      document.documentElement.classList.add("is-demo");
    };
    if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
  }

  // ---------- the demo's own copy of the API ----------

  const now = () => Date.now() - clockOffset;
  const copy = (v) => JSON.parse(JSON.stringify(v));
  const ok = (json, note) => ({ status: 200, json: Object.assign({ ok: true }, json, note ? { demoNote: note } : null) });
  const bad = (status, error) => ({ status, json: { ok: false, error } });
  const NOT_SENT = " Nothing was sent.";

  /** Same rule as the server: an email, or a phone number that can be written as +1XXXXXXXXXX. */
  function normalizeHandle(raw) {
    if (typeof raw !== "string") return null;
    const s = raw.trim().toLowerCase();
    if (!s) return null;
    if (s.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
    const digits = s.replace(/\D/g, "");
    if (s.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? "+" + digits : null;
    if (digits.length === 10) return "+1" + digits;
    if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
    return null;
  }
  function maskHandle(handle) {
    if (handle.includes("@")) { const [local, domain] = handle.split("@"); return local.slice(0, 1) + "•••@" + domain; }
    return "•••• " + handle.slice(-4);
  }

  function allReports() {
    const out = [];
    for (const set of [state.repairs, state.usg]) for (const g of set.groups) for (const r of g.reports) out.push(r);
    return out;
  }
  const sampleHandoff = () => state.demo.samplePickup.handoff;

  function settingsView() {
    return copy(state.settings);
  }
  function staffView() {
    return { roles: copy(state.staff.roles), contacts: copy(state.staff.contacts) };
  }
  function addToAllowList(masked) {
    const list = state.settings.allowList.entries;
    if (list.some((e) => e.handle === masked && e.reason === "manual")) return false;
    list.unshift({ id: nextId++, handle: masked, isGroup: false, reason: "manual", removable: true, addedAt: now() });
    return true;
  }
  /** Reports show who their office or committee is assigned to, so an assignment change shows up on them too. */
  function syncAssignments() {
    const byRole = new Map(state.staff.contacts.map((c) => [c.role, c]));
    for (const r of allReports()) {
      if (!r.staff || !r.staff.role) continue;
      const c = byRole.get(r.staff.role);
      r.staff.assigned = c ? { id: c.id, label: c.label, handle: c.handle, isExample: true, reachable: c.reachable } : null;
      if (r.staff.exampleText) r.staff.exampleNote = c ? "example: nothing was texted for this one" : "example: no one is assigned yet";
    }
  }

  function handle(path, method, body) {
    const url = new URL(path, "http://demo.invalid");
    const p = url.pathname;
    const b = body || {};
    let m;

    if (method === "GET") {
      if (p === "/api/settings") return ok(settingsView());
      if (p === "/api/settings/allow-list") return ok(copy(state.settings.allowList));
      if (p === "/api/dps") return ok(Object.assign(copy(state.dps), { now: now() }));
      if (p === "/api/reports") {
        const kind = url.searchParams.get("kind");
        if (kind === "repair") return ok(copy(state.repairs));
        if (kind === "usg_concern") return ok(copy(state.usg));
        return bad(400, "bad_kind");
      }
      if (p === "/api/moderation") return ok(copy(state.moderation));
      if (p === "/api/staff") return ok(staffView());
      if (p === "/api/directory") return ok(copy(state.directory));
      if (p === "/api/eval") return ok(copy(state.eval));
      if (p === "/api/panel") {
        const out = Object.assign(copy(state.panel), { now: now(), enabled: state.settings.enabled });
        if (url.searchParams.get("staff") === "1") {
          // The staff view shows a pickup code. Here it is the demo's sample code, never a real one.
          for (const h of out.handoffs) if (h.hasPickupCode) out.staff.handoffs[h.id] = { pickupCode: h.id === sampleHandoff().id ? SAMPLE_CODE : null };
        } else delete out.staff;
        return ok(out);
      }
      return bad(404, "not_found");
    }

    // ----- settings -----
    if (p === "/api/settings/enabled" && method === "POST") {
      if (typeof b.enabled !== "boolean") return bad(400, "bad_request");
      state.settings.enabled = state.settings.settingOn = b.enabled;
      return ok(settingsView(), b.enabled
        ? "Demo: Troy is on again. He would go back to reading allowed chats and replying."
        : "Demo: Troy is off. He would stop reading, replying and sending right away." + NOT_SENT);
    }
    if (p === "/api/settings/allow-list" && method === "POST") {
      const h = normalizeHandle(b.handle);
      if (!h) return bad(400, "bad_handle");
      const masked = maskHandle(h);
      const added = addToAllowList(masked);
      return ok(Object.assign({ added, handle: masked }, copy(state.settings.allowList)), added
        ? "Demo: added " + masked + " to this page only. Troy sends no text for this, and nothing was saved."
        : "Already on the list");
    }
    if ((m = p.match(/^\/api\/settings\/allow-list\/(\d+)$/)) && method === "DELETE") {
      const list = state.settings.allowList.entries;
      const at = list.findIndex((e) => e.id === Number(m[1]) && e.removable);
      if (at >= 0) list.splice(at, 1);
      return ok(Object.assign({ removed: at >= 0 ? 1 : 0 }, copy(state.settings.allowList)), "Demo: removed from this page only. Troy sends no text for this.");
    }

    // ----- DPS -----
    if (p === "/api/dps/check-code" && method === "POST") {
      const code = typeof b.code === "string" ? b.code.replace(/[\s-]/g, "").toUpperCase() : "";
      if (!code) return bad(400, "missing_code");
      if (code !== SAMPLE_CODE) return ok({ found: false });
      const h = sampleHandoff();
      return ok({ found: true, alreadyCompleted: h.completedAt !== null, handoff: copy(h) });
    }
    if (p === "/api/dps/complete" && method === "POST") {
      const h = sampleHandoff();
      if (Number(b.handoffId) !== h.id) return bad(404, "not_found");
      const already = h.completedAt !== null;
      if (!already) {
        const t = now();
        h.completedAt = t;
        if (h.item) h.item.status = "returned";
        for (const it of state.dps.items) if (it.handoffId === h.id) { it.pickedUpAt = t; it.status = "returned"; }
        const match = state.panel.matches.find((x) => x.id === h.matchId);
        for (const ph of state.panel.handoffs) if (ph.id === h.id) ph.completedAt = t;
        for (const l of state.panel.listings) if (match && (l.id === match.foundListingId || l.id === match.lostListingId)) l.status = "returned";
        state.panel.counts.returned += 1;
      }
      return ok({ alreadyCompleted: already, handoff: copy(h) }, "Demo: marked as picked up. Troy would text " + (h.ownerFirstName || "the owner") + ": \"want to send the finder a quick thank-you? text it here and i'll pass it on. or say skip\"." + NOT_SENT);
    }

    // ----- reports -----
    if ((m = p.match(/^\/api\/reports\/(\d+)\/status$/)) && method === "POST") {
      const r = allReports().find((x) => x.id === Number(m[1]));
      if (!r) return bad(404, "not_found");
      if (!r.statusOptions.includes(b.status)) return bad(400, "bad_status");
      if (r.status === b.status) return ok({ changed: false, status: b.status, notified: 0 });
      r.status = b.status;
      const line = state.demo.statusCopy[b.status];
      const info = state.demo.reports[r.id] || { reference: "update on the report", recipients: 1 };
      if (!line) return ok({ changed: true, status: b.status, notified: 0, failed: 0 }, "Demo: set back to received. Troy sends no text for that.");
      const n = info.recipients;
      return ok({ changed: true, status: b.status, notified: n, failed: 0 }, "Demo: Troy would text " + (n === 1 ? "1 student" : n + " students") + ": \"" + info.reference + ": " + line + "\"." + NOT_SENT);
    }

    // ----- moderation -----
    if (p === "/api/moderation/ban" && method === "POST") {
      const userId = Number(b.userId);
      if (!Number.isInteger(userId) || typeof b.banned !== "boolean") return bad(400, "bad_request");
      let name = null, hit = false;
      for (const d of state.moderation.drops) if (d.poster.id === userId) { d.poster.bannedFromPosting = b.banned; name = d.poster.firstName; hit = true; }
      if (!hit) return bad(404, "not_found");
      const who = name || "That student";
      return ok({ userId, banned: b.banned }, b.banned
        ? "Demo: " + who + " would not be able to post new drops. Troy sends no text for a ban."
        : "Demo: " + who + " would be able to post again. Troy sends no text for this.");
    }
    if ((m = p.match(/^\/api\/moderation\/topics\/(\d+)\/remove$/)) && method === "POST") {
      const at = state.moderation.topics.findIndex((t) => t.id === Number(m[1]));
      if (at < 0) return bad(404, "not_found");
      state.moderation.topics.splice(at, 1);
      return ok({ id: Number(m[1]), removed: true }, "Demo: topic removed. Its alerts would stop, and the people following it are not texted.");
    }
    if ((m = p.match(/^\/api\/moderation\/topic-requests\/(\d+)\/(approve|dismiss)$/)) && method === "POST") {
      const at = state.moderation.topicRequests.findIndex((q) => q.id === Number(m[1]));
      if (at < 0) return bad(404, "not_found");
      const [q] = state.moderation.topicRequests.splice(at, 1);
      if (m[2] === "dismiss") return ok({ changed: true, status: "declined" }, "Demo: dismissed. Troy sends no text for this.");
      const label = String(q.text).toLowerCase();
      const topic = { id: nextId++, key: label.replace(/[^a-z0-9]+/g, "_"), label, plain: "when someone posts about " + label, suggestedByFirstName: q.requesterFirstName, createdAt: now() };
      state.moderation.topics.push(topic);
      return ok({ changed: true, status: "created", topic: { id: topic.id, key: topic.key, label }, notified: true },
        "Demo: topic created. Troy would text " + (q.requesterFirstName || "the student") + ": \"good news, \"" + label + "\" is a topic now and ur on it. i'll text u " + topic.plain + "\"." + NOT_SENT);
    }

    // ----- people -----
    if (p === "/api/staff" && method === "POST") {
      const role = state.staff.roles.find((r) => r.role === b.role);
      if (!role) return bad(400, "bad_role");
      const h = normalizeHandle(b.handle);
      if (!h) return bad(400, "bad_handle");
      const masked = maskHandle(h);
      const label = typeof b.label === "string" && b.label.trim() ? b.label.trim().toLowerCase().slice(0, 30) : null;
      const contact = { id: nextId++, role: role.role, roleLabel: role.label, kind: role.role.startsWith("usg:") ? "usg" : "repair", handle: masked, label, isExample: true, reachable: false, createdAt: now() };
      state.staff.contacts = state.staff.contacts.filter((c) => c.role !== role.role).concat(contact);
      const addedToAllowList = addToAllowList(masked);
      syncAssignments();
      return ok(Object.assign({ assigned: { id: contact.id, role: contact.role, handle: masked, label, isExample: true }, addedToAllowList }, staffView()),
        "Demo: " + masked + " is on " + role.label + " on this page only. Troy would text that phone each new report for it, once it has texted him." + NOT_SENT);
    }
    if ((m = p.match(/^\/api\/staff\/(\d+)$/)) && method === "DELETE") {
      const before = state.staff.contacts.length;
      state.staff.contacts = state.staff.contacts.filter((c) => c.id !== Number(m[1]));
      syncAssignments();
      return ok(Object.assign({ removed: state.staff.contacts.length < before }, staffView()), "Demo: removed on this page only. Troy sends no text for this.");
    }

    return bad(404, "not_found");
  }

  window.TroyData = {
    /** Resolves to "live" or "demo" once the page knows which it is. */
    ready,
    isDemo: () => demo,
    /** The clock the page should count from: the real one when live, the example data's own when not. */
    now: () => (demo ? now() : Date.now()),
    sampleCode: SAMPLE_CODE,
    /** Same shape as before: { status, json }. A demo answer to a button may carry json.demoNote, the line to show. */
    async api(path, method, body) {
      await ready;
      if (!demo) return live(path, method, body);
      return handle(path, (method || "GET").toUpperCase(), body);
    },
  };
})();
