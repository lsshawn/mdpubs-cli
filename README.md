# mdpubs-cli

Publish and update **Markdown or HTML** files to [mdpubs](https://mdpubs.com) from the command line. Built for both humans and AI agents (Claude Code / Hermes).

The key idea: **the file remembers its own pub id**, so publishing is idempotent. Run `publish` once to create, run it again to update the same pub. No state to track, no ids to remember.

## Install (users)

macOS and Linux, no sudo, no Bun required (ships as a standalone binary):

```bash
curl -fsSL https://raw.githubusercontent.com/lsshawn/mdpubs-cli/main/install.sh | sh
```

This installs `mdpubs` to `~/.local/bin`. If that's not on your PATH, the installer
tells you the line to add. Override the location with `MDPUBS_INSTALL_DIR=/usr/local/bin`.

Pin a version with `MDPUBS_VERSION=v0.1.0` before the curl command.

First run:

```bash
mdpubs login                 # paste your key from https://mdpubs.com/account
mdpubs publish report.html   # also prompts for the key on first use if not set
```

## Build from source (dev / maintainers)

Requires [Bun](https://bun.sh).

```bash
cd mdpubs-cli
bun run src/cli.ts <command>          # run directly
bun run build                         # standalone ./dist/mdpubs for this platform
bash scripts/build-all.sh             # all mac/linux binaries into dist/
```

### Cutting a release

Binaries are built and published by GitHub Actions on a version tag:

```bash
# bump "version" in package.json, then:
git tag v0.1.0 && git push origin v0.1.0
```

The `release` workflow builds all four binaries and attaches them to a GitHub
Release. `install.sh` always pulls the latest release.

## Auth

Get your API key from your mdpubs account, then either:

```bash
export MDPUBS_API_KEY=your_key          # env (best for agents/CI)
# or
mdpubs login --api-key your_key          # saves to ~/.config/mdpubs/config.json
# or pass --api-key on any command
```

For a self-hosted/dev API: `export MDPUBS_API_URL=http://localhost:1323` (default is `https://api.mdpubs.com`).

## Commands

```bash
mdpubs publish <file> [--private] [--title T] [--tags a,b] [--json]
mdpubs list [--json]
mdpubs open <id|file> [--json]
mdpubs delete <id|file> [--json]
mdpubs whoami [--json]
mdpubs login --api-key <key> [--api-url <url>]
```

### publish

```bash
mdpubs publish report.md
# Published: https://mdpubs.com/123  (0 assets, id written to file)

mdpubs publish report.md
# Updated: https://mdpubs.com/123  (0 assets)
```

- First run **creates** the pub and writes the id back into the file:
  - Markdown: `mdpubs: 123` in YAML frontmatter
  - HTML: `<!-- mdpubs: 123 -->` near the top (after `<!DOCTYPE>` if present)
- Subsequent runs **update** the same pub.
- `--title` overrides the auto-detected title (`<title>`/`# H1`/filename).
- `--private` creates/keeps the pub private.

### Local assets ride along

Any local file the pub references is uploaded automatically:

- Markdown: `![](logo.png)`, `[pdf](file.pdf)`
- HTML: `src="logo.png"`, `href="style.css"`

Remote references (`https://`, `//`, `data:`, Google Fonts, etc.) are left as-is. Only paths that exist on disk relative to the pub file are uploaded.

## Agent usage (`--json`)

Every command supports `--json` for deterministic parsing:

```bash
mdpubs publish report.html --json
# {"id":123,"url":"https://mdpubs.com/123","action":"created","assets":2}
```

Exit codes: `0` ok, `1` generic/usage error, `2` auth failed, `3` forbidden (e.g. plan limit), `4` not found. Errors go to stderr.

## How HTML pubs render

HTML pubs are served by the API at `/notes/:id/raw` with a strict Content-Security-Policy and rendered inside a **sandboxed iframe** on the public page (no script execution, isolated from the mdpubs origin). Static documents (fonts + CSS, like a rendered contract) render faithfully; arbitrary JS does not run. This is intentional for safety.

## Note for generated HTML (e.g. cgpt-docs render.py)

If your HTML is produced by a generator that overwrites the file, make the generator **preserve an existing `<!-- mdpubs: ID -->` line** across renders, otherwise the id is lost and `publish` will create a new pub each time.
