/*
 * OpenShell Control — mobile companion app.
 *
 * A thin native shell (Capacitor) around a mobile-first UI that talks to a
 * self-hosted OpenShell Control server over HTTPS. It authenticates with a
 * Bearer session token (obtained from /api/auth/login) rather than the browser
 * session cookie, because a native WebView cannot share cookies cross-origin.
 *
 * Two connection modes, mirroring the reference crowdsec_manager app:
 *   - Pangolin: server sits behind a Pangolin tunnel; an access token is sent
 *     as the `?token=` query parameter so Pangolin authorizes the request.
 *   - Direct:   server is reachable directly at the given URL.
 */
(function () {
  "use strict";

  // --- Capacitor bridge (with graceful web fallbacks) -----------------------
  var Cap = window.Capacitor || {};
  var Plugins = Cap.Plugins || {};
  var isNative = !!(Cap.isNativePlatform && Cap.isNativePlatform());

  var Store = {
    async get(key) {
      if (Plugins.Preferences) {
        var res = await Plugins.Preferences.get({ key: key });
        return res && res.value != null ? res.value : null;
      }
      return window.localStorage.getItem(key);
    },
    async set(key, value) {
      if (Plugins.Preferences) return Plugins.Preferences.set({ key: key, value: value });
      window.localStorage.setItem(key, value);
    },
    async remove(key) {
      if (Plugins.Preferences) return Plugins.Preferences.remove({ key: key });
      window.localStorage.removeItem(key);
    },
  };

  async function openExternal(url) {
    if (Plugins.Browser) return Plugins.Browser.open({ url: url, presentationStyle: "fullscreen" });
    window.open(url, "_blank", "noopener,noreferrer");
  }

  var CONFIG_KEY = "openshell.connection";
  var TOKEN_KEY = "openshell.session";

  // --- App state ------------------------------------------------------------
  var state = {
    config: null, // { serverUrl, mode, pangolinToken }
    password: "",
    token: null,
    sandboxes: [],
    gateway: null,
    pollTimer: null,
    activeSandbox: null,
    demo: false, // when true, all API calls are served from local mock data
    approvals: [], // aggregated pending permission requests: { sandbox, req }
    approvalsFilter: null, // when set, the approvals sheet shows only this sandbox id
  };

  // --- Demo mode (offline UI preview) ---------------------------------------
  // Lets you explore the whole interface without a live OpenShell server.
  // Every network call in api() is short-circuited to demoApi() below.
  var demo = {
    sandboxes: [
      { id: "sb-web", name: "web-scraper", namespace: "openshell", status: "running", sshHostAlias: "web-scraper.os", agent: "openclaw", isDefault: true },
      { id: "sb-data", name: "data-pipeline", namespace: "openshell", status: "ready", sshHostAlias: "data-pipeline.os", agent: "openclaw" },
      { id: "sb-desk", name: "desktop-agent", namespace: "openshell", status: "pending", sshHostAlias: "", agent: "hermes" },
      { id: "sb-test", name: "test-runner", namespace: "openshell", status: "stopped", sshHostAlias: "test-runner.os", agent: "custom" },
      { id: "sb-broken", name: "broken-box", namespace: "openshell", status: "error", sshHostAlias: "", agent: "openclaw" },
    ],
    blueprints: [
      { id: "nemoclaw-openclaw", label: "OpenClaw agent", description: "Full OpenClaw coding agent with the web dashboard and terminal." },
      { id: "nemoclaw-hermes", label: "Hermes desktop", description: "GUI desktop sandbox with Hermes remote-desktop access." },
      { id: "custom-sandbox", label: "Custom sandbox", description: "Blank sandbox — bring your own container image." },
    ],
    // Pending network-access policy requests, keyed by sandbox id.
    pending: {
      "sb-web": [
        { chunkId: "a1b2c3d4-1111-4a2b-8c3d-000000000001", status: "pending", rule: "allow tcp api.github.com:443", binary: "git", confidence: "high", rationale: "Agent is cloning a repository from GitHub over HTTPS.", endpoints: ["api.github.com:443"], binaries: ["git", "curl"] },
        { chunkId: "a1b2c3d4-2222-4a2b-8c3d-000000000002", status: "pending", rule: "allow tcp registry.npmjs.org:443", binary: "node", confidence: "medium", rationale: "Installing npm dependencies for the scraping script.", endpoints: ["registry.npmjs.org:443"], binaries: ["node", "npm"] },
      ],
      "sb-data": [
        { chunkId: "b2c3d4e5-3333-4a2b-8c3d-000000000003", status: "pending", rule: "allow tcp 10.0.0.5:5432", binary: "python3", confidence: "low", rationale: "Connecting to an internal PostgreSQL database not previously seen.", endpoints: ["10.0.0.5:5432"], binaries: ["python3"] },
      ],
    },
  };

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function demoApi(path, options) {
    var method = (options.method || "GET").toUpperCase();
    await delay(320); // small latency so spinners/transitions are visible

    if (path === "/api/auth/me") return { operator: true, role: "operator" };
    if (path === "/api/auth/logout") return {};

    if (path === "/api/telemetry/real") {
      return { sandboxes: demo.sandboxes.slice(), nemoclaw: { available: true } };
    }

    if (path === "/api/sandbox/create") {
      if (method === "GET") return { blueprints: demo.blueprints.slice() };
      var name = options.body && options.body.sandboxName;
      var agent = (options.body && options.body.agent)
        || (/hermes/.test(options.body && options.body.blueprint) ? "hermes"
          : /custom/.test(options.body && options.body.blueprint) ? "custom" : "openclaw");
      var entry = { id: "sb-" + name, name: name, namespace: "openshell", status: "pending", sshHostAlias: "", agent: agent };
      demo.sandboxes.push(entry);
      // Simulate the sandbox coming up shortly after creation.
      setTimeout(function () { entry.status = "running"; entry.sshHostAlias = name + ".os"; }, 3500);
      return { created: true };
    }

    if (path === "/api/sandbox/delete") {
      var target = options.body && options.body.sandboxName;
      demo.sandboxes = demo.sandboxes.filter(function (s) { return s.name !== target; });
      return { deleted: true };
    }

    var pm = path.match(/^\/api\/sandbox\/([^/]+)\/permissions$/);
    if (pm) {
      var sid = decodeURIComponent(pm[1]);
      if (method === "GET") {
        var pend = (demo.pending[sid] || []).slice();
        return {
          ok: true,
          feed: {
            sandboxId: sid, sandboxName: sid, pending: pend, recent: pend,
            pendingCount: pend.length, approvedCount: 0, rejectedCount: 0,
            latest: pend[0] ? { status: "Pending", chunkId: pend[0].chunkId } : { status: "Ready" },
          },
        };
      }
      var cid = options.body && options.body.chunkId;
      var act = options.body && options.body.action;
      demo.pending[sid] = (demo.pending[sid] || []).filter(function (r) { return r.chunkId !== cid; });
      return { ok: true, note: "Network rule " + (act === "approve" ? "approved" : "rejected") + " (demo)." };
    }

    var m = path.match(/^\/api\/sandbox\/([^/]+)\/(restart|health)$/);
    if (m) {
      if (m[2] === "restart") return { note: "Runtime restarted (demo)." };
      return { summary: "All health checks passed (demo)." };
    }

    return {};
  }

  async function enterDemo() {
    state.demo = true;
    state.token = "demo-session-token";
    state.config = { serverUrl: "https://demo.openshell.local", mode: "direct", allowInsecure: false, pangolinToken: "", pangolinTokenParam: "p_token", proxyUsername: "", proxyPassword: "" };
    blueprints = []; // force reload from the demo blueprint list
    toast("Demo mode — no server connected");
    await enterDashboard();
  }

  // --- DOM helpers ----------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function show(screenId) {
    ["screen-boot", "screen-connect", "screen-dashboard"].forEach(function (id) {
      $(id).setAttribute("data-active", id === screenId ? "true" : "false");
    });
  }
  function setBanner(el, message, kind) {
    if (!message) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = message;
    if (kind) { el.className = "banner " + kind; }
  }
  var toastTimer = null;
  function toast(message) {
    var el = $("toast");
    el.textContent = message;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }
  function busy(button, isBusy, label) {
    if (isBusy) {
      button.dataset.label = button.innerHTML;
      button.innerHTML = '<span class="mini-spinner"></span>' + (label ? " " + label : "");
      button.disabled = true;
    } else {
      if (button.dataset.label) button.innerHTML = button.dataset.label;
      button.disabled = false;
    }
  }

  // --- URL / API ------------------------------------------------------------
  function hasScheme(v) { return /^[a-z][a-z\d+\-.]*:\/\//i.test((v || "").trim()); }

  function normalizeBaseUrl(raw) {
    var url = (raw || "").trim();
    if (!url) return "";
    if (!hasScheme(url)) url = "https://" + url; // default to https; http:// requires Insecure/LAN mode
    return url.replace(/\/+$/, "");
  }

  // A Pangolin access token is `tokenId.tokenSecret`. It rides as the `p_token`
  // (configurable) query param = the combined value, and as the
  // `P-Access-Token-Id` / `P-Access-Token` headers on HTTP requests.
  function parsePangolinToken(value) {
    var t = (value || "").trim();
    if (!t) return null;
    var i = t.indexOf(".");
    if (i <= 0 || i === t.length - 1) return null;
    var id = t.slice(0, i).trim();
    var secret = t.slice(i + 1).trim();
    if (!id || !secret) return null;
    return { id: id, secret: secret, combined: id + "." + secret };
  }

  function pangolinParamName() {
    return (state.config && state.config.pangolinTokenParam) || "p_token";
  }

  function buildUrl(path) {
    var base = state.config.serverUrl + path;
    if (state.config.mode === "pangolin") {
      var tok = parsePangolinToken(state.config.pangolinToken);
      if (tok) {
        base += (base.indexOf("?") === -1 ? "?" : "&") +
          encodeURIComponent(pangolinParamName()) + "=" + encodeURIComponent(tok.combined);
      }
    }
    return base;
  }

  // Edge (reverse-proxy / Pangolin) auth headers. The OpenShell session Bearer
  // is set separately; proxy Basic is only applied when no Bearer is present
  // (i.e. the login request) so it never clobbers the session token.
  //
  // NOTE: Pangolin auth rides ONLY on the `p_token` query param (see buildUrl).
  // We deliberately do NOT send `P-Access-Token-Id` / `P-Access-Token` headers:
  // the controller's CORS allow-list is `authorization,content-type` only, so
  // any extra request header fails the cross-origin preflight from the native
  // WebView origin (https://localhost) and the fetch is blocked before it's
  // sent. The query param is the canonical Pangolin carrier and needs no
  // allow-header entry.
  function applyEdgeAuth(headers) {
    var cfg = state.config || {};
    if (cfg.mode === "proxy" && cfg.proxyUsername && !headers["Authorization"]) {
      headers["Authorization"] = "Basic " + btoa(cfg.proxyUsername + ":" + (cfg.proxyPassword || ""));
    }
  }

  function AuthError(message) { this.name = "AuthError"; this.message = message; }
  AuthError.prototype = Object.create(Error.prototype);

  async function api(path, options) {
    options = options || {};
    if (state.demo) return demoApi(path, options);
    var headers = { Accept: "application/json" };
    if (state.token) headers["Authorization"] = "Bearer " + state.token;
    if (options.body != null) headers["Content-Type"] = "application/json";
    applyEdgeAuth(headers);

    var res;
    try {
      res = await fetch(buildUrl(path), {
        method: options.method || "GET",
        headers: headers,
        body: options.body != null ? JSON.stringify(options.body) : undefined,
        credentials: "include",
        cache: "no-store",
      });
    } catch (err) {
      throw new Error("Cannot reach the server. Check the URL and your connection.");
    }

    if (res.status === 401) throw new AuthError("Session expired. Please sign in again.");

    var data = null;
    var text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }

    if (!res.ok) {
      var msg = (data && (data.error || data.message)) || ("Request failed (" + res.status + ")");
      var e2 = new Error(msg);
      e2.status = res.status;
      e2.data = data;
      throw e2;
    }
    return data;
  }

  async function login(config, password) {
    // Set config first so buildUrl / applyEdgeAuth decorate the login call
    // with the Pangolin token (query + headers) or proxy Basic credentials.
    state.config = config;
    var headers = { "Content-Type": "application/json", Accept: "application/json" };
    applyEdgeAuth(headers);
    var res;
    try {
      res = await fetch(buildUrl("/api/auth/login"), {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ password: password }),
        credentials: "include",
      });
    } catch (err) {
      throw new Error("Cannot reach the server. Check the URL and your connection.");
    }
    var data = null;
    var text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) {} }
    if (res.status === 429) throw new Error((data && data.error) || "Too many attempts. Try again shortly.");
    if (res.status === 401) throw new Error("Invalid operator password.");
    if (!res.ok || !data || !data.token) {
      throw new Error((data && data.error) || "Login failed (" + res.status + ").");
    }
    return data.token;
  }

  // --- Persistence ----------------------------------------------------------
  async function persist() {
    await Store.set(CONFIG_KEY, JSON.stringify(state.config));
    if (state.token) await Store.set(TOKEN_KEY, state.token);
  }
  async function loadStored() {
    var rawConfig = await Store.get(CONFIG_KEY);
    var token = await Store.get(TOKEN_KEY);
    if (rawConfig) { try { state.config = JSON.parse(rawConfig); } catch (e) { state.config = null; } }
    state.token = token || null;
  }
  async function disconnect() {
    stopPolling();
    if (state.token) {
      api("/api/auth/logout", { method: "POST" }).catch(function () {});
    }
    await Store.remove(TOKEN_KEY);
    await Store.remove(CONFIG_KEY);
    state.token = null;
    state.config = null;
    state.sandboxes = [];
    state.demo = false;
    closeAllSheets();
    show("screen-connect");
  }

  // --- Connect screen -------------------------------------------------------
  function currentMode() {
    var sel = document.querySelector("#mode-toggle .seg[aria-selected='true']");
    return sel ? sel.dataset.mode : "direct";
  }
  function applyMode(mode) {
    document.querySelectorAll("#mode-toggle .seg").forEach(function (seg) {
      seg.setAttribute("aria-selected", seg.dataset.mode === mode ? "true" : "false");
    });
    $("connect-form").dataset.mode = mode;
    $("server-url-label").textContent = mode === "pangolin" ? "Pangolin URL" : "Server URL";
  }

  function wireConnectScreen() {
    document.querySelectorAll("#mode-toggle .seg").forEach(function (seg) {
      seg.addEventListener("click", function () { applyMode(seg.dataset.mode); });
    });

    $("insecure-toggle").addEventListener("click", function () {
      var on = this.getAttribute("aria-checked") === "true";
      this.setAttribute("aria-checked", on ? "false" : "true");
    });
    $("pangolin-param-toggle").addEventListener("click", function () {
      var input = $("pangolin-param");
      if (input.hasAttribute("hidden")) { input.removeAttribute("hidden"); this.textContent = "Hide"; }
      else { input.setAttribute("hidden", ""); this.textContent = "Show"; }
    });

    $("demo-btn").addEventListener("click", function () { enterDemo(); });

    $("connect-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      var errEl = $("connect-error");
      setBanner(errEl, "");
      var mode = currentMode();
      var allowInsecure = $("insecure-toggle").getAttribute("aria-checked") === "true";
      var rawUrl = $("server-url").value.trim();
      var password = $("operator-password").value;

      if (!rawUrl) return setBanner(errEl, "Enter your server URL.", "error");
      if (/^http:\/\//i.test(rawUrl) && !allowInsecure) {
        return setBanner(errEl, "http:// requires Insecure / LAN Mode to be enabled.", "error");
      }
      var baseUrl = normalizeBaseUrl(rawUrl);

      var pangolinToken = $("pangolin-token").value.trim();
      var pangolinTokenParam = $("pangolin-param").value.trim() || "p_token";
      var proxyUsername = $("proxy-username").value.trim();
      var proxyPassword = $("proxy-password").value;

      if (mode === "pangolin" && !parsePangolinToken(pangolinToken)) {
        return setBanner(errEl, "Enter a Pangolin access token in the format tokenId.tokenSecret.", "error");
      }
      if (mode === "proxy" && !proxyUsername) {
        return setBanner(errEl, "Enter the proxy username and password.", "error");
      }
      if (!password) return setBanner(errEl, "Enter the operator password.", "error");

      var config = {
        serverUrl: baseUrl, mode: mode, allowInsecure: allowInsecure,
        pangolinToken: pangolinToken, pangolinTokenParam: pangolinTokenParam,
        proxyUsername: proxyUsername, proxyPassword: proxyPassword,
      };

      var submit = $("connect-submit");
      busy(submit, true, "Connecting…");
      try {
        var token = await login(config, password);
        state.token = token;
        state.config = config;
        await persist();
        $("operator-password").value = "";
        await enterDashboard();
      } catch (err) {
        setBanner(errEl, err.message || "Connection failed.", "error");
      } finally {
        busy(submit, false);
      }
    });
  }

  // --- Dashboard ------------------------------------------------------------
  function hostLabel() {
    try { return new URL(state.config.serverUrl).host; } catch (e) { return state.config.serverUrl; }
  }

  async function enterDashboard() {
    show("screen-dashboard");
    $("topbar-host").textContent = hostLabel();
    setConn(true);
    await refreshInventory();
    startPolling();
  }

  function setConn(online) {
    var dot = $("conn-dot");
    dot.className = "status-dot " + (online ? "online" : "offline");
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(function () {
      refreshInventory().catch(function () {});
    }, 10000);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function normalizeStatus(s) {
    var v = (s || "").toString().toLowerCase();
    if (["running", "ready"].indexOf(v) !== -1) return "running";
    if (["pending", "provisioning", "stopping"].indexOf(v) !== -1) return "pending";
    if (["stopped", "deleting"].indexOf(v) !== -1) return "stopped";
    if (v === "error") return "error";
    return "unknown";
  }

  function mapSandboxes(data) {
    if (data && Array.isArray(data.sandboxes)) {
      return data.sandboxes.map(function (s) {
        var status = normalizeStatus(s.status);
        return {
          id: s.id || s.name,
          name: s.name || "unknown",
          namespace: s.namespace || "openshell",
          status: status,
          ready: status === "running",
          host: s.sshHostAlias || "",
          agent: s.agent || "openclaw",
          isDefault: !!s.isDefault,
        };
      });
    }
    return [];
  }

  async function refreshInventory() {
    try {
      var data = await api("/api/telemetry/real");
      state.sandboxes = mapSandboxes(data);
      state.gateway = data && data.nemoclaw ? data.nemoclaw : null;
      setConn(true);
      setBanner($("dash-error"), "");
      renderDashboard();
      refreshApprovals().catch(function () {});
    } catch (err) {
      if (err instanceof AuthError) { return handleAuthExpired(); }
      setConn(false);
      setBanner($("dash-error"), err.message || "Failed to load inventory.", "error");
    }
  }

  // --- Permission requests (policy grants) ----------------------------------
  async function fetchPermissionFeed(sandbox) {
    try {
      var data = await api("/api/sandbox/" + encodeURIComponent(sandbox.id) + "/permissions");
      return data && data.feed ? data.feed : null;
    } catch (e) { return null; }
  }

  function pendingCountFor(sandboxId) {
    return state.approvals.filter(function (it) { return it.sandbox.id === sandboxId; }).length;
  }

  async function refreshApprovals() {
    // Stopped sandboxes can't raise live requests; skip them.
    var targets = state.sandboxes.filter(function (s) { return s.status !== "stopped"; });
    var results = await Promise.all(targets.map(function (s) {
      return fetchPermissionFeed(s).then(function (feed) { return { sandbox: s, feed: feed }; });
    }));
    var items = [];
    results.forEach(function (entry) {
      if (entry.feed && Array.isArray(entry.feed.pending)) {
        entry.feed.pending.forEach(function (req) { items.push({ sandbox: entry.sandbox, req: req }); });
      }
    });
    state.approvals = items;
    renderApprovalsBadge();
    renderDashboard(); // refresh per-card pending pills
    if (!$("approvals-backdrop").hidden) renderApprovalsList();
  }

  function renderApprovalsBadge() {
    var badge = $("approvals-badge");
    var n = state.approvals.length;
    if (n > 0) { badge.textContent = n > 99 ? "99+" : String(n); badge.hidden = false; }
    else { badge.hidden = true; }
  }

  function visibleApprovals() {
    if (!state.approvalsFilter) return state.approvals;
    return state.approvals.filter(function (it) { return it.sandbox.id === state.approvalsFilter; });
  }

  function renderApprovalsList() {
    var list = $("approvals-list");
    list.innerHTML = "";
    var items = visibleApprovals();
    var n = items.length;
    $("approvals-empty").hidden = n !== 0;
    $("approvals-sub").textContent = n
      ? n + " request" + (n === 1 ? "" : "s") + " awaiting your approval."
      : "Agent network access awaiting your approval.";

    items.forEach(function (item) {
      var s = item.sandbox, req = item.req;
      var label = (req.endpoints && req.endpoints[0]) || req.rule || req.chunkId;
      var conf = (req.confidence || "").toLowerCase();
      var card = document.createElement("div");
      card.className = "approval-card";
      card.innerHTML =
        '<div class="approval-top">' +
          '<span class="approval-sb">' + escapeHtml(s.name) + '</span>' +
          (req.confidence ? '<span class="approval-conf ' + escapeHtml(conf) + '">' + escapeHtml(req.confidence) + '</span>' : '') +
        '</div>' +
        '<p class="approval-endpoint">' + escapeHtml(label) + '</p>' +
        (req.rationale ? '<p class="approval-reason">' + escapeHtml(req.rationale) + '</p>' : '') +
        '<div class="approval-actions">' +
          '<button class="btn primary" data-approve>Allow</button>' +
          '<button class="btn subtle" data-deny>Deny</button>' +
        '</div>';
      var allow = card.querySelector("[data-approve]");
      var deny = card.querySelector("[data-deny]");
      allow.addEventListener("click", function () { resolveApproval(s, req, "approve", allow, deny); });
      deny.addEventListener("click", function () { resolveApproval(s, req, "reject", deny, allow); });
      list.appendChild(card);
    });
  }

  async function resolveApproval(sandbox, req, action, btn, other) {
    busy(btn, true);
    if (other) other.disabled = true;
    try {
      await api("/api/sandbox/" + encodeURIComponent(sandbox.id) + "/permissions",
        { method: "POST", body: { action: action, chunkId: req.chunkId } });
      toast((action === "approve" ? "Allowed" : "Denied") + " for " + sandbox.name);
      state.approvals = state.approvals.filter(function (it) {
        return !(it.sandbox.id === sandbox.id && it.req.chunkId === req.chunkId);
      });
      renderApprovalsBadge();
      renderApprovalsList();
      renderDashboard();
      refreshApprovals().catch(function () {}); // reconcile with server
    } catch (err) {
      if (err instanceof AuthError) { closeAllSheets(); return handleAuthExpired(); }
      toast(err.message || "Action failed.");
      busy(btn, false);
      if (other) other.disabled = false;
    }
  }

  function openApprovals(filterId) {
    state.approvalsFilter = filterId || null;
    renderApprovalsList();
    openSheet("approvals-backdrop");
    refreshApprovals().catch(function () {});
  }

  async function handleAuthExpired() {
    stopPolling();
    await Store.remove(TOKEN_KEY);
    state.token = null;
    toast("Session expired — sign in again.");
    // Keep the saved server config; prefill the connect screen.
    prefillConnect();
    show("screen-connect");
  }

  function renderDashboard() {
    var running = state.sandboxes.filter(function (s) { return s.status === "running"; }).length;
    var ready = state.sandboxes.filter(function (s) { return s.ready; }).length;
    $("stat-total").textContent = state.sandboxes.length;
    $("stat-running").textContent = running;
    $("stat-ready").textContent = ready;
    $("stat-gateway").textContent = state.gateway && state.gateway.available ? "up" : "—";

    var list = $("sandbox-list");
    list.innerHTML = "";
    $("sandbox-empty").hidden = state.sandboxes.length !== 0;

    state.sandboxes.forEach(function (s) {
      var pending = pendingCountFor(s.id);
      var card = document.createElement("button");
      card.className = "sandbox-card";
      card.innerHTML =
        '<span class="sb-dot ' + s.status + '"></span>' +
        '<span class="sb-body">' +
          '<span class="sb-name">' + escapeHtml(s.name) + (s.isDefault ? ' <span class="sb-badge">default</span>' : '') + '</span>' +
          '<span class="sb-meta">' + escapeHtml(s.status) + ' · ' + escapeHtml(s.agent) + '</span>' +
        '</span>' +
        (pending ? '<span class="sb-pending">' + pending + '</span>' : '') +
        '<span class="sb-chev"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></span>';
      card.addEventListener("click", function () { openSandboxSheet(s); });
      list.appendChild(card);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // --- Sandbox detail sheet -------------------------------------------------
  function openSandboxSheet(sandbox) {
    state.activeSandbox = sandbox;
    $("sheet-name").textContent = sandbox.name;
    $("sheet-sub").textContent = sandbox.namespace + " · " + (sandbox.host || sandbox.agent);
    var pill = $("sheet-status");
    pill.textContent = sandbox.status;
    pill.className = "pill " + sandbox.status;
    setBanner($("sheet-message"), "");

    var pend = pendingCountFor(sandbox.id);
    var pbtn = $("sheet-permissions");
    if (pend > 0) {
      pbtn.textContent = "Review " + pend + " permission request" + (pend === 1 ? "" : "s");
      pbtn.hidden = false;
    } else {
      pbtn.hidden = true;
    }

    openSheet("sheet-backdrop");
  }

  async function sandboxAction(action, buttonEl) {
    var s = state.activeSandbox;
    if (!s) return;
    var msgEl = $("sheet-message");
    setBanner(msgEl, "");

    if (action === "console") {
      return openConsole("/");
    }
    if (action === "destroy") {
      return confirmDestroy(s);
    }

    busy(buttonEl, true);
    try {
      if (action === "restart") {
        var r = await api("/api/sandbox/" + encodeURIComponent(s.id) + "/restart", { method: "POST" });
        setBanner(msgEl, (r && r.note) || "Runtime restarted.", "info");
        toast("Restarted " + s.name);
      } else if (action === "health") {
        var h = await api("/api/sandbox/" + encodeURIComponent(s.id) + "/health");
        setBanner(msgEl, summarizeHealth(h), "info");
      }
      refreshInventory().catch(function () {});
    } catch (err) {
      if (err instanceof AuthError) { closeAllSheets(); return handleAuthExpired(); }
      setBanner(msgEl, err.message || "Action failed.", "error");
    } finally {
      busy(buttonEl, false);
    }
  }

  function summarizeHealth(h) {
    if (!h) return "No health data returned.";
    if (typeof h.summary === "string") return h.summary;
    if (typeof h.status === "string") return "Status: " + h.status;
    if (h.ok === true) return "Sandbox reports healthy.";
    if (h.healthy != null) return h.healthy ? "Sandbox reports healthy." : "Sandbox reports unhealthy.";
    return "Health check completed.";
  }

  function confirmDestroy(s) {
    var msgEl = $("sheet-message");
    setBanner(msgEl, "Destroying " + s.name + " is permanent. Tap Destroy again to confirm.", "error");
    var btn = document.querySelector('#sandbox-sheet [data-action="destroy"]');
    if (btn.dataset.armed === "1") {
      btn.dataset.armed = "";
      doDestroy(s, btn);
      return;
    }
    btn.dataset.armed = "1";
    btn.classList.add("solid");
    btn.textContent = "Confirm destroy";
    setTimeout(function () {
      if (btn.dataset.armed === "1") {
        btn.dataset.armed = "";
        btn.classList.remove("solid");
        btn.textContent = "Destroy sandbox";
      }
    }, 4000);
  }

  async function doDestroy(s, btn) {
    btn.classList.remove("solid");
    btn.textContent = "Destroy sandbox";
    busy(btn, true, "Destroying…");
    try {
      await api("/api/sandbox/delete", { method: "POST", body: { sandboxName: s.name } });
      toast("Destroyed " + s.name);
      closeAllSheets();
      refreshInventory().catch(function () {});
    } catch (err) {
      if (err instanceof AuthError) { closeAllSheets(); return handleAuthExpired(); }
      setBanner($("sheet-message"), err.message || "Destroy failed.", "error");
    } finally {
      busy(btn, false);
    }
  }

  // --- Create sheet ---------------------------------------------------------
  var blueprints = [];

  // Security policy presets come from presets.js (window.OPENSHELL_PRESETS),
  // mirroring the controller's securityPresets.ts so the names match the web UI
  // (Lockdown Mode … Ultra-Lobster).
  function presetList() { return window.OPENSHELL_PRESETS || []; }
  function findPreset(id) {
    var list = presetList();
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
    return null;
  }

  function createMode() {
    var sel = document.querySelector("#create-mode-toggle .seg[aria-selected='true']");
    return sel ? sel.dataset.cmode : "new";
  }
  function applyCreateMode(mode) {
    document.querySelectorAll("#create-mode-toggle .seg").forEach(function (seg) {
      seg.setAttribute("aria-selected", seg.dataset.cmode === mode ? "true" : "false");
    });
    $("create-form").dataset.cmode = mode;
    populatePolicyPresets(mode);
  }
  function populatePolicyPresets(mode) {
    var sel = $("create-policy");
    // First option = no preset. In duplicate mode that means "keep the copied
    // image's policy"; in new mode it means the server's default sandbox policy.
    var first = mode === "duplicate"
      ? '<option value="">Inherit from image</option>'
      : '<option value="">Default policy</option>';
    sel.innerHTML = first + presetList().map(function (p) {
      return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.label) + "</option>";
    }).join("");
    sel.value = "";
    updatePolicyHint();
  }
  function updatePolicyHint() {
    var id = $("create-policy").value;
    if (!id) {
      $("create-policy-hint").textContent = createMode() === "duplicate"
        ? "Keep the copied image's existing policy unchanged."
        : "Use the server's default sandbox policy.";
      return;
    }
    var p = findPreset(id);
    $("create-policy-hint").textContent = p ? p.summary : "";
  }

  async function openCreateSheet() {
    setBanner($("create-error"), "");
    $("create-name").value = "";
    applyCreateMode("new");
    var select = $("create-blueprint");
    if (!blueprints.length) {
      select.innerHTML = '<option value="">Loading…</option>';
      try {
        var data = await api("/api/sandbox/create");
        blueprints = (data && data.blueprints) || [];
      } catch (err) {
        if (err instanceof AuthError) { return handleAuthExpired(); }
        blueprints = [];
      }
    }
    if (blueprints.length) {
      select.innerHTML = blueprints.map(function (b) {
        return '<option value="' + escapeHtml(b.id) + '">' + escapeHtml(b.label || b.id) + "</option>";
      }).join("");
      updateBlueprintHint();
    } else {
      select.innerHTML = '<option value="custom-sandbox">Custom sandbox</option>';
    }
    openSheet("create-backdrop");
  }
  function updateBlueprintHint() {
    var id = $("create-blueprint").value;
    var b = blueprints.filter(function (x) { return x.id === id; })[0];
    $("create-blueprint-hint").textContent = b && b.description ? b.description : "";
  }

  async function submitCreate(e) {
    e.preventDefault();
    var errEl = $("create-error");
    setBanner(errEl, "");
    var mode = createMode();
    var name = $("create-name").value.trim();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
      return setBanner(errEl, "Name must be lowercase letters, numbers and hyphens.", "error");
    }
    var presetObj = $("create-policy").value ? findPreset($("create-policy").value) : null;
    var preset = presetObj ? presetObj.id : null;
    var policy = presetObj ? presetObj.policy : null;

    // New: build from a fresh blueprint. Duplicate: copy the latest running
    // image of the chosen agent type (the redeploy-image / Quick Deploy path).
    // preset + policy mirror the web ConfigurationPanel create payload.
    var body = mode === "duplicate"
      ? { blueprint: "redeploy-image", sandboxName: name, agent: $("create-agent").value, preset: preset, policy: policy }
      : { blueprint: $("create-blueprint").value, sandboxName: name, preset: preset, policy: policy };

    var submit = $("create-submit");
    busy(submit, true, mode === "duplicate" ? "Duplicating…" : "Creating…");
    try {
      var r = await api("/api/sandbox/create", { method: "POST", body: body });
      toast(r && r.created ? "Created " + name : "Create started for " + name);
      closeAllSheets();
      refreshInventory().catch(function () {});
    } catch (err) {
      if (err instanceof AuthError) { closeAllSheets(); return handleAuthExpired(); }
      setBanner(errEl, err.message || "Create failed.", "error");
    } finally {
      busy(submit, false);
    }
  }

  // --- Full web console handoff ---------------------------------------------
  function consoleUrl(path) {
    var target = path || "/";
    var url = state.config.serverUrl + "/api/auth/handoff?session=" + encodeURIComponent(state.token || "") +
      "&next=" + encodeURIComponent(target);
    if (state.config.mode === "pangolin") {
      var tok = parsePangolinToken(state.config.pangolinToken);
      if (tok) url += "&" + encodeURIComponent(pangolinParamName()) + "=" + encodeURIComponent(tok.combined);
    }
    return url;
  }

  async function openConsole(path) {
    if (state.demo) { toast("Web console is disabled in demo mode."); return; }
    await openExternal(consoleUrl(path));
  }

  async function copyConsoleLink() {
    if (state.demo) { toast("Console link is disabled in demo mode."); return; }
    var url = consoleUrl("/");
    try {
      await navigator.clipboard.writeText(url);
      toast("Console link copied — opens signed in");
    } catch (e) {
      toast("Copy failed on this device.");
    }
  }

  // --- Sheets plumbing ------------------------------------------------------
  function openSheet(backdropId) { $(backdropId).hidden = false; }
  function closeAllSheets() {
    ["sheet-backdrop", "create-backdrop", "menu-backdrop", "approvals-backdrop"].forEach(function (id) { $(id).hidden = true; });
  }
  function wireSheets() {
    // Close when tapping the backdrop (but not the sheet body).
    ["sheet-backdrop", "create-backdrop", "menu-backdrop", "approvals-backdrop"].forEach(function (id) {
      $(id).addEventListener("click", function (e) { if (e.target === $(id)) closeAllSheets(); });
    });

    document.querySelectorAll("#sandbox-sheet [data-action]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var action = btn.dataset.action;
        if (action === "close-sheet") return closeAllSheets();
        if (action === "permissions") {
          var sid = state.activeSandbox && state.activeSandbox.id;
          closeAllSheets();
          return openApprovals(sid);
        }
        sandboxAction(action, btn);
      });
    });

    $("create-form").addEventListener("submit", submitCreate);
    $("create-blueprint").addEventListener("change", updateBlueprintHint);
    $("create-policy").addEventListener("change", updatePolicyHint);
    document.querySelectorAll("#create-mode-toggle .seg").forEach(function (seg) {
      seg.addEventListener("click", function () { applyCreateMode(seg.dataset.cmode); });
    });
    $("create-agent").addEventListener("change", function () {
      // Default a copy name from the chosen image type, if the user hasn't typed one.
      if (!$("create-name").value) $("create-name").value = $("create-agent").value + "-copy";
    });
    document.querySelector('[data-action="close-create"]').addEventListener("click", closeAllSheets);

    $("create-fab").addEventListener("click", openCreateSheet);
    $("refresh-btn").addEventListener("click", function () { refreshInventory(); toast("Refreshing…"); });
    $("console-btn").addEventListener("click", function () { openConsole("/"); });

    $("approvals-btn").addEventListener("click", function () { openApprovals(); });
    document.querySelector('[data-action="close-approvals"]').addEventListener("click", closeAllSheets);

    $("menu-btn").addEventListener("click", function () { openSheet("menu-backdrop"); });
    document.querySelector('[data-action="menu-console"]').addEventListener("click", function () { closeAllSheets(); openConsole("/"); });
    document.querySelector('[data-action="menu-copy-link"]').addEventListener("click", function () { closeAllSheets(); copyConsoleLink(); });
    document.querySelector('[data-action="menu-refresh"]').addEventListener("click", function () { closeAllSheets(); refreshInventory(); });
    document.querySelector('[data-action="menu-disconnect"]').addEventListener("click", function () { disconnect(); });
    document.querySelector('[data-action="close-menu"]').addEventListener("click", closeAllSheets);
  }

  // --- Boot -----------------------------------------------------------------
  function prefillConnect() {
    if (!state.config) return;
    $("server-url").value = state.config.serverUrl || "";
    applyMode(state.config.mode || "direct");
    if (state.config.pangolinToken) $("pangolin-token").value = state.config.pangolinToken;
    if (state.config.pangolinTokenParam) $("pangolin-param").value = state.config.pangolinTokenParam;
    if (state.config.proxyUsername) $("proxy-username").value = state.config.proxyUsername;
    if (state.config.proxyPassword) $("proxy-password").value = state.config.proxyPassword;
    $("insecure-toggle").setAttribute("aria-checked", state.config.allowInsecure ? "true" : "false");
  }

  async function boot() {
    wireConnectScreen();
    wireSheets();
    applyMode("direct");

    if (Plugins.StatusBar && isNative) { Plugins.StatusBar.setStyle({ style: "DARK" }).catch(function () {}); }
    if (Plugins.App) {
      Plugins.App.addListener("backButton", function () {
        // Close any open sheet on hardware back; otherwise let the OS decide.
        var open = ["sheet-backdrop", "create-backdrop", "menu-backdrop", "approvals-backdrop"].some(function (id) { return !$(id).hidden; });
        if (open) closeAllSheets();
      });
    }

    await loadStored();

    if (state.config && state.token) {
      // Validate the stored token and connectivity before showing the dashboard.
      try {
        var me = await api("/api/auth/me");
        if (!me || !(me.operator === true || me.role === "operator" || me.role === "disabled")) {
          throw new AuthError("Not authorized as operator.");
        }
        await enterDashboard();
      } catch (err) {
        prefillConnect();
        show("screen-connect");
      }
    } else {
      prefillConnect();
      show("screen-connect");
    }

    if (Plugins.SplashScreen) { Plugins.SplashScreen.hide().catch(function () {}); }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
