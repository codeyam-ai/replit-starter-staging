// `npm run bootstrap` -- first-run setup, in resumable phases.
//
// Runs from the `Set up CodeYam` workflow in `.replit`, never from the Run
// button. Replit restarts a workflow when it detects a package install, so an
// install inside the long-running `Start application` workflow restarts it
// before the editor binds and the port never opens. Here a restart is harmless:
// every phase re-checks its own postcondition first, so a re-run -- by Replit or
// by you -- resumes at the first phase that is not actually done.
//
//   install-editor  the editor package resolves and its binary runs
//   init            .codeyam/editor.json exists
//   verify          `health-status --editor-only` passes
//
// Signing in to a build agent and starting the app's dev server are NOT phases.
// Both happen inside the editor, and neither stops you reaching onboarding.
//
// No phase deletes or resets anything. Progress is recorded in
// `.codeyam-setup.json` for inspection only; nothing trusts it.
//
// `--stop-after <phase>` ends the run after that phase. It exists so the smoke
// test can interrupt setup at a known point without racing a kill signal.

import { spawnSync } from "node:child_process";
import { childEnv, provider, providerError } from "./env.mjs";
import {
  EDITOR_PACKAGE,
  PHASES,
  checkEditorInstalled,
  checkInitialized,
  phaseMessage,
  recordPhase,
  withLocalBin,
} from "./setup-phases.mjs";

const root = process.cwd();

const stopFlag = process.argv.indexOf("--stop-after");
const stopAfter = stopFlag === -1 ? undefined : process.argv[stopFlag + 1];
if (stopFlag !== -1 && !PHASES.includes(stopAfter)) {
  console.error(
    `--stop-after needs one of: ${PHASES.join(", ")} (got ${JSON.stringify(stopAfter ?? null)}).`,
  );
  process.exit(1);
}

const configError = providerError();
if (configError) {
  console.error(configError);
  process.exit(1);
}

const env = withLocalBin(childEnv(), root);

const editor = (args, stdio = "inherit") =>
  spawnSync("codeyam-editor", args, { encoding: "utf8", env, stdio });

/// A clap usage error on `--editor-only` means the installed editor predates
/// the flag. That is a version gap, not an unready editor.
const flagUnsupported = (result) =>
  /unexpected argument '--editor-only'/.test(
    `${result.stderr ?? ""}${result.stdout ?? ""}`,
  );

const phases = {
  "install-editor": {
    check: () => checkEditorInstalled(root, env),
    run: () => {
      console.log(`  Installing ${EDITOR_PACKAGE} (npm install)...`);
      // `install`, not `ci`: `ci` starts by deleting node_modules, and a phase
      // must never throw away work an interrupted run already did.
      spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
        stdio: "inherit",
        env,
      });
    },
  },
  init: {
    check: () => checkInitialized(root),
    run: () => {
      console.log(
        provider
          ? `  Initializing CodeYam Editor with the ${provider} provider...`
          : "  Initializing CodeYam Editor...",
      );
      editor(provider ? ["init", "--provider", provider] : ["init"]);
    },
  },
  // `verify` has no separate action: the check IS the work, so it always runs.
  verify: {
    check: () => {
      const result = editor(
        ["editor", "health-status", "--editor-only"],
        ["ignore", "pipe", "pipe"],
      );
      if (result.error) {
        return { ok: false, detail: `health-status could not run (${result.error.message})` };
      }
      if (flagUnsupported(result)) {
        return {
          ok: true,
          note: "this editor build predates `health-status --editor-only`; skipped",
        };
      }
      if (result.status === 0) return { ok: true };
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      for (const line of output.split("\n")) console.log(`        ${line}`);
      return { ok: false, detail: "the editor's readiness checks failed (see above)" };
    },
  },
};

console.log("\nCodeYam first-run setup");

for (const name of PHASES) {
  const phase = phases[name];
  let result = phase.run ? phase.check() : undefined;

  if (result?.ok) {
    console.log(`  ok    ${name} (already complete)`);
  } else {
    phase.run?.();
    result = phase.check();
    if (!result.ok) {
      recordPhase(root, name, "failed", result.detail);
      console.error(`\n${phaseMessage(name, result.detail)}\n`);
      process.exit(1);
    }
    console.log(`  ok    ${name}${result.note ? ` (${result.note})` : ""}`);
  }
  recordPhase(root, name, "done", result.note);

  if (name === stopAfter) {
    console.log(`\nStopped after "${name}" (--stop-after). Re-run to continue.\n`);
    process.exit(0);
  }
}

console.log(
  [
    "",
    "Setup complete. Press Run to open CodeYam.",
    "",
    "Still to do, inside the editor -- neither blocks reaching onboarding:",
    "  - choose a build agent and sign in to it",
    "  - start your app's dev server, once you have an app",
    "",
  ].join("\n"),
);
