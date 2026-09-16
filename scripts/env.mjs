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
  };
}
