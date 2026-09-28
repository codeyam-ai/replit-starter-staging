// Assertions over the committed workspace configuration: `.replit`, and the
// parts of `package.json` the launch path depends on.
//
// Every check here exists because a real import failed on it. The editor can
// be perfectly healthy -- serving, authenticated, answering 200 -- while the
// Preview panel still says "Your app is not running", because the workspace is
// wired so that Preview has nothing to attach to. `npm run smoke` proves the
// editor works; this proves the workspace is configured to reach it.
//
// Deliberately written against `.replit`'s own declarations rather than against
// a `PORT=` in a command string: hosted mode is moving toward resolving its
// port from the published `[[ports]]` entry, and these assertions have to
// survive that.

/// A deliberately small TOML reader: enough for `.replit`'s shape (top-level
/// keys, `[table]`, `[[array of tables]]`, strings, integers, booleans, and
/// single-line arrays of strings). Not a general TOML parser, and not trying to
/// be -- a dependency is not worth it for one file we also write ourselves.
export function parseReplit(text) {
  const root = {};
  let current = root;

  for (const raw of text.split("\n")) {
    const line = stripComment(raw).trim();
    if (!line) continue;

    if (line.startsWith("[[") && line.endsWith("]]")) {
      current = pushArrayTable(root, line.slice(2, -2).trim());
    } else if (line.startsWith("[") && line.endsWith("]")) {
      current = table(root, line.slice(1, -1).trim());
    } else {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      current[line.slice(0, eq).trim()] = parseValue(line.slice(eq + 1).trim());
    }
  }

  return root;
}

function stripComment(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === "#" && !quoted) return line.slice(0, i);
  }
  return line;
}

/// Walk a dotted header path, creating tables as needed. An array of tables on
/// the way down resolves to its LAST element, which is what makes
/// `[workflows.workflow.metadata]` attach to the workflow most recently opened
/// with `[[workflows.workflow]]` -- the shape Replit's own files use.
function descend(root, parts) {
  let cur = root;
  for (const part of parts) {
    if (cur[part] === undefined) cur[part] = {};
    cur = Array.isArray(cur[part]) ? cur[part][cur[part].length - 1] : cur[part];
  }
  return cur;
}

function table(root, name) {
  return descend(root, name.split("."));
}

function pushArrayTable(root, name) {
  const parts = name.split(".");
  const key = parts.pop();
  const parent = descend(root, parts);
  if (!Array.isArray(parent[key])) parent[key] = [];
  const entry = {};
  parent[key].push(entry);
  return entry;
}

function parseValue(raw) {
  if (raw.startsWith('"')) return raw.slice(1, raw.lastIndexOf('"'));
  if (raw === "true" || raw === "false") return raw === "true";
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map(parseValue);
  }
  return raw;
}

/// Anything that installs packages. Replit restarts a workflow when it detects
/// a package-install change, so an install inside the long-running web workflow
/// restarts the workflow before it ever reaches the editor start -- the
/// workflow loops, and Replit eventually reports the port was never opened.
const INSTALL_COMMAND =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:ci\b|install\b|add\b)|\bnpm\s+run\s+update:/;

const isInstallTask = (task) =>
  String(task.task ?? "").startsWith("packager.") ||
  INSTALL_COMMAND.test(String(task.args ?? ""));

