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

For a self-hosted/dev API: `export MDPUBS_API_URL=http://localhost:1323` (default is `https://mdpubs.com/api`).

## Commands

```bash
mdpubs publish <file> [--private] [--title T] [--tags a,b] [--json]
mdpubs list [--json]
mdpubs open <id|file> [--json]
mdpubs delete <id|file> [--json]
mdpubs sign status <id|file> [--json]
mdpubs sign clear <id|file> (--slot N | --all) --reason "…" [--json]
mdpubs whoami [--json]
mdpubs login --api-key <key> [--api-url <url>]
```

### sign

```bash
mdpubs sign status loe.md
# abc123: 1/2 signed, sequential
#   [0] Shawn — signed 2026-10-07 09:12 UTC
#   [1] Rohas Tecnic — waiting (their turn)

mdpubs sign clear loe.md --slot 1 --reason "Signed in the wrong box"
```

`clear --slot N` voids one signature so that slot can sign again; the doc stays
locked. `clear --all` voids every signature and unlocks the doc for edits. The
reason is recorded in the audit trail. Only the note's author or an owner/admin
of its org can clear.

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
- `--private` creates/keeps the pub private (only the logged-in owner can view it). You can also declare privacy in the file: `mdpubs-is-private: true` in markdown frontmatter, or `<!-- mdpubs-is-private: true -->` in HTML. The `--private`/`--public` flag overrides the in-file marker.

### Local assets ride along

Any local file the pub references is uploaded automatically:

- Markdown: `![](logo.png)`, `[pdf](file.pdf)`
- HTML: `src="logo.png"`, `href="style.css"`

Remote references (`https://`, `//`, `data:`, Google Fonts, etc.) are left as-is. Only paths that exist on disk relative to the pub file are uploaded.

### Signing documents (e-signatures)

Turn a markdown or HTML pub into a signable document — no DocuSign, no account for signers. Both formats are fully supported; declare it in the file:

```yaml
# Markdown — in the frontmatter block
mdpubs-sign: true
mdpubs-signers:
  - Alice <alice@co.com>
mdpubs-signers-open:
  - Acme Corp (authorised signatory)
mdpubs-sign-order: sequential   # sequential (default) | parallel
```

```html
<!-- HTML — comments near the top -->
<!-- mdpubs-sign: true -->
<!-- mdpubs-signer: Alice <alice@co.com> -->
<!-- mdpubs-signer-open: Acme Corp (authorised signatory) -->
<!-- mdpubs-sign-order: sequential -->   <!-- sequential (default) | parallel -->
```

Publish it and share the link. The public page shows a **Sign** button and draws-to-sign in the browser. There are two kinds of signer:

- **Fixed** — `mdpubs-signers:` / `<!-- mdpubs-signer: ... -->`. Written three ways: `Name <email>` pre-fills the email; a bare `email` uses it as the name too; a bare `Name` locks the name and lets the signer supply their own email at signing time (slots are identified by position, not email).
- **Open** — `mdpubs-signers-open:` / `<!-- mdpubs-signer-open: Label -->`. Use when you **don't know** the exact person or email (e.g. "the other firm's authorised signatory"). Whoever holds the link fills the slot with **their own** name + email, both of which are recorded on the signature.

**Custom fields**: name, email, and signed date are captured automatically. To collect more (e.g. a title), declare fields — every signer fills them in and they're stored with the signature and shown in the signed document:

```html
<!-- HTML -->
<!-- mdpubs-signer-field: Title -->
<!-- mdpubs-signer-field: Company -->
```
```yaml
# Markdown frontmatter
mdpubs-signer-fields:
  - Title
  - Company
```

- **Order**: `sequential` (default) requires signers to sign in the listed order; `parallel` lets anyone sign anytime.
- **Where signatures appear**: by default the signing UI is a floating button. To place a signing box **inline at the exact spot** in the document, drop an anchor where you want it:

  ```html
  <!-- mdpubs-sign-here: Alice -->                     <!-- matches a signer by name -->
  <!-- mdpubs-sign-here: Acme Corp (authorised signatory) -->  <!-- an open slot's label -->
  ```

  The label ties the box to a signer (by name, or the open-slot label; falls back to anchor order). The anchor only marks *where* the box renders — signatures are stored against the document, **never written into its content**, so adding a signature never changes the signed hash (which would break earlier signatures). That's why placement uses an anchor rather than embedding the signature itself.
- **Tamper-evident**: each signature binds to a SHA-256 of the exact signed content. On the **first** signature the pub **locks** — later edits that change the signed body are rejected (`409`). Duplicate the pub to make a new version.
- **Audit trail**: every view, signature, and completion is recorded (timestamp + IP). Download the signed document as a PDF from the pub's floating controls.

`mdpubs publish` prints the detected signers, order, and fields for a signable pub, and warns when a signer has no matching `mdpubs-sign-here` anchor (or an anchor matches no signer) — a typo between the two otherwise drops that slot's inline box silently.

## Agent usage (`--json`)

Every command supports `--json` for deterministic parsing:

```bash
mdpubs publish report.html --json
# {"id":"y561oMTXUlCWUnE9-snyD","url":"https://mdpubs.com/y561oMTXUlCWUnE9-snyD",
#  "action":"created","assets":2,
#  "sign":{"enabled":true,"signers":["Alice <alice@co.com>","Acme Corp (open)"],
#          "order":"parallel","fields":["Title?"],
#          "anchors":["Alice","Acme Corp"],
#          "unanchoredSigners":[],"orphanAnchors":[]}}
```

Exit codes: `0` ok, `1` generic/usage error, `2` auth failed, `3` forbidden (e.g. plan limit), `4` not found. Errors go to stderr.

## How HTML pubs render

HTML pubs are served by the API at `/notes/:id/raw` with a strict Content-Security-Policy and rendered inside a **sandboxed iframe** on the public page (no script execution, isolated from the mdpubs origin). Static documents (fonts + CSS, like a rendered contract) render faithfully; arbitrary JS does not run. This is intentional for safety.

## Note for generated HTML (e.g. cgpt-docs render.py)

If your HTML is produced by a generator that overwrites the file, make the generator **preserve an existing `<!-- mdpubs: ID -->` line** across renders, otherwise the id is lost and `publish` will create a new pub each time.
