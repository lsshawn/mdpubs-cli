/**
 * Thin mdpubs API client. Auth via X-API-Key. Multipart for create/update so
 * local assets ride along as files[] parts (filename = in-note path), matching
 * how the API maps uploads into imageMap.
 */
import {basename} from 'path'
import type {LocalAsset} from './assets'
import type {CliConfig} from './config'

export interface NoteResponse {
	id: number
	title: string
	fileExtension?: string
	file_extension?: string
	updatedAt?: string
	isPrivate?: boolean
	[k: string]: unknown
}

export class ApiError extends Error {
	status: number
	constructor(message: string, status: number) {
		super(message)
		this.status = status
	}
}

function authHeaders(cfg: CliConfig): Record<string, string> {
	if (!cfg.apiKey) {
		throw new ApiError(
			'No API key. Set MDPUBS_API_KEY, run `mdpubs login`, or pass --api-key.',
			401,
		)
	}
	return {'X-API-Key': cfg.apiKey}
}

async function asError(res: Response): Promise<ApiError> {
	let msg = `${res.status} ${res.statusText}`
	try {
		const body = (await res.json()) as {error?: string}
		if (body?.error) msg = body.error
	} catch {
		/* non-JSON body */
	}
	return new ApiError(msg, res.status)
}

async function buildForm(
	title: string,
	content: string,
	fileExtension: string,
	assets: LocalAsset[],
	opts: {isPrivate?: boolean; tags?: string[]},
): Promise<FormData> {
	const form = new FormData()
	form.set('title', title)
	form.set('content', content)
	form.set('file_extension', fileExtension)
	if (opts.isPrivate !== undefined) form.set('isPrivate', String(opts.isPrivate))
	if (opts.tags && opts.tags.length) form.set('tags', JSON.stringify(opts.tags))

	for (const asset of assets) {
		const data = await Bun.file(asset.absPath).arrayBuffer()
		// The part name must be files[]; the filename carries the in-note path so the
		// server uses it as the imageMap key.
		form.append('files[]', new File([data], asset.ref || basename(asset.absPath)))
	}
	return form
}

export async function createNote(
	cfg: CliConfig,
	args: {
		title: string
		content: string
		fileExtension: string
		assets: LocalAsset[]
		isPrivate?: boolean
		tags?: string[]
	},
): Promise<NoteResponse> {
	const form = await buildForm(
		args.title,
		args.content,
		args.fileExtension,
		args.assets,
		{isPrivate: args.isPrivate, tags: args.tags},
	)
	const res = await fetch(`${cfg.apiUrl}/notes`, {
		method: 'POST',
		headers: authHeaders(cfg),
		body: form,
	})
	if (!res.ok) throw await asError(res)
	return (await res.json()) as NoteResponse
}

export async function updateNote(
	cfg: CliConfig,
	id: number,
	args: {
		title: string
		content: string
		fileExtension: string
		assets: LocalAsset[]
		isPrivate?: boolean
		tags?: string[]
	},
): Promise<NoteResponse> {
	const form = await buildForm(
		args.title,
		args.content,
		args.fileExtension,
		args.assets,
		{isPrivate: args.isPrivate, tags: args.tags},
	)
	const res = await fetch(`${cfg.apiUrl}/notes/${id}`, {
		method: 'PUT',
		headers: authHeaders(cfg),
		body: form,
	})
	if (!res.ok) throw await asError(res)
	return (await res.json()) as NoteResponse
}

export async function listNotes(cfg: CliConfig): Promise<NoteResponse[]> {
	const res = await fetch(`${cfg.apiUrl}/notes`, {headers: authHeaders(cfg)})
	if (!res.ok) throw await asError(res)
	const body = await res.json()
	// API may return an array or {notes: [...]}; handle both.
	return Array.isArray(body) ? body : (body.notes ?? [])
}

export async function deleteNote(cfg: CliConfig, id: number): Promise<void> {
	const res = await fetch(`${cfg.apiUrl}/notes/${id}`, {
		method: 'DELETE',
		headers: authHeaders(cfg),
	})
	if (!res.ok) throw await asError(res)
}