/// Checks the committed `.replit` against everything a fresh import needs in
/// order to reach CodeYam in the Preview panel. Returns `{name, ok, detail}`
/// rows so callers can render them however they already render checks.
export function checkReplitConfig(text) {
  const config = parseReplit(text);
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });

  // 1. Exactly one published port. Hosted mode resolves its public origin from
  // these mappings: two entries are ambiguous and upstream refuses to guess,
  // none means the editor can bind a port nothing routes to.
  const ports = Array.isArray(config.ports) ? config.ports : [];
  const onePort = ports.length === 1;
  check(
    "exactly one [[ports]] entry",
    onePort,
    `found ${ports.length}: ${ports.map((p) => p.localPort).join(", ") || "(none)"}`,
  );
  const localPort = onePort ? ports[0].localPort : undefined;
  check(
    "the published port maps to an external port",
    onePort && Number.isInteger(localPort) && Boolean(ports[0].externalPort),
    JSON.stringify(ports[0] ?? null),
  );

  const workflows = Array.isArray(config.workflows?.workflow)
    ? config.workflows.workflow
    : [];
  const byName = new Map(workflows.map((w) => [w.name, w]));
  const tasks = (w) => (Array.isArray(w?.tasks) ? w.tasks : []);

  // 2. Preview attaches to a webview workflow, and the Run button reaches it.
  // Without `outputType = "webview"` there is nothing for Preview to bind to,
  // however healthy the editor is.
  const webWorkflows = workflows.filter(
    (w) => w.metadata?.outputType === "webview",
  );
  check(
    'exactly one workflow declares outputType = "webview"',
    webWorkflows.length === 1,
    `found ${webWorkflows.length}`,
  );
  const web = webWorkflows[0];

  const runButton = config.workflows?.runButton;
  const target = byName.get(runButton);
  check(
    "the run button names a defined workflow",
    Boolean(target),
    `runButton = ${JSON.stringify(runButton ?? null)}`,
  );

  const reaches = (from, seen = new Set()) => {
    if (!from || seen.has(from.name)) return false;
    seen.add(from.name);
    if (from === web) return true;
    return tasks(from).some(
      (t) => t.task === "workflow.run" && reaches(byName.get(t.args), seen),
    );
  };
  check(
    "the run button reaches the webview workflow",
    Boolean(web) && reaches(target),
    `${JSON.stringify(runButton ?? null)} does not run the webview workflow`,
  );

  // Checks 3 and 4 describe the long-running workflow. When no webview
  // workflow exists at all -- the shape that broke the first imports -- they
  // fall back to whatever the Run button actually starts, so the report names
  // every problem in one pass instead of one per fix.
  const longRunning = web ?? target;

  // 3. The web workflow waits for the port that is actually published. This is
  // the assertion that catches startup paths disagreeing about the port.
  const starts = tasks(longRunning).filter((t) => t.task === "shell.exec");
  const waits = starts.map((t) => t.waitForPort).filter((p) => p !== undefined);
  check(
    "the webview workflow waits for the published port",
    waits.length === 1 && waits[0] === localPort,
    `waitForPort ${JSON.stringify(waits)} vs [[ports]] localPort ${localPort}`,
  );

  // 4. No package installation in the long-running web workflow.
  const installs = tasks(longRunning).filter(isInstallTask);
  check(
    "no package installation in the webview workflow",
    installs.length === 0,
    installs.map((t) => t.args ?? t.task).join("; "),
  );

  // 5. Every supported start path runs the same command. The top-level `run`
  // is a real entry point -- Replit uses it when no workflow is selected -- and
  // when it differs from the workflow's command the two reach different ports,
  // so Run looks like it does nothing.
  check(
    "the top-level run command matches the webview workflow's",
    starts.length === 1 && config.run === starts[0].args,
    `run = ${JSON.stringify(config.run ?? null)}, workflow = ${JSON.stringify(starts[0]?.args ?? null)}`,
  );

  // 6. Not configured for public deployment. The preview of a workspace running
  // an AI coding agent with write access to the repo stays private.
  check(
    "no deployment configuration",
    config.deployment === undefined,
    "this starter must not be deployed as a public application",
  );

  return results;
}

/// AI provider CLIs. CodeYam installs the one for the selected provider on
/// demand; depending on any of them here pins a provider the user did not
/// choose and pays for an install the workspace may never use.
const PROVIDER_CLIS = [
  "@anthropic-ai/claude-code",
  "@openai/codex",
  "@google/gemini-cli",
  "opencode-ai",
];

/// Checks the committed `package.json` against the parts the launch path
/// depends on. This exists because `package.json` is the one file shared
/// between the starter and the application built on top of it: a scaffolder
/// that writes its own `package.json` over ours removes `npm run codeyam`, and
/// the only symptom is a Run button that appears to do nothing. Same
/// `{name, ok, detail}` rows as `checkReplitConfig`.
export function checkStarterPackage(text) {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });

  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (error) {
    check("package.json parses", false, error.message);
    return results;
  }

  const scripts = pkg.scripts ?? {};

  // 1. The launcher the `.replit` workflow calls. Without it Run resolves to
  // nothing, whatever `.replit` says.
  check(
    "the codeyam script runs the startup wrapper",
    /start-codeyam\.mjs/.test(String(scripts.codeyam ?? "")),
    `codeyam = ${JSON.stringify(scripts.codeyam ?? null)}`,
  );

  // 2. The workspace checks themselves, plus provider switching. Losing these
  // is recoverable, but silently: the next `.replit` mistake goes uncaught.
  const required = ["setup", "smoke", "check:replit", "doctor"];
  const missing = required.filter((name) => !scripts[name]);
  check(
    "the starter scripts are intact",
    missing.length === 0,
    `missing: ${missing.join(", ")}`,
  );

  // 3. The editor dependency.
  check(
    "the editor is a dependency",
    Boolean(pkg.dependencies?.["@codeyam-editor/codeyam-editor"]),
    "@codeyam-editor/codeyam-editor is missing from dependencies",
  );

  // 4. `dev` and `start` belong to the application, and CodeYam reads them as
  // the app start command. Pointing either at the editor makes the editor
  // launch the editor.
  const recursive = ["dev", "start"].filter((name) =>
    /start-codeyam\.mjs|codeyam-editor\s+start|npm\s+run\s+codeyam/.test(
      String(scripts[name] ?? ""),
    ),
  );
  check(
    "no start script launches the editor recursively",
    recursive.length === 0,
    recursive.map((name) => `${name} = ${scripts[name]}`).join("; "),
  );

  // 5. No AI provider CLI pinned as a dependency.
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const pinned = PROVIDER_CLIS.filter((name) => deps[name]);
  check(
    "no AI provider CLI is a dependency",
    pinned.length === 0,
    `${pinned.join(", ")} — CodeYam installs the selected provider on demand`,
  );

  return results;
}
