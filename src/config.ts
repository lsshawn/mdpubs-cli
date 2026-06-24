/**
 * Config resolution for the mdpubs CLI.
 *
 * Precedence (highest first):
 *   1. --api-key / --api-url flags (handled in cli.ts)
 *   2. MDPUBS_API_KEY / MDPUBS_API_URL env vars
 *   3. ~/.config/mdpubs/config.json
 *   4. defaults
 *
 * This makes the CLI friendly for both humans (run `mdpubs login` once) and
 * agents (set MDPUBS_API_KEY in the environment, no interactive step).
 */
import {homedir} from 'os'
import {join} from 'path'

export const DEFAULT_API_URL = 'https://api.mdpubs.com'
export const PUBLIC_BASE_URL = 'https://mdpubs.com'
/** Where users get / regenerate their API key (web UI Account page). */
export const ACCOUNT_URL = `${PUBLIC_BASE_URL}/account`

export interface CliConfig {
	apiKey?: string
	apiUrl: string
}

function configPath(): string {
	const base =
		process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
	return join(base, 'mdpubs', 'config.json')
}

async function readConfigFile(): Promise<Partial<CliConfig>> {
	try {
		const file = Bun.file(configPath())
		if (!(await file.exists())) return {}
		return (await file.json()) as Partial<CliConfig>
	} catch {
		return {}
	}
}

export async function resolveConfig(overrides: Partial<CliConfig> = {}): Promise<CliConfig> {
	const fromFile = await readConfigFile()
	const apiKey =
		overrides.apiKey || process.env.MDPUBS_API_KEY || fromFile.apiKey
	const apiUrl =
		overrides.apiUrl ||
		process.env.MDPUBS_API_URL ||
		fromFile.apiUrl ||
		DEFAULT_API_URL
	return {apiKey, apiUrl: apiUrl.replace(/\/+$/, '')}
}

export async function saveApiKey(apiKey: string, apiUrl?: string): Promise<string> {
	const path = configPath()
	const existing = await readConfigFile()
	const next: Partial<CliConfig> = {
		...existing,
		apiKey,
		...(apiUrl ? {apiUrl: apiUrl.replace(/\/+$/, '')} : {}),
	}
	// Bun.write creates parent dirs as needed.
	await Bun.write(path, JSON.stringify(next, null, 2))
	return path
}

export async function clearApiKey(): Promise<string> {
	const path = configPath()
	const existing = await readConfigFile()
	delete (existing as Partial<CliConfig>).apiKey
	await Bun.write(path, JSON.stringify(existing, null, 2))
	return path
}

/** Did the key come from the environment? (env keys can't be cleared by logout) */
export function apiKeyFromEnv(): boolean {
	return !!process.env.MDPUBS_API_KEY
}

export {configPath}
