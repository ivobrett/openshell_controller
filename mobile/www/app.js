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
  };

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
  function normalizeBaseUrl(raw) {
    var url = (raw || "").trim();
    if (!url) return "";
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    return url.replace(/\/+$/, "");
  }

  function buildUrl(path) {
    var base = state.config.serverUrl + path;
    var params = [];
    if (state.config.mode === "pangolin" && state.config.pangolinToken) {
      params.push("token=" + encodeURIComponent(state.config.pangolinToken));
    }
    if (!params.length) return base;
    return base + (base.indexOf("?") === -1 ? "?" : "&") + params.join("&");
  }

  function AuthError(message) { this.name = "AuthError"; this.message = message; }
  AuthError.prototype = Object.create(Error.prototype);

  async function api(path, options) {
    options = options || {};
    var headers = { Accept: "application/json" };
    if (state.token) headers["Authorization"] = "Bearer " + state.token;
    if (options.body != null) headers["Content-Type"] = "application/json";

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

  async function login(baseUrl, password, mode, pangolinToken) {
    // Temporarily set config so buildUrl adds the Pangolin token to the login call.
    state.config = { serverUrl: baseUrl, mode: mode, pangolinToken: pangolinToken };
    var headers = { "Content-Type": "application/json", Accept: "application/json" };
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
    closeAllSheets();
    show("screen-connect");
  }

  // --- Connect screen -------------------------------------------------------
  function currentMode() {
    var sel = document.querySelector("#mode-toggle .seg[aria-selected='true']");
    return sel ? sel.dataset.mode : "pangolin";
  }
  function applyMode(mode) {
    document.querySelectorAll("#mode-toggle .seg").forEach(function (seg) {
      seg.setAttribute("aria-selected", seg.dataset.mode === mode ? "true" : "false");
    });
    $("pangolin-field").hidden = mode !== "pangolin";
    $("mode-hint").textContent = mode === "pangolin"
      ? "Pangolin protects your server behind a secure tunnel. Paste the access token from your Pangolin resource share link."
      : "Connect straight to your server URL. Use this on a trusted network or your own reverse proxy/VPN.";
  }

  function wireConnectScreen() {
    document.querySelectorAll("#mode-toggle .seg").forEach(function (seg) {
      seg.addEventListener("click", function () { applyMode(seg.dataset.mode); });
    });

    $("connect-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      var errEl = $("connect-error");
      setBanner(errEl, "");
      var baseUrl = normalizeBaseUrl($("server-url").value);
      var mode = currentMode();
      var pangolinToken = $("pangolin-token").value.trim();
      var password = $("operator-password").value;

      if (!baseUrl) return setBanner(errEl, "Enter your server URL.", "error");
      if (mode === "pangolin" && !pangolinToken) return setBanner(errEl, "Enter your Pangolin access token, or switch to Direct URL mode.", "error");
      if (!password) return setBanner(errEl, "Enter the operator password.", "error");

      var submit = $("connect-submit");
      busy(submit, true, "Connecting…");
      try {
        var token = await login(baseUrl, password, mode, pangolinToken);
        state.token = token;
        state.config = { serverUrl: baseUrl, mode: mode, pangolinToken: pangolinToken };
        await persist();
        $("operator-password").value = "";
        $("pangolin-token").value = "";
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
    } catch (err) {
      if (err instanceof AuthError) { return handleAuthExpired(); }
      setConn(false);
      setBanner($("dash-error"), err.message || "Failed to load inventory.", "error");
    }
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
      var card = document.createElement("button");
      card.className = "sandbox-card";
      card.innerHTML =
        '<span class="sb-dot ' + s.status + '"></span>' +
        '<span class="sb-body">' +
          '<span class="sb-name">' + escapeHtml(s.name) + (s.isDefault ? ' <span class="sb-badge">default</span>' : '') + '</span>' +
          '<span class="sb-meta">' + escapeHtml(s.status) + ' · ' + escapeHtml(s.agent) + '</span>' +
        '</span>' +
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
  async function openCreateSheet() {
    setBanner($("create-error"), "");
    $("create-name").value = "";
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
    var name = $("create-name").value.trim();
    var blueprint = $("create-blueprint").value;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
      return setBanner(errEl, "Name must be lowercase letters, numbers and hyphens.", "error");
    }
    var submit = $("create-submit");
    busy(submit, true, "Creating…");
    try {
      var r = await api("/api/sandbox/create", { method: "POST", body: { blueprint: blueprint, sandboxName: name } });
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
  async function openConsole(path) {
    var target = path || "/";
    var url = state.config.serverUrl + "/api/auth/handoff?session=" + encodeURIComponent(state.token || "") +
      "&next=" + encodeURIComponent(target);
    if (state.config.mode === "pangolin" && state.config.pangolinToken) {
      url += "&token=" + encodeURIComponent(state.config.pangolinToken);
    }
    await openExternal(url);
  }

  // --- Sheets plumbing ------------------------------------------------------
  function openSheet(backdropId) { $(backdropId).hidden = false; }
  function closeAllSheets() {
    ["sheet-backdrop", "create-backdrop", "menu-backdrop"].forEach(function (id) { $(id).hidden = true; });
  }
  function wireSheets() {
    // Close when tapping the backdrop (but not the sheet body).
    ["sheet-backdrop", "create-backdrop", "menu-backdrop"].forEach(function (id) {
      $(id).addEventListener("click", function (e) { if (e.target === $(id)) closeAllSheets(); });
    });

    document.querySelectorAll("#sandbox-sheet [data-action]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var action = btn.dataset.action;
        if (action === "close-sheet") return closeAllSheets();
        sandboxAction(action, btn);
      });
    });

    $("create-form").addEventListener("submit", submitCreate);
    $("create-blueprint").addEventListener("change", updateBlueprintHint);
    document.querySelector('[data-action="close-create"]').addEventListener("click", closeAllSheets);

    $("create-fab").addEventListener("click", openCreateSheet);
    $("refresh-btn").addEventListener("click", function () { refreshInventory(); toast("Refreshing…"); });
    $("console-btn").addEventListener("click", function () { openConsole("/"); });

    $("menu-btn").addEventListener("click", function () { openSheet("menu-backdrop"); });
    document.querySelector('[data-action="menu-console"]').addEventListener("click", function () { closeAllSheets(); openConsole("/"); });
    document.querySelector('[data-action="menu-refresh"]').addEventListener("click", function () { closeAllSheets(); refreshInventory(); });
    document.querySelector('[data-action="menu-disconnect"]').addEventListener("click", function () { disconnect(); });
    document.querySelector('[data-action="close-menu"]').addEventListener("click", closeAllSheets);
  }

  // --- Boot -----------------------------------------------------------------
  function prefillConnect() {
    if (!state.config) return;
    $("server-url").value = state.config.serverUrl || "";
    applyMode(state.config.mode || "pangolin");
    if (state.config.pangolinToken) $("pangolin-token").value = state.config.pangolinToken;
  }

  async function boot() {
    wireConnectScreen();
    wireSheets();
    applyMode("pangolin");

    if (Plugins.StatusBar && isNative) { Plugins.StatusBar.setStyle({ style: "DARK" }).catch(function () {}); }
    if (Plugins.App) {
      Plugins.App.addListener("backButton", function () {
        // Close any open sheet on hardware back; otherwise let the OS decide.
        var open = ["sheet-backdrop", "create-backdrop", "menu-backdrop"].some(function (id) { return !$(id).hidden; });
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
