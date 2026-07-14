/*
 * OpenShell security policy presets — mirrors app/lib/securityPresets.ts on the
 * controller so the mobile "Create sandbox" sheet offers the SAME named presets
 * as the web dashboard (Lockdown Mode … Ultra-Lobster). On create we send both
 * `preset: <id>` and the assembled `policy` object, exactly like the web
 * ConfigurationPanel. Keep this in sync with securityPresets.ts.
 */
(function () {
  "use strict";
  var commonReadOnly = ["/usr", "/lib", "/etc", "/proc", "/dev/urandom"];

  window.OPENSHELL_PRESETS = [
    {
      id: "lockdown",
      label: "Lockdown Mode",
      danger: "very-low",
      summary: "Minimal writable paths, hard Landlock requirement, no outbound network policy, and a tiny exec allowlist.",
      policy: {
        version: 1,
        filesystem_policy: { include_workdir: false, read_only: commonReadOnly, read_write: ["/tmp"] },
        landlock: { compatibility: "hard_requirement" },
        process: { run_as_user: "sandbox", run_as_group: "sandbox" },
        network_policies: {},
      },
    },
    {
      id: "enterprise",
      label: "Enterprise Mode",
      danger: "low",
      summary: "Tight filesystem, best-effort Landlock, and explicit read-only HTTPS API access for approved binaries.",
      policy: {
        version: 1,
        filesystem_policy: { include_workdir: true, read_only: commonReadOnly, read_write: ["/sandbox", "/tmp", "/dev/null"] },
        landlock: { compatibility: "best_effort" },
        process: { run_as_user: "sandbox", run_as_group: "sandbox" },
        network_policies: {
          github_rest_api: {
            name: "github-rest-api",
            endpoints: [{ host: "api.github.com", port: 443, protocol: "rest", tls: "terminate", enforcement: "enforce", access: "read-only" }],
            binaries: [{ path: "/usr/bin/git" }, { path: "/usr/bin/curl" }],
          },
        },
      },
    },
    {
      id: "medium-spicy",
      label: "Medium-Spicy",
      danger: "medium",
      summary: "Normal workdir access, common web APIs (GitHub + npm), and a broader developer exec toolchain.",
      policy: {
        version: 1,
        filesystem_policy: { include_workdir: true, read_only: commonReadOnly, read_write: ["/sandbox", "/tmp", "/dev/null"] },
        landlock: { compatibility: "best_effort" },
        process: { run_as_user: "sandbox", run_as_group: "sandbox" },
        network_policies: {
          github_and_npm: {
            name: "github-and-npm",
            endpoints: [
              { host: "api.github.com", port: 443, protocol: "rest", tls: "terminate", enforcement: "enforce", access: "read-write" },
              { host: "registry.npmjs.org", port: 443 },
              { host: "github.com", port: 443 },
            ],
            binaries: [{ path: "/usr/bin/git" }, { path: "/usr/bin/node" }, { path: "/usr/bin/npm" }],
          },
        },
      },
    },
    {
      id: "spicy",
      label: "Spicy",
      danger: "high",
      summary: "Wide dev workflow access including Docker/Kubectl and more permissive network routes.",
      policy: {
        version: 1,
        filesystem_policy: { include_workdir: true, read_only: ["/usr", "/lib", "/etc"], read_write: ["/sandbox", "/tmp", "/dev/null"] },
        landlock: { compatibility: "best_effort" },
        process: { run_as_user: "sandbox", run_as_group: "sandbox" },
        network_policies: {
          dev_ops: {
            name: "dev-ops",
            endpoints: [
              { host: "api.github.com", port: 443, protocol: "rest", tls: "terminate", enforcement: "enforce", access: "full" },
              { host: "registry.npmjs.org", port: 443 },
              { host: "*.docker.com", port: 443 },
              { host: "*.github.com", port: 443 },
            ],
            binaries: [{ path: "/usr/bin/git" }, { path: "/usr/bin/node" }, { path: "/usr/bin/npm" }, { path: "/usr/bin/docker" }],
          },
        },
      },
    },
    {
      id: "ultra-lobster",
      label: "Ultra-Lobster",
      danger: "very-high",
      summary: "Maximum lab convenience: broad writable scope, permissive network policies, and a near-anything-goes exec toolchain.",
      policy: {
        version: 1,
        filesystem_policy: { include_workdir: true, read_only: ["/usr", "/lib"], read_write: ["/sandbox", "/tmp", "/dev/null", "/var/tmp"] },
        landlock: { compatibility: "best_effort" },
        process: { run_as_user: "sandbox", run_as_group: "sandbox" },
        network_policies: {
          broad_https: {
            name: "broad-https",
            endpoints: [
              { host: "*.github.com", port: 443 },
              { host: "*.openai.com", port: 443 },
              { host: "*.anthropic.com", port: 443 },
              { host: "*.npmjs.org", port: 443 },
              { host: "*.docker.com", port: 443 },
              { host: "*", port: 443 },
            ],
            binaries: [
              { path: "/usr/bin/git" }, { path: "/usr/bin/node" }, { path: "/usr/bin/npm" },
              { path: "/usr/bin/python3" }, { path: "/usr/bin/docker" }, { path: "/usr/bin/ssh" },
            ],
          },
        },
      },
    },
  ];
})();
