/**
 * Find local asset references in a pub so they can be uploaded alongside it.
 *
 *   - Markdown: ![alt](path) and [text](path)
 *   - HTML:     src="path" and href="path"
 *
 * Remote and non-file references are ignored: http(s):, data:, //, #, mailto:,
 * and (for HTML href) Google Fonts / stylesheet CDNs resolve remotely already.
 * Only paths that exist on disk relative to the pub file are returned.
 */
import {dirname, resolve, isAbsolute} from 'path'
import type {FileKind} from './identity'

export interface LocalAsset {
	/** The reference exactly as written in the file (the in-note path / imageMap key). */
	ref: string
	/** Absolute path on disk. */
	absPath: string
}

function isRemote(ref: string): boolean {
	return (
		/^https?:/i.test(ref) ||
		ref.startsWith('//') ||
		ref.startsWith('data:') ||
		ref.startsWith('#') ||
		ref.startsWith('mailto:') ||
		ref.startsWith('tel:')
	)
}

function collectRefs(content: string, kind: FileKind): string[] {
	const refs = new Set<string>()
	if (kind === 'html') {
		const attrRe = /(?:src|href)\s*=\s*["']([^"']+)["']/gi
		let m: RegExpExecArray | null
		while ((m = attrRe.exec(content)) !== null) refs.add(m[1])
	} else {
		// markdown image/link: ![alt](path "title") or [text](path "title")
		const mdRe = /!?\[[^\]]*\]\(\s*<?([^\s>)]+)>?(?:\s+["'][^"']*["'])?\s*\)/g
		let m: RegExpExecArray | null
		while ((m = mdRe.exec(content)) !== null) refs.add(m[1])
	}
	return [...refs]
}

export async function findLocalAssets(
	content: string,
	filePath: string,
	kind: FileKind,
): Promise<LocalAsset[]> {
	const baseDir = dirname(resolve(filePath))
	const out: LocalAsset[] = []
	const seen = new Set<string>()

	for (const ref of collectRefs(content, kind)) {
		if (isRemote(ref)) continue
		// Strip any query/hash on local refs (e.g. logo.png?v=2).
		const clean = ref.replace(/[?#].*$/, '')
		if (!clean) continue
		const absPath = isAbsolute(clean) ? clean : resolve(baseDir, clean)
		if (seen.has(absPath)) continue
		try {
			const f = Bun.file(absPath)
			if (await f.exists()) {
				out.push({ref: clean, absPath})
				seen.add(absPath)
			}
		} catch {
			// ignore unreadable refs
		}
	}
	return out
}
