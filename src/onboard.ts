/**
 * Interactive onboarding: get the user's API key into the CLI.
 *
 * Keys are issued by the mdpubs web UI (Account page), not the API, so the flow
 * is: point the user at mdpubs.com/account -> they copy their key -> paste here
 * -> we validate it against the API -> save to ~/.config/mdpubs/config.json.
 *
 * Used both on first-run auto-prompt and by `mdpubs login`.
 */
import {ACCOUNT_URL, saveApiKey, resolveConfig, type CliConfig} from './config'
import {listNotes, ApiError} from './api'

function isInteractive(): boolean {
	// Both stdin and stdout must be a TTY to prompt safely. Agents/CI are not.
	return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

async function prompt(question: string): Promise<string> {
	process.stdout.write(question)
	for await (const line of console) {
		return line.trim()
	}
	return ''
}

/** Best-effort open a URL in the user's browser. Never throws. */
async function openBrowser(url: string): Promise<boolean> {
	const platform = process.platform
	const cmd =
		platform === 'darwin' ? ['open', url] : platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url]
	try {
		const proc = Bun.spawn(cmd, {stdout: 'ignore', stderr: 'ignore'})
		await proc.exited
		return proc.exitCode === 0
	} catch {
		return false
	}
}

async function validateKey(apiUrl: string, apiKey: string): Promise<void> {
	// listNotes is the cheapest authenticated call; throws ApiError on bad key.
	await listNotes({apiUrl, apiKey})
}

/**
 * Run the interactive login flow. Returns the resolved config (with key) on
 * success. Throws if non-interactive or the user aborts.
 */
export async function runLogin(opts: {apiUrl: string; openBrowserFlag?: boolean}): Promise<CliConfig> {
	if (!isInteractive()) {
		throw new ApiError(
			'No API key and not running interactively. Set MDPUBS_API_KEY, or run `mdpubs login` in a terminal.',
			401,
		)
	}

	process.stdout.write('\nWelcome to mdpubs.\n')
	process.stdout.write(`Get your API key from your account page:\n  ${ACCOUNT_URL}\n`)
	process.stdout.write('  (Log in, then copy the API key shown under your account.)\n\n')

	if (opts.openBrowserFlag !== false) {
		const opened = await openBrowser(ACCOUNT_URL)
		if (opened) process.stdout.write('Opened the account page in your browser.\n\n')
	}

	for (let attempt = 0; attempt < 3; attempt++) {
		const key = await prompt('Paste your API key (input hidden is not supported; it will show): ')
		if (!key) {
			process.stdout.write('No key entered. Aborting.\n')
			throw new ApiError('Login cancelled: no key entered.', 401)
		}
		process.stdout.write('Validating...\n')
		try {
			await validateKey(opts.apiUrl, key)
		} catch (e) {
			const msg = e instanceof ApiError ? e.message : String(e)
			process.stdout.write(`That key did not work (${msg}). Try again.\n\n`)
			continue
		}
		const path = await saveApiKey(key, opts.apiUrl)
		process.stdout.write(`\nSuccess. Key saved to ${path}\nYou're ready: try \`mdpubs publish <file>\`.\n\n`)
		return resolveConfig()
	}
	throw new ApiError('Login failed after 3 attempts.', 401)
}

/**
 * Ensure we have a working config with an API key. If missing and interactive,
 * runs the login flow; otherwise throws a clear error.
 */
export async function ensureAuth(cfg: CliConfig, openBrowserFlag?: boolean): Promise<CliConfig> {
	if (cfg.apiKey) return cfg
	return runLogin({apiUrl: cfg.apiUrl, openBrowserFlag})
}
