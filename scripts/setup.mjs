// `npm run setup` — the one command that prepares and diagnoses this workspace.
//
// Advisory by design. Every step reports and moves on, and the script exits 0
// even with warnings, so a partially-configured workspace (no provider login
// yet, say) still tells you what to do next instead of looking like a hard
// failure. Only an unusable Node version exits non-zero, because nothing
// downstream can work.
//
// Running it is optional: `npm run codeyam` initializes what it needs on its
// own. This exists so setup state is inspectable without starting the editor.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { childEnv, port, portError, provider, providerError } from "./env.mjs";

const MIN_NODE_MAJOR = 20;

let warnings = 0;

const pass = (m) => console.log(`  ok    ${m}`);
const warn = (m) => {
  warnings += 1;
  console.log(`  warn  ${m}`);
};

function step(name) {
  console.log(`\n${name}`);
}

function run(args, env) {
  return spawnSync("codeyam-editor", args, {
    encoding: "utf8",
    env,
    // Captured, not inherited: these are diagnostics, and health-status is
    // chatty. Detail is replayed only when a step actually fails.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function replay(result) {
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (!detail) return;
  for (const line of detail.split("\n")) console.log(`        ${line}`);
}

// 1. Node version.
step("Node");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (Number.isNaN(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
  console.log(
    `  fail  Node ${process.versions.node} is too old; ` +
      `CodeYam needs ${MIN_NODE_MAJOR}+.`,
  );
  console.log(
    `\nSet "modules" in .replit to a nodejs-${MIN_NODE_MAJOR}-or-newer module.`,
  );
  process.exit(1);
}
pass(`Node ${process.versions.node}`);

// 2. Configuration supplied by the environment.
step("Configuration");
const configErrors = [providerError(), portError()].filter(Boolean);
for (const error of configErrors) warn(error);
if (!configErrors.length) {
  pass(`editor port ${port}`);
  pass(
    provider
      ? `provider pinned to ${provider} via CODEYAM_PROVIDER`
      : "provider unset — CodeYam will choose (recommended)",
  );
}

const env = childEnv();
pass(`provider CLI install prefix ${env.npm_config_prefix}`);

// 3. Project initialization. Idempotent, so an initialized project is a no-op.
step("Project");
if (existsSync(".codeyam/editor.json")) {
  pass(".codeyam/editor.json present");
} else {
  const init = run(provider ? ["init", "--provider", provider] : ["init"], env);
  if (init.error) {
    warn(`could not run codeyam-editor: ${init.error.message}`);
    warn("run `npm install` first");
  } else if (init.status !== 0) {
    warn("codeyam-editor init failed");
    replay(init);
  } else {
    pass("initialized .codeyam/editor.json");
  }
}

// 4. Health, including whether generated editor assets are in sync and whether
// the provider CLI is on PATH. Non-zero here is normal on a fresh workspace
// (no scenarios yet, no dev server running), so it is reported, not fatal.
//
// Deliberately read-only. `codeyam-editor editor install-hooks` is the repair
// for an out-of-sync agent surface, but it CREATES A GIT COMMIT, so it is not
// run here — a setup command must not write to the user's history. The
// health output names it when it is actually needed.
step("Health");
if (existsSync(".codeyam/editor.json")) {
  const health = run(["editor", "health-status"], env);
  if (health.error) {
    warn(`could not run health-status: ${health.error.message}`);
  } else if (health.status === 0) {
    pass("all health checks passed");
  } else {
    warn("health checks reported problems");
    replay(health);
  }
} else {
  warn("skipped — project is not initialized");
}

// 5. What to do next.
step("Next");
console.log(
  warnings
    ? `  ${warnings} warning(s) above. Most resolve on first run — the editor\n` +
        "  installs the provider CLI and prompts for login when you start it."
    : "  This workspace is ready.",
);
console.log(
  "\n  Click Run, or start the editor directly with:\n\n" +
    "    npm run codeyam\n",
);
