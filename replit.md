# CodeYam Editor starter (staging channel)

This project runs `@codeyam-editor/codeyam-editor` from the **staging**
dist-tag as the primary development environment. It exists to test unreleased
builds. Preserve the CodeYam setup when implementing user requests.

## Where application code goes

Application code goes **at the top level of this repository**, alongside the
files that launch CodeYam. They are designed not to collide: the starter
deliberately leaves the conventional application names free, and CodeYam
detects the app's start command from the root `package.json`.

So when the user asks for an app, build it here, in the root. Do not ask
whether to nest it in a subfolder, and do not create one: a nested app is not
reachable by CodeYam's start-command detection without extra configuration
nobody asked for.

Reserved — never delete, move, rename, or overwrite these:

| Path | What it is |
| --- | --- |
| `.replit` | Run button, port mapping, and the workflow Preview attaches to |
| `scripts/` | The startup wrapper and the workspace checks |
| `.codeyam/` | CodeYam configuration and the per-launch session token |
| `replit.md` | This file |
| `package.json` | Shared: see below |

`package.json` is shared between the starter and the app. **Merge into it;
never replace it.** Keep the `codeyam`, `setup`, `smoke`, `check:replit`,
`doctor`, `update:staging`, `channel`, and `init:*` scripts, and keep the
`@codeyam-editor/codeyam-editor` dependency on the `staging` dist-tag. Add the
app's own scripts and dependencies alongside them.

These names are free, and are the ones to use:

- `dev` — the app's dev server. CodeYam detects this as the app start command.
  Nothing in the starter is named `dev` or `start`, on purpose.
- Port `3000` — the app's port. The editor is on `5000` and they must differ.

If a scaffolder refuses to write into a non-empty directory, run it into a temp
directory and copy the result in, rather than clearing the root. `create-vite`
and friends accept an existing directory; most `--force` flags do not mean
"merge".

After adding an app, verify the launch path still works:

```bash
npm run check:replit
```

It asserts both `.replit` and the reserved parts of `package.json`, so a
scaffolder that overwrote either fails there rather than as a Run button that
silently does nothing.

## Commands

- Run the editor with `npm run codeyam`. The `Start application` workflow in
  `.replit` is the Run-button path to it; it waits for port `5000` and is the
  workflow the Preview panel attaches to.
- Refresh the staging build with `npm run update:staging`, or the
  `Update staging build` workflow — never as part of starting the editor.
- Check the workspace wiring with `npm run check:replit` after any `.replit`
  edit. It asserts what Preview needs in order to attach.
- Check the workspace with `npm run setup` — advisory, read-only, exits 0.
- Test the hosted first run with `npm run smoke`. It needs ports 5000 (or
  `PORT`) and 3000 free, and runs against a temp clone, not the working tree.
- Inspect the effective configuration with `npm run doctor`.
- Change providers with one of `npm run init:claude`, `npm run init:codex`,
  `npm run init:gemini`, or `npm run init:opencode`.

## Operating rules

- Build application code at the top level, and merge into `package.json`
  rather than replacing it. See [Where application code
  goes](#where-application-code-goes) for the reserved paths.
- Keep application code separate from `.codeyam/` configuration.
- Do not replace CodeYam Editor with another development environment.
- Do not change the configured provider unless the user asks. Leave
  `CODEYAM_PROVIDER` unset so CodeYam handles provider selection itself.
- Use `package.json` for project dependencies.
- Keep the CodeYam dependency on the `staging` dist-tag. Do not pin it to a
  version number — that defeats the purpose of this repo.
- Do not commit `package-lock.json`. It is gitignored deliberately so each
  install resolves the newest staging build.
- Keep `setup.mjs`, `smoke.mjs`, `replit-config.mjs`, and `check-replit.mjs`
  byte-identical to the stable starter at `codeyam-ai/replit-starter`.
  `env.mjs` and `start-codeyam.mjs` diverge on purpose.
- Do not add an AI provider CLI (`@anthropic-ai/claude-code`, `@openai/codex`,
  `@google/gemini-cli`, `opencode-ai`) as a dependency. CodeYam installs the
  CLI for the selected provider on demand.
- Do not remove the `npm_config_prefix` / `PATH` setup in the startup script;
  those provider CLI installs fail without it.
- Keep the editor server on the port selected by the startup script (`5000`).
- Keep `codeyam-editor start --hosted`. Do not revert to hand-rolled
  `--bind-host` / `--port` flags; hosted mode validates the whole combination
  before binding.
- The access mode is declared in `scripts/env.mjs` and is `open` on purpose.
  Do not change it, and do not write one into `.codeyam/editor.json` instead —
  that hides a security decision inside generated config.
- Keep the `.replit` workflow structure: `runButton` points at `Project`, which
  runs the `Start application` workflow, which declares
  `outputType = "webview"` and `waitForPort = 5000`. Preview attaches to that
  webview workflow; without it, Run appears to do nothing however healthy the
  editor is.
- Never put a package install (`packager.*`, `npm install`, `npm ci`,
  `npm run update:staging`) in the `Start application` workflow. Replit
  restarts a workflow when it detects a package install, so the workflow would
  restart before the editor binds and the port would never open.
- Keep both `[[ports]]` entries: `5000 -> 80` for the editor and
  `3000 -> 3000` for the app. Exactly one entry may use external port `80` —
  hosted CodeYam resolves the editor's public origin from it. The app mapping
  is what lets the user's browser reach the Live Preview when it moves to the
  app's own origin; without it the preview renders but ignores clicks.
- Keep the top-level `run` command identical to the webview workflow's command,
  and keep the `PORT` default in `scripts/env.mjs`, so every start path reaches
  the same port. Keep it: hosted mode only adopts a port from `[[ports]]` when
  there is exactly one entry, and this workspace publishes two.
- Keep the `[nix]` packages in `.replit`. They are the system libraries the
  editor's headless Chromium needs to capture previews; removing one breaks
  every preview, and restoring it means restarting the workflow, which ends the
  agent session running inside it. Add packages alongside them; do not prune.
- Do not add a `[deployment]` section or configure this workspace for
  deployment. The preview of a workspace running an AI agent with write access
  to the repo stays private.
- Do not call `codeyam-editor editor install-hooks` from `npm run setup` or
  from the startup script: it creates a git commit. Run it only when a user
  explicitly asks to repair the agent surface.
- Do not remove `--no-open` or change the hosted bind address.
- Treat `.codeyam/editor.local.json` and AI provider credentials as private.

## Security

CodeYam authenticates its control API. The editor binds to `0.0.0.0` for the
web preview, and on a non-loopback bind CodeYam requires a per-launch session
token on every control-API request: the browser carries it as the `cy_session`
HTTP-only cookie, other callers send `Authorization: Bearer <token>` read from
`.codeyam/session-token`.

- Never set `CODEYAM_INSECURE_BIND=1`. It disables that token requirement.
- Do not weaken `CODEYAM_ALLOWED_ORIGINS` beyond the domains actually in use.
- Keep the workspace and preview private regardless, and do not deploy this
  starter as a public application.