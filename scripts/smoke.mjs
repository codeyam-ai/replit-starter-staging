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
import { request as httpRequest } from "node:http";
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
// Where a cookie-less browser navigation is sent to obtain a session.
const BOOTSTRAP_PATH = "/__codeyam_session_bootstrap";
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

/// Issue a request with EXACTLY the given headers, over raw http.
///
/// Node's `fetch` cannot express a browser navigation: undici injects its own
/// `Sec-Fetch-Mode`, and the editor's navigation check correctly refuses to let
/// `Accept` override a `Sec-Fetch-Mode` that says this is a subresource fetch.
/// So a `fetch`-based probe is always classified as a fetch, and the cold
/// navigation case below cannot be tested with it -- it reports the pre-fix
/// behavior against a build that has the fix.
function rawRequest(path, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: HOST, port: Number(PORT), path, method: "GET", headers },
      (res) => {
        res.resume();
        resolve({
          status: res.statusCode,
          headers: res.headers,
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

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
  // Must run before the spawn: a stale listener from a previous run answers
  // every probe below and the whole suite silently tests the wrong process.
  await requirePortFree(PORT);
  await requirePortFree(APP_PORT);
  check(`ports ${PORT} and ${APP_PORT} are free`, true);
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
  // Match the address, not the sentence around it: the legacy path prints
  // "running at http://0.0.0.0:<port>" and hosted mode prints it in an indented
  // "local:" row. Pinning either phrasing tests the banner, not the bind.
  check(
    "bound to 0.0.0.0, not just loopback",
    new RegExp(`0\\.0\\.0\\.0:${PORT}`).test(log),
    `no 0.0.0.0:${PORT} in the startup output`,
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
  const servedHtml =
    prevAuthed.status === 200 &&
    (prevAuthed.headers.get("content-type") ?? "").includes("text/html");
  check(
    "authenticated preview answers",
    servedHtml || prevAuthed.status === 503,
    `status ${prevAuthed.status}, type ${prevAuthed.headers.get("content-type")}`,
  );
  if (servedHtml) {
    check(
      "preview body is a real document",
      /<!DOCTYPE html>/i.test(prevBody),
      prevBody.slice(0, 120),
    );
  }

  // With no app configured the preview must still serve the editor's own
  // no-app surface rather than erroring -- this is the state every imported
  // project starts in, so it is the state most worth pinning.
  // With no app configured, what the preview serves depends on the start path
  // AND on whether a dev server was ever expected: hosted mode answers 503 with
  // a sentence naming the cause, the legacy path serves the editor surface,
  // sometimes with an `x-codeyam-dev-server-down` marker. All three are
  // correct, so asserting any one of them pins transient state rather than
  // behavior.
  //
  // The invariant worth holding is the one the demo-gate bug report is about:
  // whatever lands in that pane must SAY something. A bare proxy error or an
  // empty body is the failure -- a user asked to approve what they see cannot
  // approve a blank frame.
  const explains503 =
    prevAuthed.status === 503 && /no app is configured/i.test(prevBody);
  check(
    "no-app state is self-explaining, not a blank pane",
    servedHtml || explains503,
    `status ${prevAuthed.status}, body: ${prevBody.slice(0, 120)}`,
  );
  check(
    "no-app state is not a bare proxy error",
    prevAuthed.status !== 502 && prevBody.trim().length > 0,
    `got ${prevAuthed.status} with ${prevBody.length} bytes`,
  );

  // 7. A cold browser navigation must land somewhere usable.
  //
  // This is the case a user hits when the platform restores or deep-links the
  // preview URL before any visit to `/`, so the request carries no cookie. It
  // used to answer raw 401 JSON -- an internal auth error rendered where the
  // app should be, recoverable only by knowing to open `/` first.
  //
  // Builds carrying the session-bootstrap fix redirect instead: 303 to
  // /__codeyam_session_bootstrap, which issues a session (subject to the
  // declared access mode) and sends the browser back. Builds without it still
  // answer JSON. Both are reported by name -- what fails is a third outcome,
  // and what the label tells you is which build you are on.
  console.log("\nCold browser navigation");
  const cold = await rawRequest("/__codeyam_preview/", {
    Accept: "text/html,application/xhtml+xml",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
  });
  const coldType = cold.headers["content-type"] ?? "";
  const bootstraps =
    cold.status === 303 &&
    (cold.headers.location ?? "").startsWith(BOOTSTRAP_PATH);
  const rawJson = cold.status === 401 && coldType.includes("application/json");
  check(
    bootstraps
      ? "cold navigation bootstraps a session (upstream fix present)"
      : "cold navigation answers raw 401 JSON (known wart on this build)",
    bootstraps || rawJson,
    `status ${cold.status}, type ${coldType}, location ${cold.headers.location}`,
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
