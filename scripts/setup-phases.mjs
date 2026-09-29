// The first-run setup phases, their postconditions, and the progress record.
//
// Shared by `scripts/bootstrap.mjs`, which runs the phases, and by
// `scripts/start-codeyam.mjs`, which refuses to start when one is incomplete
// and says which. Keeping the postconditions in one place is what lets Run and
// setup agree about what "set up" means.
//
// Every postcondition is re-checked against the workspace itself. The progress
// file is a record of what happened, never evidence that it did: a stale or
// partial record must not let a phase be skipped.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";

export const EDITOR_PACKAGE = "@codeyam-editor/codeyam-editor";

/// At the repo root rather than under `.codeyam/`, because the first phase
/// runs before the editor has created that directory. Gitignored.
export const PROGRESS_FILE = ".codeyam-setup.json";

/// The `.replit` workflow that runs `npm run bootstrap`. Named in every
/// failure message, so it lives here with them.
export const SETUP_WORKFLOW = "Set up CodeYam";

export const PHASES = ["install-editor", "init", "verify"];

/// Put the workspace's own `node_modules/.bin` first on PATH. `npm run` does
/// this already; the top-level `entrypoint` and a bare `node scripts/...` in
/// the Shell do not, and without it they would find a globally installed
/// editor -- or none -- instead of the one this workspace depends on.
export function withLocalBin(env, root) {
  const bin = join(root, "node_modules", ".bin");
  return { ...env, PATH: `${bin}${delimiter}${env.PATH ?? ""}` };
}

/// `install-editor` is done when the package resolves from the workspace AND
/// its binary runs. Resolution alone passes on a half-extracted install whose
/// postinstall never fetched the native binary; the binary alone passes on a
/// global install this workspace does not own.
export function checkEditorInstalled(root, env) {
  try {
    createRequire(join(root, "package.json")).resolve(
      `${EDITOR_PACKAGE}/package.json`,
    );
  } catch {
    return { ok: false, detail: `${EDITOR_PACKAGE} is not installed` };
  }
  const version = spawnSync("codeyam-editor", ["--version"], {
    encoding: "utf8",
    env: withLocalBin(env, root),
  });
  if (version.error) {
    return {
      ok: false,
      detail: `codeyam-editor --version could not run (${version.error.message})`,
    };
  }
  if (version.status !== 0) {
    const output = `${version.stderr ?? ""}${version.stdout ?? ""}`.trim();
    return {
      ok: false,
      detail: `codeyam-editor --version exited ${version.status}${output ? `: ${output}` : ""}`,
    };
  }
  return { ok: true, version: (version.stdout ?? "").trim() };
}

/// `init` is done when the editor's project configuration exists.
export function checkInitialized(root) {
  return existsSync(join(root, ".codeyam", "editor.json"))
    ? { ok: true }
    : { ok: false, detail: ".codeyam/editor.json does not exist" };
}

/// The one failure sentence: which phase, why, and what to do about it.
export function phaseMessage(phase, detail) {
  return (
    `Setup phase "${phase}" not complete: ${detail}. ` +
    `Run the "${SETUP_WORKFLOW}" workflow (or \`npm run bootstrap\` in the Shell), ` +
    `then press Run.`
  );
}

/// The progress record, or an empty one when it is missing or unreadable. An
/// unreadable record is not an error: nothing trusts it, so nothing is lost.
export function readProgress(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, PROGRESS_FILE), "utf8"));
    return parsed && typeof parsed.phases === "object" ? parsed : { phases: {} };
  } catch {
    return { phases: {} };
  }
}

/// Record one phase's outcome. Written to a temp file and renamed, so a setup
/// killed mid-write leaves the previous record rather than a truncated one.
export function recordPhase(root, phase, status, detail) {
  const progress = readProgress(root);
  progress.phases[phase] = {
    status,
    at: new Date().toISOString(),
    ...(detail ? { detail } : {}),
  };
  progress.updatedAt = progress.phases[phase].at;
  const path = join(root, PROGRESS_FILE);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(progress, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}
