// `npm run smoke` — exercise the real hosted first-run sequence.
//
// Every assertion here was derived by running the sequence and observing what
// 0.1.10 actually does, not from the docs. Where behavior is a known wart the
// test pins the CURRENT behavior and says so, so an upstream fix shows up as a
// failing expectation to update rather than a silent change.
//
// The test runs against a throwaway clone in a temp dir, never the working
// tree: starting the editor scaffolds `.codeyam/`, rewrites `.gitignore`, and
// COMMITS the refreshed tooling. None of that belongs in your checkout.
//
// Port: defaults to 5000, the port Replit forwards. Override with PORT when
// 5000 is taken -- on macOS, AirPlay Receiver holds it by default.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.env.PORT || "5000";
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
const BOOT_TIMEOUT_MS = 120_000;
const PREVIEW_TIMEOUT_MS = 60_000;
// The editor binds its Live Preview reverse proxy here for the app.
const APP_PORT = 3000;
const REPO = process.cwd();

let failures = 0;
let workdir;
let checkoutPath;
let editor;

function check(name, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) {
    failures += 1;
    if (detail) console.log(`        ${detail}`);
  }
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr ?? ""}`,
    );
  }
  return r.stdout;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Fail fast, and legibly, when a port the editor needs is already taken.
/// APP_PORT matters as much as PORT: the editor binds a reverse proxy there for
/// the Live Preview, and when it cannot, `/__codeyam_preview/` answers 502
/// instead of the editor surface -- which reads as a preview bug rather than a
/// busy port. Back-to-back runs are the usual cause: the previous editor has
/// not released :3000 yet.
async function requirePortFree(port) {
  const { createServer } = await import("node:net");
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (e) =>
      reject(
        new Error(
          `port ${port} is already in use (${e.code}). ` +
            `Free it, or wait for a previous run to release it: ` +
            `lsof -nP -iTCP:${port} -sTCP:LISTEN`,
        ),
      ),
    );
    probe.once("listening", () => probe.close(resolve));
    probe.listen(port, "0.0.0.0");
  });
}

/// Fetch the preview, retrying while the app-port proxy is still coming up.
/// The proxy binds asynchronously after the editor answers on its own port, so
/// a single immediate request races it and sees a 502.
async function fetchPreviewWhenReady(headers) {
  const deadline = Date.now() + PREVIEW_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    last = await fetch(`${BASE}/__codeyam_preview/`, {
      headers,
      redirect: "manual",
    });
    if (last.status !== 502) return last;
    await sleep(500);
  }
  return last;
}

/// Signal the editor's whole process group and wait for it to actually exit.
/// Escalates to SIGKILL rather than trusting a graceful stop, then confirms the
/// group is gone -- a teardown that returns while the editor is still running
/// leaves the next run fighting for the port.
async function shutdown() {
  if (!editor || editor.exitCode !== null) return;
  const group = -editor.pid;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(group, signal);
    } catch {
      return; // already gone
    }
    for (let i = 0; i < 20; i += 1) {
      await sleep(250);
      try {
        process.kill(group, 0);
      } catch {
        return; // reaped
      }
    }
  }
}

async function waitForBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (editor.exitCode !== null) {
      throw new Error(`editor exited early with code ${editor.exitCode}`);
    }
    try {
      const res = await fetch(`${BASE}/`, { redirect: "manual" });
      if (res.status > 0) return res;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`editor did not answer on ${BASE} within ${BOOT_TIMEOUT_MS}ms`);
}

try {
  // 1. Fresh checkout. `git clone` of the working tree, so the test covers what
  // is actually committed -- an uncommitted fix does not make this pass.
  workdir = mkdtempSync(join(tmpdir(), "codeyam-smoke-"));
  const checkout = join(workdir, "starter");
  checkoutPath = checkout;
  console.log("\nFresh checkout");
  sh("git", ["clone", "--quiet", REPO, checkout]);
  check("cloned HEAD into a temp dir", true);

  // 2. Install. Catches a lockfile that cannot resolve from the public
  // registry -- the exact failure that shipped in the first version of this
  // repo, where every `resolved` URL pointed at Replit's internal mirror.
  console.log("\nInstall");
  // `npm ci` when a lockfile is committed -- it is stricter, and catches a
  // lockfile that cannot resolve from the public registry (the exact failure
  // this repo shipped with). The staging variant deliberately commits no
  // lockfile, so that it always resolves the newest staging build; there,
  // `npm install` is the only option.
  const locked = existsSync(join(checkout, "package-lock.json"));
  sh("npm", [locked ? "ci" : "install", "--no-audit", "--no-fund"], {
    cwd: checkout,
  });
  check(
    `npm ${locked ? "ci" : "install"} resolved every dependency`,
    true,
    undefined,
  );

  // 3. Start on 0.0.0.0:PORT, exactly as the Replit workflow does.
  console.log("\nStart");
  // `detached` puts the whole chain -- npm, the wrapper, and the editor binary
  // it spawns -- into one process group. Signalling the group is the only
  // teardown that actually reaches the editor: SIGTERM to npm alone leaves the
  // grandchild running, holding the port and the temp checkout open.
  editor = spawn("npm", ["run", "codeyam"], {
    cwd: checkout,
    env: { ...process.env, PORT },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  for (const s of [editor.stdout, editor.stderr]) {
    s.setEncoding("utf8");
    s.on("data", (d) => {
      log += d;
    });
  }

  const root = await waitForBoot();
  check(`editor answered on ${BASE}`, true);
  check(
    "bound to 0.0.0.0, not just loopback",
    /running at http:\/\/0\.0\.0\.0:/.test(log),
    "expected the startup banner to report an 0.0.0.0 bind",
  );

  // 4. GET / issues the session cookie on the HTML document.
  console.log("\nSession cookie");
  check("GET / returned 200", root.status === 200, `got ${root.status}`);
  const setCookie = root.headers.get("set-cookie") ?? "";
  const token = /cy_session=([A-Za-z0-9]+)/.exec(setCookie)?.[1];
  check("GET / set a cy_session cookie", Boolean(token), setCookie || "(none)");
  check(
    "cookie is HttpOnly",
    /HttpOnly/i.test(setCookie),
    "the browser must not expose this token to page scripts",
  );
  check(
    "cookie is SameSite=Lax",
    /SameSite=Lax/i.test(setCookie),
    setCookie,
  );

  const cookie = `cy_session=${token}`;
  const fileToken = readFileSync(
    join(checkout, ".codeyam/session-token"),
    "utf8",
  ).trim();
  check(
    "cookie matches .codeyam/session-token",
    fileToken === token,
    "the bearer path and the browser path must share one token",
  );

  // 5. A protected endpoint is genuinely protected. /api/scenarios is used
  // deliberately: /api/health, /api/config and /api/session-info are
  // token-EXEMPT by design (read-only, non-secret), so probing those would
  // pass whether or not auth works at all.
  console.log("\nControl API auth");
  const scen = (headers) =>
    fetch(`${BASE}/api/scenarios`, { headers, redirect: "manual" });

  check("no credentials -> 401", (await scen({})).status === 401);
  check(
    "wrong cookie -> 401",
    (await scen({ cookie: "cy_session=deadbeef" })).status === 401,
  );
  check("session cookie -> 200", (await scen({ cookie })).status === 200);
  check(
    "Authorization: Bearer -> 200",
    (await scen({ authorization: `Bearer ${fileToken}` })).status === 200,
    "the CLI and operator-script path must work too",
  );

  // 6. The hosted preview route.
  console.log("\nHosted preview");
  const prevAuthed = await fetchPreviewWhenReady({ cookie });
  const prevBody = await prevAuthed.text();
  check(
    "authenticated preview returns HTML",
    prevAuthed.status === 200 &&
      (prevAuthed.headers.get("content-type") ?? "").includes("text/html"),
    `status ${prevAuthed.status}, type ${prevAuthed.headers.get("content-type")}`,
  );
  check(
    "preview body is a real document",
    /<!DOCTYPE html>/i.test(prevBody),
    prevBody.slice(0, 120),
  );

  // With no app configured the preview must still serve the editor's own
  // no-app surface rather than erroring -- this is the state every imported
  // project starts in, so it is the state most worth pinning.
  check(
    "no-app state stays on the editor surface",
    prevAuthed.headers.get("x-codeyam-dev-server-down") === "1",
    "expected the dev-server-down marker that drives the onboarding UI",
  );
  check(
    "no-app state is not an error page",
    prevAuthed.status === 200,
    `got ${prevAuthed.status}`,
  );

  // 7. KNOWN WART, pinned deliberately.
  //
  // A browser navigating straight to /__codeyam_preview/ before it holds a
  // cookie gets raw 401 JSON, not HTML and not a redirect to `/` (which is
  // what mints the cookie). That is a codeyam-editor issue, not something the
  // starter can fix -- but it is exactly what a user hitting the Replit
  // preview URL cold can land on.
  //
  // This asserts the CURRENT behavior. When upstream starts redirecting or
  // serving HTML here, this check fails and should be rewritten to assert the
  // better behavior.
  console.log("\nKnown wart (pinned)");
  const prevCold = await fetch(`${BASE}/__codeyam_preview/`, {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  const coldType = prevCold.headers.get("content-type") ?? "";
  const stillWart =
    prevCold.status === 401 && coldType.includes("application/json");
  check(
    "cold preview navigation still answers 401 JSON (upstream wart)",
    stillWart,
    `status ${prevCold.status}, type ${coldType} -- if this is now HTML or a ` +
      `redirect, upstream fixed it: update this check to assert that instead`,
  );
} catch (error) {
  failures += 1;
  console.log(`\nFAIL  ${error.message}`);
} finally {
  await shutdown();
  // The PTY broker is a separate per-project daemon that deliberately outlives
  // the editor server (it holds the agent's PTY across server restarts), so it
  // survives the process group and rewrites `.codeyam/run/` after cleanup.
  // Stop it explicitly. Best-effort: on a run that never opened an agent
  // session there is no broker to stop, and that is not a failure.
  if (checkoutPath) {
    spawnSync(
      "npx",
      ["codeyam-editor", "editor", "pty-broker", "stop"],
      { cwd: checkoutPath, stdio: "ignore" },
    );
  }
  // Only after everything is really gone: a live process holding files inside
  // the checkout leaves residue behind the removal.
  if (workdir) rmSync(workdir, { recursive: true, force: true });
}

console.log(
  failures ? `\n${failures} check(s) failed.\n` : "\nAll checks passed.\n",
);
process.exit(failures ? 1 : 0);
