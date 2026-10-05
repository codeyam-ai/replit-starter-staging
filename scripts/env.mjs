import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const supportedProviders = new Set([
  "claude",
  "codex",
  "gemini",
  "opencode",
]);

/// Unset means "let CodeYam decide": the CLI resolves its own default today and
/// will honour an in-editor provider choice once that lands. The starter only
/// forces a provider when the workspace explicitly asks for one.
export const provider = process.env.CODEYAM_PROVIDER;

export const port =
  process.env.PORT || process.env.CODEYAM_EDITOR_PORT || "5000";

/// The access mode a hosted bind runs under. A non-loopback bind refuses to
/// issue a session until one is declared, so hosted mode requires this to be an
/// explicit, checked-in decision -- not something a setup agent improvises when
/// the editor refuses to boot.
///
/// `open` is what this starter declares. Upstream's own summary of it is "you
/// explicitly acknowledge that something outside the editor is the boundary",
/// and here that boundary is the privacy of the Replit workspace and its dev
/// URL. The two alternatives do not fit:
///
/// - `token` issues a session only from a validated `?cy_token=` exchange. The
///   cookie is `SameSite=Lax` with no `SameSite=None` option, and Replit's
///   webview is a cross-site iframe, so the embedded preview never carries it.
/// - `trusted-proxy` needs an upstream proxy that proves itself with a shared
///   secret header. Replit's preview is not one.
///
/// This is not weaker than the editor's pre-access-mode behavior: that already
/// handed a control-plane session to anyone who could reach it. Declaring
/// `open` makes the same posture explicit, and upstream logs it at startup.
/// It does mean anyone with the dev URL reaches a live agent with write access
/// to the repo, which is why the workspace must stay private.
export const accessMode = process.env.CODEYAM_EDITOR_ACCESS_MODE || "open";

export function providerError() {
  if (provider === undefined || supportedProviders.has(provider)) return null;
  return (
    `Unsupported CODEYAM_PROVIDER "${provider}". ` +
    `Choose one of: ${[...supportedProviders].join(", ")}, ` +
    `or leave it unset to let CodeYam choose.`
  );
}

export function portError() {
  if (/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535) {
    return null;
  }
  return `Invalid editor port "${port}".`;
}

/// CodeYam installs the selected provider's CLI itself, on first agent session,
/// via `npm install -g <package>`. That fails on a Nix-based host like Replit,
/// where npm's default global prefix lives in the read-only Nix store. Point the
/// prefix at a writable dir and put its bin on PATH so the install succeeds and
/// the resulting binary is then discoverable by the editor's PATH scan.
///
/// Deliberately provider-agnostic: this works for whichever CLI CodeYam decides
/// to install, so the starter never has to pin one.
export function childEnv() {
  const prefix =
    process.env.npm_config_prefix ||
    join(process.env.HOME || homedir(), ".npm-global");
  const bin = join(prefix, "bin");

  mkdirSync(bin, { recursive: true });

  return {
    ...process.env,
    npm_config_prefix: prefix,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    ...libraryPath(),
    // INTERIM. `start --hosted` resolves its port as
    // `--port` > CODEYAM_CONTROL_PORT > PORT > the sole published `.replit`
    // `[[ports]]` local port. Until that last step exists, a start path that
    // supplies no PORT -- the top-level `run` command, or a plain
    // `npm run codeyam` in the Shell -- falls back to a project-derived control
    // port that nothing routes to, and Preview waits on 5000 forever. Setting
    // it here, in the one place every start path passes through, keeps those
    // paths in agreement without duplicating `PORT=5000` across `.replit`.
    //
    // Delete this line once the editor adopts the published port itself; the
    // `[[ports]]` entry is what makes that work, and the assertions in
    // `scripts/replit-config.mjs` are written against `[[ports]]`, not against
    // this, so they survive the change.
    PORT: port,
    // Declared here rather than written into `.codeyam/editor.json` so the
    // decision survives a re-scaffold and stays visible in this repo, where it
    // can be reviewed, instead of inside generated config nobody reads.
    CODEYAM_EDITOR_ACCESS_MODE: accessMode,
  };
}

/// Replit exposes the libraries of the `.replit` `[nix]` packages through
/// REPLIT_LD_LIBRARY_PATH. The headless Chromium the editor launches for
/// previews is a Playwright download, not a Nix binary, so it may not see that
/// path on its own. Fold it into LD_LIBRARY_PATH for the editor and everything
/// it spawns, so a preview capture finds those libraries without anyone having
/// to work out why a `.so` is missing. A no-op off Replit.
function libraryPath() {
  const replit = process.env.REPLIT_LD_LIBRARY_PATH;
  if (!replit) return {};
  const current = process.env.LD_LIBRARY_PATH;
  return {
    LD_LIBRARY_PATH: current ? `${replit}${delimiter}${current}` : replit,
  };
}
