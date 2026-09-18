# CodeYam Editor starter (staging channel)

This project runs `@codeyam-editor/codeyam-editor` from the **staging**
dist-tag as the primary development environment. It exists to test unreleased
builds. Preserve the CodeYam setup when implementing user requests.

## Commands

- Run the editor with `npm run codeyam`. The `CodeYam Editor` workflow in
  `.replit` is the single supported way to start it, and it waits for port
  `5000`.
- Check the workspace with `npm run setup` — advisory, read-only, exits 0.
- Test the hosted first run with `npm run smoke`. It needs ports 5000 (or
  `PORT`) and 3000 free, and runs against a temp clone, not the working tree.
- Inspect the effective configuration with `npm run doctor`.
- Change providers with one of `npm run init:claude`, `npm run init:codex`,
  `npm run init:gemini`, or `npm run init:opencode`.

## Operating rules

- Keep application code separate from `.codeyam/` configuration.
- Do not replace CodeYam Editor with another development environment.
- Do not change the configured provider unless the user asks. Leave
  `CODEYAM_PROVIDER` unset so CodeYam handles provider selection itself.
- Use `package.json` for project dependencies.
- Keep the CodeYam dependency on the `staging` dist-tag. Do not pin it to a
  version number — that defeats the purpose of this repo.
- Do not commit `package-lock.json`. It is gitignored deliberately so each
  install resolves the newest staging build.
- Keep `scripts/` byte-identical to the stable starter at
  `codeyam-ai/replit-starter`; put differences in `package.json` / `.replit`.
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
- Do not add a second workflow or change the run button target.
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