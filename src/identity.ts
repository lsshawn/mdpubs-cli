/**
 * Pub identity: how a file remembers which mdpubs note it maps to.
 *
 * This is the create-vs-update signal. The file carries its own identity, so the
 * CLI (and any agent driving it) never needs external state.
 *
 *   - Markdown: a `mdpubs: <id>` key in YAML frontmatter (matches the nvim plugin).
 *   - HTML:     an `<!-- mdpubs: <id> -->` comment near the top.
 *
 * Missing/empty id  -> create, then stamp the returned id back into the file.
 * Present id        -> update that note.
 */

export type FileKind = 'markdown' | 'html'

export function detectKind(filename: string): FileKind {
	const lower = filename.toLowerCase()
	if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
	return 'markdown'
}

export function fileExtensionFor(filename: string): string {
	const lower = filename.toLowerCase()
	if (lower.endsWith('.markdown')) return 'markdown'
	if (lower.endsWith('.htm')) return 'htm'
	if (lower.endsWith('.html')) return 'html'
	return 'md'
}

const HTML_ID_RE = /<!--\s*mdpubs:\s*(\d+)?\s*-->/i
// Frontmatter block at the very top: --- ... --- ; we look for an mdpubs key in it.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/
const FM_ID_RE = /^\s*mdpubs:\s*(\d+)?\s*$/im

/** Extract the existing pub id from a file's content, or null if none/empty. */
export function extractId(content: string, kind: FileKind): number | null {
	if (kind === 'html') {
		const m = content.match(HTML_ID_RE)
		if (m && m[1]) return parseInt(m[1], 10)
		return null
	}
	const fm = content.match(FRONTMATTER_RE)
	if (!fm) return null
	const idLine = fm[1].match(FM_ID_RE)
	if (idLine && idLine[1]) return parseInt(idLine[1], 10)
	return null
}

// Privacy markers:
//   HTML:     <!-- mdpubs-is-private: true -->
//   Markdown: mdpubs-is-private: true   (in frontmatter)
const HTML_PRIVATE_RE = /<!--\s*mdpubs-is-private:\s*(true|false)\s*-->/i
const FM_PRIVATE_RE = /^\s*mdpubs-is-private:\s*(true|false)\s*$/im

/**
 * Read the in-file privacy intent, or null if not declared (caller decides the
 * default / lets a --private flag override).
 */
export function extractIsPrivate(content: string, kind: FileKind): boolean | null {
	const re = kind === 'html' ? HTML_PRIVATE_RE : FM_PRIVATE_RE
	const m = content.match(re)
	if (!m) return null
	return m[1].toLowerCase() === 'true'
}

// Signing markers (mdpubs-sign). The SERVER owns the authoritative parse; this
// is a read-only mirror so the CLI can confirm a doc is signable and list its
// signers back to the user after publishing.
//   HTML:     <!-- mdpubs-sign: true -->
//             <!-- mdpubs-signer: Name <email> -->
//   Markdown: mdpubs-sign: true            (in frontmatter)
//             mdpubs-signers: (a `- Name <email>` list, in frontmatter)
const HTML_SIGN_RE = /<!--\s*mdpubs-sign:\s*true\s*-->/i
// Matches both fixed (`mdpubs-signer:`) and open (`mdpubs-signer-open:`) markers.
const HTML_SIGNER_RE = /<!--\s*mdpubs-signer(-open)?:\s*(.+?)\s*-->/gi
const FM_SIGN_RE = /^\s*mdpubs-sign:\s*true\s*$/im

export interface SignInfo {
	enabled: boolean
	signers: string[]
}

/**
 * Detect whether a file opts into signing and list the raw signer entries. Open
 * slots (unknown signer) are shown with an "(open)" suffix. Empty / disabled when
 * not signable. Purely informational — the server validates.
 */
export function detectSignConfig(content: string, kind: FileKind): SignInfo {
	const disabled: SignInfo = {enabled: false, signers: []}
	const signers: string[] = []

	if (kind === 'html') {
		if (!HTML_SIGN_RE.test(content)) return disabled
		let m: RegExpExecArray | null
		HTML_SIGNER_RE.lastIndex = 0
		while ((m = HTML_SIGNER_RE.exec(content)) !== null) {
			const label = m[2].trim()
			signers.push(m[1] ? `${label} (open)` : label)
		}
	} else {
		const fm = content.match(FRONTMATTER_RE)
		if (!fm || !FM_SIGN_RE.test(fm[1])) return disabled
		const listMatch = fm[1].match(/^\s*mdpubs-signers:\s*\r?\n([\s\S]*?)(?=^\S|\Z)/im)
		if (listMatch) {
			const items = listMatch[1].matchAll(/^\s*-\s*(.+?)\s*$/gim)
			for (const item of items) signers.push(item[1].replace(/^["']|["']$/g, '').trim())
		}
		const openMatch = fm[1].match(/^\s*mdpubs-signers-open:\s*\r?\n([\s\S]*?)(?=^\S|\Z)/im)
		if (openMatch) {
			const items = openMatch[1].matchAll(/^\s*-\s*(.+?)\s*$/gim)
			for (const item of items) signers.push(`${item[1].replace(/^["']|["']$/g, '').trim()} (open)`)
		}
	}

	if (signers.length === 0) return disabled
	return {enabled: true, signers}
}

/**
 * Return content with the pub id stamped in. If an id marker already exists
 * (even empty), it is updated in place; otherwise a new marker is inserted at the
 * top in the kind-appropriate way.
 */
export function stampId(content: string, kind: FileKind, id: number): string {
	if (kind === 'html') {
		if (HTML_ID_RE.test(content)) {
			return content.replace(HTML_ID_RE, `<!-- mdpubs: ${id} -->`)
		}
		// Insert after a leading <!DOCTYPE ...> if present, else at the very top.
		const doctype = content.match(/^\s*<!doctype[^>]*>\r?\n?/i)
		if (doctype) {
			const idx = doctype[0].length
			return content.slice(0, idx) + `<!-- mdpubs: ${id} -->\n` + content.slice(idx)
		}
		return `<!-- mdpubs: ${id} -->\n` + content
	}

	// Markdown
	const fm = content.match(FRONTMATTER_RE)
	if (fm) {
		const block = fm[1]
		if (FM_ID_RE.test(block)) {
			const newBlock = block.replace(FM_ID_RE, `mdpubs: ${id}`)
			return content.replace(block, newBlock)
		}
		// Add the key into the existing frontmatter block.
		const newBlock = `mdpubs: ${id}\n${block}`
		return content.replace(block, newBlock)
	}
	// No frontmatter: create one.
	return `---\nmdpubs: ${id}\n---\n${content}`
}
