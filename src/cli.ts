#!/usr/bin/env bun
/**
 * mdpubs CLI — publish/update Markdown or HTML files to mdpubs.
 *
 * Designed to be friendly for both humans and AI agents (Claude Code / Hermes):
 *   - one command to publish or update, idempotent (the file remembers its id)
 *   - --json output for deterministic agent parsing
 *   - clear non-zero exits with messages on stderr
 *
 * Commands:
 *   mdpubs publish <file> [--private] [--title T] [--tags a,b] [--json]
 *   mdpubs list [--json]
 *   mdpubs open <id|file>
 *   mdpubs delete <id|file> [--json]
 *   mdpubs sign status|clear <id|file>
 *   mdpubs whoami [--json]
 *   mdpubs login [--api-key K] [--api-url U]
 */
import {basename} from 'path'
import {
	resolveConfig,
	saveApiKey,
	clearApiKey,
	apiKeyFromEnv,
	DEFAULT_API_URL,
	PUBLIC_BASE_URL,
	type CliConfig,
} from './config'
import {
	detectKind,
	fileExtensionFor,
	extractId,
	extractIsPrivate,
	stampId,
	detectSignConfig,
	type SignInfo,
} from './identity'
import {findLocalAssets} from './assets'
import {runLogin, ensureAuth} from './onboard'
import {
	createNote,
	updateNote,
	listNotes,
	deleteNote,
	getSignState,
	clearSignatures,
	ApiError,
	type NoteResponse,
	type SignState,
} from './api'

interface Flags {
	json: boolean
	private?: boolean
	title?: string
	tags?: string[]
	apiKey?: string
	apiUrl?: string
	noOpen?: boolean
	slot?: number
	all?: boolean
	reason?: string
	_: string[]
}

function parseArgs(argv: string[]): Flags {
	const f: Flags = {json: false, _: []}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--json') f.json = true
		else if (a === '--private') f.private = true
		else if (a === '--public') f.private = false
		else if (a === '--title') f.title = argv[++i]
		else if (a === '--tags') f.tags = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean)
		else if (a === '--api-key') f.apiKey = argv[++i]
		else if (a === '--api-url') f.apiUrl = argv[++i]
		else if (a === '--no-open') f.noOpen = true
		else if (a === '--slot') {
			const n = Number(argv[++i])
			if (!Number.isInteger(n) || n < 0) fail('--slot takes a signer index (0, 1, …)')
			f.slot = n
		} else if (a === '--all') f.all = true
		else if (a === '--reason') f.reason = argv[++i]
		else if (a.startsWith('--')) fail(`Unknown flag: ${a}`)
		else f._.push(a)
	}
	return f
}

function fail(msg: string, code = 1): never {
	process.stderr.write(`mdpubs: ${msg}\n`)
	process.exit(code)
}

function out(flags: Flags, human: string, json: Record<string, unknown>): void {
	if (flags.json) process.stdout.write(JSON.stringify(json) + '\n')
	else process.stdout.write(human + '\n')
}

function publicUrl(cfg: CliConfig, id: string | number): string {
	// Public viewer lives at mdpubs.com/<publicId>; derive from api host if non-default.
	// `id` must be the unguessable publicId — never the enumerable integer id.
	if (cfg.apiUrl === DEFAULT_API_URL) return `${PUBLIC_BASE_URL}/${id}`
	// Local/dev: drop a trailing /api (http://localhost:5173/api) or an api. host.
	const guess = cfg.apiUrl
		.replace(/\/+$/, '')
		.replace(/\/api$/, '')
		.replace('//api.', '//')
	return `${guess}/${id}`
}

