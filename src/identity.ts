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

// The id is the note's publicId: an unguessable nanoid (alphabet A-Za-z0-9_-).
// It is NOT numeric, so the capture must allow the full nanoid alphabet. Legacy
// integer ids still match (digits are a subset) and the API accepts them during
// the transition until the file is re-stamped with its publicId.
const HTML_ID_RE = /<!--\s*mdpubs:\s*([\w-]+)?\s*-->/i
// Frontmatter block at the very top: --- ... --- ; we look for an mdpubs key in it.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/
const FM_ID_RE = /^\s*mdpubs:\s*([\w-]+)?\s*$/im

/** Extract the existing pub id from a file's content, or null if none/empty. */
export function extractId(content: string, kind: FileKind): string | null {
	if (kind === 'html') {
		const m = content.match(HTML_ID_RE)
		if (m && m[1]) return m[1]
		return null
	}
	const fm = content.match(FRONTMATTER_RE)
	if (!fm) return null
	const idLine = fm[1].match(FM_ID_RE)
	if (idLine && idLine[1]) return idLine[1]
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
// Matches fixed (`mdpubs-signer:`) and open (`mdpubs-signer-open:`) markers.
// `mdpubs-signer-field:` does not match — the colon must follow immediately.
const HTML_SIGNER_RE = /<!--\s*mdpubs-signer(-open)?:\s*(.+?)\s*-->/gi
const HTML_FIELD_RE = /<!--\s*mdpubs-signer-field:\s*(.+?)\s*-->/gi
const HTML_ORDER_RE = /<!--\s*mdpubs-sign-order:\s*(sequential|parallel)\s*-->/i
const FM_SIGN_RE = /^\s*mdpubs-sign:\s*true\s*$/im
const FM_ORDER_RE = /^\s*mdpubs-sign-order:\s*(sequential|parallel)\s*$/im

/** Pull the `- item` entries out of a frontmatter block list, e.g. `mdpubs-signers:`. */
function frontmatterList(block: string, key: string): string[] {
	const m = block.match(new RegExp(`^\\s*${key}:\\s*\\r?\\n([\\s\\S]*?)(?=^\\S|\\Z)`, 'im'))
	if (!m) return []
	return [...m[1].matchAll(/^\s*-\s*(.+?)\s*$/gim)].map((i) =>
		i[1].replace(/^["']|["']$/g, '').trim(),
	)
}

/** Anchors in the body that place a signature box: `<!-- mdpubs-sign-here: Label -->`. */
const SIGN_HERE_RE = /<!--\s*mdpubs-sign-here:\s*(.*?)\s*-->/gi

export interface SignInfo {
	enabled: boolean
	signers: string[]
	/** Signing order. Server default is `sequential` when unspecified. */
	order: 'sequential' | 'parallel'
	/** Extra fields collected at signing; a trailing `?` means optional. */
	fields: string[]
	/** Labels found on `mdpubs-sign-here` anchors, in document order. */
	anchors: string[]
	/** Signers with no matching anchor, and anchors matching no signer. */
	unanchoredSigners: string[]
	orphanAnchors: string[]
}

/** Compare a signer label to an anchor label: case/whitespace-insensitive. */
function normLabel(s: string): string {
	return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Detect whether a file opts into signing and list the raw signer entries. Open
 * slots (unknown signer) are shown with an "(open)" suffix. Empty / disabled when
 * not signable. Purely informational — the server validates.
 */
export function detectSignConfig(content: string, kind: FileKind): SignInfo {
	const disabled: SignInfo = {
		enabled: false,
		signers: [],
		order: 'sequential',
		fields: [],
		anchors: [],
		unanchoredSigners: [],
		orphanAnchors: [],
	}
	// Raw slot labels (no "(open)" suffix) — these are what anchors join against.
	const labels: string[] = []
	const signers: string[] = []
	const fields: string[] = []
	// Server default when no order is declared.
	let order: 'sequential' | 'parallel' = 'sequential'

	if (kind === 'html') {
		if (!HTML_SIGN_RE.test(content)) return disabled
		const om = content.match(HTML_ORDER_RE)
		if (om) order = om[1].toLowerCase() as 'sequential' | 'parallel'

		let m: RegExpExecArray | null
		HTML_SIGNER_RE.lastIndex = 0
		while ((m = HTML_SIGNER_RE.exec(content)) !== null) {
			const label = m[2].trim()
			labels.push(label)
			signers.push(m[1] ? `${label} (open)` : label)
		}
		HTML_FIELD_RE.lastIndex = 0
		while ((m = HTML_FIELD_RE.exec(content)) !== null) fields.push(m[1].trim())
	} else {
		const fm = content.match(FRONTMATTER_RE)
		if (!fm || !FM_SIGN_RE.test(fm[1])) return disabled
		const block = fm[1]
		const om = block.match(FM_ORDER_RE)
		if (om) order = om[1].toLowerCase() as 'sequential' | 'parallel'

		for (const s of frontmatterList(block, 'mdpubs-signers')) {
			labels.push(s)
			signers.push(s)
		}
		for (const s of frontmatterList(block, 'mdpubs-signers-open')) {
			labels.push(s)
			signers.push(`${s} (open)`)
		}
		fields.push(...frontmatterList(block, 'mdpubs-signer-fields'))
	}

	if (signers.length === 0) return disabled

	// Anchors are matched against slot labels. For a named signer written as
	// `Name <email>`, the anchor normally carries just the name, so accept either.
	SIGN_HERE_RE.lastIndex = 0
	const anchors = [...content.matchAll(SIGN_HERE_RE)].map((a) => a[1].trim()).filter(Boolean)
	const anchorSet = new Set(anchors.map(normLabel))
	const labelKeys = labels.map((l) => {
		const bare = l.match(/^(.*?)\s*<[^>]+>$/)
		return {full: normLabel(l), bare: bare ? normLabel(bare[1]) : normLabel(l)}
	})
	const unanchoredSigners = labels.filter(
		(_, i) => !anchorSet.has(labelKeys[i].full) && !anchorSet.has(labelKeys[i].bare),
	)
	const orphanAnchors = anchors.filter(
		(a) => !labelKeys.some((k) => k.full === normLabel(a) || k.bare === normLabel(a)),
	)

	return {enabled: true, signers, order, fields, anchors, unanchoredSigners, orphanAnchors}
}

/**
 * Return content with the pub id stamped in. If an id marker already exists
 * (even empty), it is updated in place; otherwise a new marker is inserted at the
 * top in the kind-appropriate way.
 */
export function stampId(content: string, kind: FileKind, id: string): string {
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
