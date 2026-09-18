# CodeYam Editor on Replit — staging channel

This is the **staging** variant of
[`codeyam-ai/replit-starter`](https://github.com/codeyam-ai/replit-starter).
It runs unreleased `@codeyam-editor/codeyam-editor` builds so changes can be
tested in a real hosted workspace before they ship.

For normal use, use the stable starter instead. This one tracks a moving
target and will break when a staging build breaks — that is its job.

## How it differs from the stable starter

| | stable | staging (this repo) |
| --- | --- | --- |
| dependency | pinned version (`0.1.10`) | the `staging` dist-tag |
| `package-lock.json` | committed | **not** committed, deliberately |
| install | `npm ci`, reproducible | `npm install`, newest staging build |
| Run workflow | install, start | install, **refresh staging**, start |

Everything under `scripts/` is byte-identical to the stable starter. Keep it
that way: sync with `cp ../replit-starter/scripts/*.mjs scripts/` and let the
differences live in `package.json`, `.replit`, `.gitignore`, and this file.

## Access mode

Builds from 0.1.11-staging onward refuse to issue a session on a non-loopback
bind until an access mode is declared. This repo declares one, in
`scripts/env.mjs`, so the decision is reviewable here rather than improvised by
whatever agent hits the boot failure first:

```js
export const accessMode = process.env.CODEYAM_EDITOR_ACCESS_MODE || "open";
```

`open` means the editor issues a control-plane session to every visitor, and
upstream logs that at startup. The privacy of the Replit workspace and its dev
URL is the access boundary — **anyone with that URL reaches a live agent with
write access to this repo.** Keep it private.

The alternatives do not fit a Replit preview:

- `token` issues a session only from a validated `?cy_token=` exchange. The
  session cookie is `SameSite=Lax` with no `SameSite=None` option, and Replit's
  webview is a cross-site iframe, so the embedded preview never carries it.
- `trusted-proxy` needs an upstream proxy that proves itself with a shared
  secret header. Replit's preview is not one.

This is not weaker than the editor was before access modes existed: that
already handed a session to anyone who could reach it. Declaring `open` makes
the same posture explicit and logged.

Override for a one-off with `CODEYAM_EDITOR_ACCESS_MODE`.

## Hosted mode

The starter runs `codeyam-editor start --hosted`, upstream's supported entry
point for a hosted workspace. It reads the platform's `PORT`, binds the
external interface, skips the browser probe, serves the Live Preview
same-origin so only one port needs publishing, and validates the whole
combination *before* binding — exiting `2` with a `Next valid action:` line
rather than failing halfway up.

It replaces the hand-rolled `--no-open --bind-host 0.0.0.0 --port "$PORT"`
recipe this starter used to carry, which upstream names as the thing every
hosted template duplicates and gets subtly wrong in a different way.

## Which build am I running?

The startup banner prints it, and so does:

```bash
npm run channel
```

```
codeyam-editor 0.1.7
channel: staging
```

`channel: staging` confirms the workspace is on an unreleased build;
`channel: production` means it fell back to a released one.

## Getting the newest staging build

The Run workflow refreshes on every start. To pull a build mid-session:

```bash
npm run update:staging
```

Then restart the editor so the new binary is the one serving.

## Why no lockfile

A committed lockfile pins one exact staging build forever, which is precisely
what this repo must not do. `package-lock.json` is gitignored here. That means
installs are not reproducible — an intentional trade, and the reason this
variant is unsuitable for anything but testing.

## Check the workspace

```bash
npm run setup
```

Verifies Node, reports the effective port and provider, initializes
`.codeyam/editor.json` if it is missing, and runs CodeYam's health checks.
It is advisory: it reports and exits 0, so warnings on a fresh workspace (no
scenarios yet, no dev server running) do not look like failures.

Running it is optional — `npm run codeyam` initializes what it needs on its
own. It exists so setup state is inspectable without starting the editor.

It deliberately makes no git commits. If health reports the agent surface is
out of sync, repair it explicitly with:

```bash
npx codeyam-editor editor install-hooks
```

That command creates a commit, which is why `npm run setup` does not run it
for you.

## Smoke-test the hosted first run

```bash
npm run smoke          # defaults to port 5000
PORT=5177 npm run smoke # when 5000 is taken
```

Clones HEAD into a temp dir, runs `npm ci`, starts the editor on `0.0.0.0`, and
asserts the real first-run sequence: the `cy_session` cookie is issued
`HttpOnly` and matches `.codeyam/session-token`; a protected endpoint returns
401 without it and 200 with either the cookie or a bearer token; and
`/__codeyam_preview/` serves the editor's no-app surface as HTML.

It runs against a throwaway clone, never your working tree — starting the
editor scaffolds `.codeyam/`, rewrites `.gitignore`, and commits refreshed
tooling, none of which belongs in your checkout.

Two notes if it fails:

- It needs port `5000` (or `PORT`) **and** port `3000` free. The editor binds a
  reverse proxy on `3000` for the Live Preview; if it cannot, the preview
  answers `502` rather than the editor surface.
- On macOS, AirPlay Receiver holds port `5000` by default, so pass `PORT`.

## Start the editor

1. Create a private Replit project from this repository.
2. Click **Run**. The `CodeYam Editor` workflow installs dependencies, runs
   `npm run codeyam`, and waits for port `5000`.
3. Open the web preview.

The first run initializes CodeYam and lets you pick an AI coding provider. To
pin a provider ahead of that first run instead, set `CODEYAM_PROVIDER` to
`claude`, `codex`, `gemini`, or `opencode`.

## AI provider required

CodeYam orchestrates an AI coding CLI; it does not include an AI model or
provider subscription. The supported CLIs are:

- Claude Code
- Codex
- Gemini
- OpenCode

You do not need to install these yourself, and this starter deliberately does
not depend on any of them. CodeYam installs the CLI for the selected provider
on demand, the first time an agent session starts, with `npm install -g`. The
startup wrapper points npm's global prefix at `~/.npm-global` and adds it to
`PATH`, because npm's default global prefix is inside Replit's read-only Nix
store and an install there would fail.

You do still need to authenticate. The credentials belong to the selected
provider. Store API keys and tokens in Replit Secrets, never in source files.

To switch an initialized project explicitly, run one of:

```bash
npm run init:claude
npm run init:codex
npm run init:gemini
npm run init:opencode
```

## Configuration

The startup wrapper uses:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEYAM_PROVIDER` | unset | Pins the provider used during first initialization |
| `npm_config_prefix` | `~/.npm-global` | Writable prefix for provider CLI installs |
| `PORT` | `5000` | Editor port assigned by the hosted environment |
| `CODEYAM_EDITOR_PORT` | `5000` | Fallback when `PORT` is not set |

The editor uses port `5000`, the port Replit forwards to the web preview. It
does not collide with CodeYam's default application port, `3000`.

Leaving `CODEYAM_PROVIDER` unset is the intended path: CodeYam chooses the
provider itself, so the starter does not have to hardcode one. Provider
selection is only applied when `.codeyam/editor.json` does not yet exist, which
prevents a restart from unexpectedly rewriting an existing project's setup.

The editor launcher intentionally is not named `dev` or `start`. CodeYam uses
those conventional package scripts to detect the application command, so using
one of them for the editor itself could create a recursive startup.

## Security status

CodeYam `0.1.10` authenticates its control API. The starter binds the editor to
`0.0.0.0` so the Replit web preview can reach it, and on any non-loopback bind
CodeYam requires a session token on every control-API request by default:

- The token is generated per launch and stored in `.codeyam/session-token`
  (mode `0600`).
- The browser UI carries it automatically as the `cy_session` HTTP-only cookie.
  No UI code is involved and nothing needs to be pasted.
- Non-browser callers — the CodeYam CLI, operator scripts, `curl` — must send
  `Authorization: Bearer <token>`, read from that file.
- A missing or wrong token is rejected with `401`. Requests from a foreign
  origin, or for a `Host` this editor does not serve, are rejected with `403`.

### What this does and does not stop

It stops an *unsolicited* call: a scanner or a drive-by `curl` that goes
straight at `/api/...` with no `Origin` header is refused, as is a cross-origin
page and a rebound `Host`.

It does not make the editor safe to expose. The cookie is issued by any HTML
response, with no authentication in front of it, so anyone who can reach the
editor can request `/`, receive a valid `cy_session`, and then use it. Verified
against 0.1.10 from another machine on the LAN: two requests, no credentials,
full control-API access.

So on Replit, keeping the workspace and its preview private is not
defense-in-depth on top of the token — it is the control that actually limits
who can reach a live agent with write access to your source. Treat the token as
protection against background internet noise, not against someone you gave the
URL to.

**Do not set `CODEYAM_INSECURE_BIND=1` in this starter.** That flag turns the
token requirement off on a non-loopback bind. It exists for operators who front
the editor with their own authenticating proxy, which Replit's preview is not.

Do not deploy this starter as a public application.

If you reach the editor through a tunnel or proxy, add that domain to
`CODEYAM_ALLOWED_ORIGINS` (comma-separated) or its requests are refused as an
unknown `Host`.

## Promoting a change to the stable starter

When a staging build is released, bump the pinned version in the stable
starter's `package.json`, regenerate its lockfile against the public registry,
and run its `npm run smoke` before pushing.