function titleFromFile(path: string, content: string, kind: 'markdown' | 'html'): string {
	if (kind === 'html') {
		const t = content.match(/<title>([^<]+)<\/title>/i)
		if (t) return t[1].trim()
		const h1 = content.match(/<h1[^>]*>([^<]+)<\/h1>/i)
		if (h1) return h1[1].trim()
	} else {
		const h1 = content.match(/^#\s+(.+)$/m)
		if (h1) return h1[1].trim()
	}
	return basename(path).replace(/\.(md|markdown|html|htm)$/i, '')
}

async function cmdPublish(flags: Flags): Promise<void> {
	const path = flags._[0]
	if (!path) fail('Usage: mdpubs publish <file>')
	const file = Bun.file(path)
	if (!(await file.exists())) fail(`File not found: ${path}`)

	let cfg = await resolveConfig({apiKey: flags.apiKey, apiUrl: flags.apiUrl})
	cfg = await ensureAuthOrFail(cfg, flags)
	const content = await file.text()
	const kind = detectKind(path)
	const fileExtension = fileExtensionFor(path)
	const title = flags.title || titleFromFile(path, content, kind)
	const assets = await findLocalAssets(content, path, kind)

	const existingId = extractId(content, kind)
	// Privacy: --private/--public flag wins; otherwise honour the in-file marker
	// (HTML: <!-- mdpubs-is-private: true -->, markdown: mdpubs-is-private in
	// frontmatter); otherwise leave undefined (server default).
	const inFilePrivate = extractIsPrivate(content, kind)
	const isPrivate = flags.private !== undefined ? flags.private : inFilePrivate ?? undefined
	const common = {title, content, fileExtension, assets, isPrivate, tags: flags.tags}

	// Informational only: the server parses & enforces signing from content.
	const sign = detectSignConfig(content, kind)

	try {
		if (existingId) {
			const note = await updateNote(cfg, existingId, common)
			const pub = note.publicId ?? String(note.id)
			out(
				flags,
				`Updated: ${publicUrl(cfg, pub)}  (${assets.length} asset${assets.length === 1 ? '' : 's'})`,
				{id: pub, url: publicUrl(cfg, pub), action: 'updated', assets: assets.length, sign},
			)
			reportSign(flags, sign)
		} else {
			const note = await createNote(cfg, common)
			// Stamp the new publicId back into the file so the next publish updates in place.
			const pub = note.publicId ?? String(note.id)
			const stamped = stampId(content, kind, pub)
			if (stamped !== content) await Bun.write(path, stamped)
			out(
				flags,
				`Published: ${publicUrl(cfg, pub)}  (${assets.length} asset${assets.length === 1 ? '' : 's'}, id written to file)`,
				{id: pub, url: publicUrl(cfg, pub), action: 'created', assets: assets.length, sign},
			)
			reportSign(flags, sign)
		}
	} catch (e) {
		handleApiError(e)
	}
}

/**
 * Print a note that a pub is signable, who is on the signer list, and warn about
 * signer/anchor mismatches — a typo between the two silently drops that slot's
 * inline box, so it is worth flagging at publish time.
 */
function reportSign(flags: Flags, sign: SignInfo): void {
	if (flags.json || !sign.enabled) return
	const n = sign.signers.length
	process.stdout.write(
		`  ✎ Signable (${sign.order}) — ${n} signer${n === 1 ? '' : 's'}: ${sign.signers.join(', ')}\n`,
	)
	if (sign.fields.length) {
		process.stdout.write(`    fields: ${sign.fields.join(', ')}\n`)
	}
	for (const s of sign.unanchoredSigners) {
		process.stderr.write(
			`    ! no <!-- mdpubs-sign-here: ${s} --> anchor; their box falls back to the floating panel\n`,
		)
	}
	for (const a of sign.orphanAnchors) {
		process.stderr.write(`    ! anchor "${a}" matches no declared signer\n`)
	}
}

async function cmdList(flags: Flags): Promise<void> {
	let cfg = await resolveConfig({apiKey: flags.apiKey, apiUrl: flags.apiUrl})
	cfg = await ensureAuthOrFail(cfg, flags)
	try {
		const notes = await listNotes(cfg)
		if (flags.json) {
			out(flags, '', {
				notes: notes.map((n) => ({
					id: n.publicId ?? String(n.id),
					title: n.title,
					url: publicUrl(cfg, n.publicId ?? n.id),
					updatedAt: n.updatedAt,
				})),
			} as any)
			return
		}
		if (!notes.length) {
			process.stdout.write('No pubs yet.\n')
			return
		}
		for (const n of notes) {
			const pub = n.publicId ?? String(n.id)
			process.stdout.write(`${pub.padStart(12)}  ${n.title || '(untitled)'}  ${publicUrl(cfg, pub)}\n`)
		}
	} catch (e) {
		handleApiError(e)
	}
}

async function resolveId(flags: Flags, arg: string): Promise<string> {
	// An arg that isn't a path is taken as an id directly: either a publicId
	// (nanoid) or a legacy integer id — the API accepts both during transition.
	const file = Bun.file(arg)
	if (!(await file.exists())) return arg
	// Otherwise it's a file: read its embedded id.
	const content = await file.text()
	const id = extractId(content, detectKind(arg))
	if (!id) fail(`File has no mdpubs id yet (publish it first): ${arg}`)
	return id
}

async function cmdOpen(flags: Flags): Promise<void> {
	const arg = flags._[0]
	if (!arg) fail('Usage: mdpubs open <id|file>')
	const cfg = await resolveConfig({apiKey: flags.apiKey, apiUrl: flags.apiUrl})
	const id = await resolveId(flags, arg)
	const url = publicUrl(cfg, id)
	out(flags, url, {id, url})
}

async function cmdDelete(flags: Flags): Promise<void> {
	const arg = flags._[0]
	if (!arg) fail('Usage: mdpubs delete <id|file>')
	const cfg = await resolveConfig({apiKey: flags.apiKey, apiUrl: flags.apiUrl})
	const id = await resolveId(flags, arg)
	try {
		await deleteNote(cfg, id)
		out(flags, `Deleted ${id}`, {id, action: 'deleted'})
	} catch (e) {
		handleApiError(e)
	}
}

function signerLine(s: SignState['signers'][number]): string {
	const who = s.email ? `${s.name} <${s.email}>` : s.name
	const status = s.signed
		? `signed ${new Date(s.signedAt!).toISOString().slice(0, 16).replace('T', ' ')} UTC`
		: s.isTurn
			? 'waiting (their turn)'
			: 'waiting'
	return `  [${s.index}] ${who}${s.open ? ' (open slot)' : ''} — ${status}`
}

/** `mdpubs sign status|clear <id|file>`: read signing progress, or clear signatures to re-sign. */
async function cmdSign(flags: Flags): Promise<void> {
	const [sub, arg] = flags._
	if ((sub !== 'status' && sub !== 'clear') || !arg) {
		fail('Usage: mdpubs sign status <id|file>\n       mdpubs sign clear <id|file> (--slot N | --all) --reason "…"')
	}
	let cfg = await resolveConfig({apiKey: flags.apiKey, apiUrl: flags.apiUrl})
	cfg = await ensureAuthOrFail(cfg, flags)
	const id = await resolveId(flags, arg)

	try {
		if (sub === 'status') {
			const state = await getSignState(cfg, id)
			if (flags.json) return out(flags, '', {id, ...state})
			if (!state.enabled) return out(flags, `${id} is not signable.`, {})
			const done = state.signers.filter((s) => s.signed).length
			const head = state.complete
				? `Fully signed (${done}/${state.signers.length})`
				: `${done}/${state.signers.length} signed, ${state.order}`
			const lines = [`${id}: ${head}`, ...state.signers.map(signerLine)]
			if (state.contentMatches === false) {
				lines.push('  ! the body no longer matches what was signed; new signatures are blocked')
			}
			return out(flags, lines.join('\n'), {})
		}

		// clear: one slot or all of them, said explicitly, with a reason for the audit trail.
		if (flags.slot === undefined && !flags.all) fail('Say which signature: --slot N, or --all.')
		if (flags.slot !== undefined && flags.all) fail('Use --slot N or --all, not both.')
		if (!flags.reason?.trim()) fail('--reason is required; it is recorded in the audit trail.')
		const {voided, state} = await clearSignatures(cfg, id, {
			signerIndex: flags.slot,
			reason: flags.reason.trim(),
		})
		const human = [
			`Cleared ${voided} signature${voided === 1 ? '' : 's'} on ${id}.` +
				(flags.all ? ' The document is unlocked.' : ''),
			...state.signers.map(signerLine),
		].join('\n')
		out(flags, human, {id, voided, ...state})
	} catch (e) {
		handleApiError(e)
	}
}

async function cmdWhoami(flags: Flags): Promise<void> {
	const cfg = await resolveConfig({apiKey: flags.apiKey, apiUrl: flags.apiUrl})
	if (!cfg.apiKey) fail('No API key configured.')
	try {
		// No dedicated /me endpoint; listing notes is the cheapest authed check.
		const notes = await listNotes(cfg)
		out(flags, `OK — key valid against ${cfg.apiUrl} (${notes.length} pubs)`, {
			ok: true,
			apiUrl: cfg.apiUrl,
			pubs: notes.length,
		})
	} catch (e) {
		handleApiError(e)
	}
}

/**
 * Resolve auth for commands that need it. If a key is present, return as-is.
 * If missing: in --json mode or non-interactive, fail cleanly (agents must set
 * MDPUBS_API_KEY); otherwise run the interactive onboarding prompt.
 */
async function ensureAuthOrFail(cfg: CliConfig, flags: Flags): Promise<CliConfig> {
	if (cfg.apiKey) return cfg
	if (flags.json) {
		fail('No API key. Set MDPUBS_API_KEY or run `mdpubs login`.', 2)
	}
	try {
		return await ensureAuth(cfg, flags.noOpen ? false : undefined)
	} catch (e) {
		handleApiError(e)
	}
}

async function cmdLogin(flags: Flags): Promise<void> {
	// Non-interactive path: `mdpubs login --api-key K` saves directly (useful for
	// scripts/agents that already hold a key).
	if (flags.apiKey) {
		const cfg = await resolveConfig({apiKey: flags.apiKey, apiUrl: flags.apiUrl})
		const path = await saveApiKey(flags.apiKey, cfg.apiUrl)
		out(flags, `Saved API key to ${path}`, {ok: true, path})
		return
	}
	// Interactive path: prompt, validate, save.
	const cfg = await resolveConfig({apiUrl: flags.apiUrl})
	try {
		await runLogin({apiUrl: cfg.apiUrl, openBrowserFlag: flags.noOpen ? false : undefined})
		out(flags, '', {ok: true})
	} catch (e) {
		handleApiError(e)
	}
}

async function cmdLogout(flags: Flags): Promise<void> {
	if (apiKeyFromEnv()) {
		fail(
			'Your key is set via MDPUBS_API_KEY (environment), not the config file. Unset that env var to log out.',
			1,
		)
	}
	const path = await clearApiKey()
	out(flags, `Logged out. Cleared API key from ${path}`, {ok: true, path})
}

function handleApiError(e: unknown): never {
	if (e instanceof ApiError) {
		if (e.status === 401) fail(`Auth failed: ${e.message}`, 2)
		if (e.status === 403) fail(e.message, 3)
		if (e.status === 404) fail(`Not found: ${e.message}`, 4)
		fail(`API error (${e.status}): ${e.message}`)
	}
	fail(`Unexpected error: ${(e as Error)?.message || String(e)}`)
}

const HELP = `mdpubs — publish Markdown or HTML to mdpubs

Usage:
  mdpubs publish <file> [--private] [--title T] [--tags a,b] [--json]
  mdpubs list [--json]
  mdpubs open <id|file> [--json]
  mdpubs delete <id|file> [--json]
  mdpubs sign status <id|file> [--json]
  mdpubs sign clear <id|file> (--slot N | --all) --reason "…" [--json]
  mdpubs whoami [--json]
  mdpubs login [--api-key <key>] [--api-url <url>] [--no-open]
  mdpubs logout

Auth: the first time you publish, mdpubs walks you through pasting your API key
(from your account page). Or set MDPUBS_API_KEY, run \`mdpubs login\`, or pass
--api-key. Use \`mdpubs logout\` to clear a saved key, \`mdpubs login\` to change it.

The file remembers its pub id (markdown frontmatter / HTML comment), so
re-running publish updates the same pub.

Signing works for both markdown and HTML pubs.

  Markdown — in frontmatter:      HTML — comments near the top:
    mdpubs-sign: true               <!-- mdpubs-sign: true -->
    mdpubs-signers:                 <!-- mdpubs-signer: Name <email> -->
      - Name <email>                <!-- mdpubs-signer-open: Label -->
    mdpubs-signers-open:            <!-- mdpubs-signer-field: Title? -->
      - Label                       <!-- mdpubs-sign-order: parallel -->
    mdpubs-signer-fields:
      - Title?
    mdpubs-sign-order: parallel

A signer entry may be \`Name <email>\` (email pre-filled), a bare email, or a bare
\`Name\` (they supply their email when signing). An OPEN slot is for when you don't
know who signs — whoever holds the link enters their own name and email.

Fields: name/email/date are automatic; declare extras as above. A trailing \`?\`
makes a field optional. Order defaults to \`sequential\` (sign in listed order);
\`parallel\` lets anyone sign anytime.

Place a signature box inline with \`<!-- mdpubs-sign-here: Label -->\` in the body,
where Label matches a signer name or open-slot label; without an anchor the box
appears in the floating panel. Publish prints the detected signers and warns on
signer/anchor mismatches. Once anyone signs, the doc locks (later edits 409),
and so does its signer list, order and fields.

\`mdpubs sign status\` shows who has signed and whose turn it is. \`mdpubs sign
clear\` voids a signature so the slot can be signed again, e.g. someone signed
in the wrong box. --slot N clears one (the doc stays locked); --all clears every
signature and unlocks the doc. Needs the note's author or an org owner/admin.`

async function main(): Promise<void> {
	const [, , cmd, ...rest] = process.argv
	const flags = parseArgs(rest)

	switch (cmd) {
		case 'publish':
			return cmdPublish(flags)
		case 'list':
			return cmdList(flags)
		case 'open':
			return cmdOpen(flags)
		case 'delete':
		case 'rm':
			return cmdDelete(flags)
		case 'sign':
			return cmdSign(flags)
		case 'whoami':
			return cmdWhoami(flags)
		case 'login':
			return cmdLogin(flags)
		case 'logout':
			return cmdLogout(flags)
		case 'help':
		case '--help':
		case '-h':
		case undefined:
			process.stdout.write(HELP + '\n')
			return
		default:
			fail(`Unknown command: ${cmd}\n\n${HELP}`)
	}
}

main()
