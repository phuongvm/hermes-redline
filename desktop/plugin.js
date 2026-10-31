// Redline — guided Markdown and source-code review in Hermes Desktop.
// The directive opens a reviewable file for selected-text annotations, then sends a
// batch of comments, questions, or change requests to the agent composer.
// Persistence: a sidecar chosen by the backend (adjacent <file><ext>.redline.json, or centralized under
// the Hermes home); the pane reads its location from the /annotations reply.

import {
  Badge, Button, Codicon, MessageTextContent, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS,
  TRANSCRIPT_DIRECTIVE_AREA, Textarea, atom, host, queryClient, useQuery, useValue,
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

const KINDS = {
  comment: { label: 'comment', short: '◆', var: '--rl-comment' },
  question: { label: 'question', short: '◇', var: '--rl-question' },
  change: { label: 'change request', short: '✎', var: '--rl-change' },
}

const MD_EXT = ['.md', '.markdown']
const CODE_EXT = ['.py', '.sh', '.ps1', '.psm1', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.html', '.svg', '.css', '.scss', '.c', '.h', '.cpp', '.go', '.rs', '.rb',
  '.yaml', '.yml', '.json', '.toml', '.xml', '.ini', '.cfg', '.sql']
const hasExt = (path, extensions) => extensions.some((extension) => path.toLowerCase().endsWith(extension))

// Every annotation stores the text it was made on. That quote is located inside the rendered block,
// painted as a wash behind those words, and the margin marker is placed against it, so a thread
// visibly belongs to its passage instead of to the paragraph as a whole. Both used to render at one
// absolute offset, so with several threads on a paragraph only the last marker was clickable and the
// earlier ones could not be reopened, sent, resolved or removed.
const MARKER_TOP = 2
// Marker geometry. MARKER_SIZE is the marker box in the stylesheet below (.rl-marker width and height):
// change one and the stacking step that keeps markers from overlapping has to change with it.
const MARKER_SIZE = 20
const MARKER_STEP = MARKER_SIZE + 2

/** Fallback row for a thread whose span cannot be located: the nth free slot on the block. */
function slotTop(index) {
  return MARKER_TOP + index * MARKER_STEP
}

/** Keep the open card inside the pane while it follows its own marker's row. */
function clampToPane(top, paneHeight, cardHeight = 120) {
  return Math.max(4, Math.min(top, paneHeight - cardHeight))
}

/** Collapse runs of whitespace to one space, keeping a map back to the raw offsets. */
function collapse(text) {
  let out = ''
  const map = []
  for (let at = 0; at < text.length; at += 1) {
    if (/\s/.test(text[at])) {
      if (out && out[out.length - 1] !== ' ') {
        out += ' '
        map.push(at)
      }
      continue
    }
    out += text[at]
    map.push(at)
  }
  return { out, map }
}

// Prefix lengths tried when the stored quote is not in the rendered text verbatim. Long first, so the
// wash stays as close to the real selection as the text allows; short enough to survive a divergence
// that starts early, such as a selection that ran on into the next paragraph.
const HEAD_FALLBACKS = [40, 24, 16, 12]

// The pure helpers and the DOM walk are gathered into `internals` at the foot of this file, which is the
// one seam the test suite (tests/) reaches them through. Not an API.

/**
 * Where a stored quote sits in the rendered text of its block, as raw `[start, end)` offsets.
 *
 * A browser selection and the rendered text agree once whitespace is collapsed (a selection that
 * wrapped across rendered lines carries the break with it). When they do not, the longest prefix of
 * the quote that is still present anchors the passage. Null when nothing matches: the caller falls
 * back to a free margin slot rather than pointing at the wrong words.
 */
function locateQuote(text, quote) {
  const needle = collapse(String(quote == null ? '' : quote)).out.trim()
  if (!text || !needle) return null
  const { out, map } = collapse(text)
  const span = (at, length) => ({ start: map[at], end: map[at + length - 1] + 1 })
  const exact = out.indexOf(needle)
  if (exact >= 0) return span(exact, needle.length)
  for (const length of HEAD_FALLBACKS) {
    if (length >= needle.length) continue
    const at = out.indexOf(needle.slice(0, length))
    if (at >= 0) return span(at, length)
  }
  return null
}

/**
 * Turn a selection's endpoints into offsets in a block's rendered text. An endpoint is a node index
 * plus an offset inside that node; anything past the last node clamps to the end of the block, which
 * is what a selection that ran on into the next paragraph produces.
 */
function spanFromPoints(lengths, start, end) {
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const offsetAt = (point) => {
    if (point.index >= lengths.length) return total
    let at = 0
    for (let index = 0; index < point.index; index += 1) at += lengths[index]
    return at + Math.min(point.offset, lengths[point.index])
  }
  const from = offsetAt(start)
  const to = offsetAt(end)
  return to > from ? { start: from, end: to } : null
}

/**
 * Where an annotation's span starts and ends in the rendered text of its block.
 *
 * Offsets recorded at selection time win when the text they point at is still the quoted passage.
 * Otherwise the quote is matched, which is also the path for sidecars written before offsets existed
 * and for annotations whose paragraph has since been edited above them.
 */
function spanForAnnotation(text, a) {
  const quote = collapse(String((a && a.quote) || '')).out.trim()
  const start = a && a.start
  const end = a && a.end
  if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length) {
    if (collapse(text.slice(start, end)).out.trim() === quote) return { start, end }
  }
  return locateQuote(text, quote)
}

/**
 * Which block holds an annotation's passage, and where in it.
 *
 * The recorded index is a paragraph position captured when the annotation was made, so anything that
 * adds or removes a paragraph above it shifts every later index. The recorded block is tried first,
 * then the blocks outward from it, nearest first, so a thread finds its own words again instead of
 * landing on whatever now occupies its old slot. Null when the passage is gone from the document.
 */
export function resolveBlock(texts, recorded, a) {
  const at = (index) => {
    const text = texts[index]
    if (typeof text !== 'string') return null
    const span = spanForAnnotation(text, a)
    return span ? { block: index, span } : null
  }
  const own = at(recorded)
  if (own) return own
  for (let distance = 1; distance < texts.length; distance += 1) {
    const found = at(recorded - distance) || at(recorded + distance)
    if (found) return found
  }
  return null
}

/** Keep markers that want the same row apart, in span order, without moving those that clear. */
function stackPositions(tops, step = MARKER_STEP) {
  const placed = tops.map((top, index) => ({ top, index })).sort((a, b) => a.top - b.top)
  let previous = null
  placed.forEach((marker) => {
    marker.top = previous === null ? marker.top : Math.max(marker.top, previous + step)
    previous = marker.top
  })
  const out = []
  placed.forEach((marker) => {
    out[marker.index] = marker.top
  })
  return out
}

/**
 * Merge one selection's rects into a single bar per rendered line.
 *
 * `range.getClientRects()` returns a rect for every inline run, so a selection crossing bold, italic
 * and a link arrives as several boxes of differing heights that overlap by a pixel or two. Painting
 * them all double-tints the text where they stack. Boxes sharing a line become that line's bar.
 */
function mergeBoxes(boxes) {
  const rows = []
  ;[...boxes].sort((a, b) => a.top - b.top || a.left - b.left).forEach((box) => {
    const row = rows.find((candidate) => {
      const overlap = Math.min(candidate.top + candidate.height, box.top + box.height) - Math.max(candidate.top, box.top)
      return overlap > Math.min(candidate.height, box.height) / 2
    })
    if (!row) {
      rows.push({ ...box })
      return
    }
    const right = Math.max(row.left + row.width, box.left + box.width)
    const bottom = Math.max(row.top + row.height, box.top + box.height)
    row.left = Math.min(row.left, box.left)
    row.top = Math.min(row.top, box.top)
    row.width = right - row.left
    row.height = bottom - row.top
  })
  return rows
}

/** Round measured geometry to half pixels before it is stored or compared. */
function quantise(value) {
  return Math.round(value * 2) / 2
}

/**
 * Whether two measurement passes agree, so the pane can skip a state update. Raw layout values wobble
 * by fractions between passes, and comparing them exactly re-renders the pane whenever they do.
 */
function sameMarks(next, previous) {
  const ids = Object.keys(next)
  if (ids.length !== Object.keys(previous).length) return false
  return ids.every((id) => {
    const fresh = next[id]
    const old = previous[id]
    if (!old || fresh.top !== old.top || fresh.block !== old.block || fresh.boxes.length !== old.boxes.length) return false
    return fresh.boxes.every((box, index) => {
      const before = old.boxes[index]
      return box.left === before.left && box.top === before.top
        && box.width === before.width && box.height === before.height
    })
  })
}

/** The wash boxes to paint for a thread: review work only, never over a resolved passage. */
function washBoxes(a, mark) {
  if (!mark || a.status === 'resolved') return []
  return mark.boxes
}

/** The margin glyph: the kind while a thread needs attention, a tick once it is resolved. */
function markerGlyph(a) {
  return a.status === 'resolved' ? '✓' : (KINDS[a.kind] || KINDS.comment).short
}

/**
 * What a card says about a closed thread: the agent's account of what it did, or who closed it when
 * there is none to give. The pane's own resolve button closes a thread with no agent involvement, so
 * a resolved card with nothing to report has to say so instead of looking broken. The card header
 * already carries the tick, so these lines stay plain text.
 */
function resolutionLine(a) {
  if (!a || a.status !== 'resolved') return null
  if (a.action) return a.action
  if (a.closed_by === 'reviewer') return 'closed in the pane'
  return 'closed, no action recorded'
}

/** Where each marker on a block goes: beside its located span, else in the next free slot. */
function blockMarkerTops(blockItems, marks, step = MARKER_STEP) {
  let fallback = 0
  const desired = blockItems.map((a) => {
    const mark = marks && marks[a.id]
    return mark && Number.isFinite(mark.top) ? mark.top : slotTop(fallback++)
  })
  const tops = stackPositions(desired, step)
  return blockItems.map((a, index) => ({ id: a.id, top: tops[index] }))
}

/** Text nodes under a node, in DOM order, ignoring the pane's own chrome (markers, highlight wash). */
function textNodesOf(el, out = []) {
  el.childNodes.forEach((node) => {
    if (node.nodeType === 3) {
      out.push(node)
    } else if (node.nodeType === 1 && !node.classList.contains('rl-hl') && !node.classList.contains('rl-marker')) {
      textNodesOf(node, out)
    }
  })
  return out
}

/** Text nodes under a node, counting the node itself when it is one. */
function textUnder(node) {
  return node.nodeType === 3 ? [node] : textNodesOf(node)
}

/** A range endpoint as a text node plus an offset inside it. */
function textPoint(container, offset) {
  if (container.nodeType === 3) return { node: container, offset }
  const children = Array.from(container.childNodes)
  const before = children.slice(0, offset).flatMap((child) => textUnder(child))
  if (before.length) {
    const last = before[before.length - 1]
    return { node: last, offset: last.nodeValue.length }
  }
  const after = children.slice(offset).flatMap((child) => textUnder(child))
  return after.length ? { node: after[0], offset: 0 } : null
}

/**
 * The live selection as offsets in its block's rendered text, clamped to that block.
 *
 * This is what makes the wash match the highlight: the selection is measured where it exists, in the
 * DOM, instead of being sliced out of the Markdown source (which carried markup the document never
 * renders and silently truncated long selections).
 */
function selectionSpan(blockEl, range) {
  const nodes = textNodesOf(blockEl)
  if (!nodes.length) return null
  const startPoint = textPoint(range.startContainer, range.startOffset)
  const last = nodes[nodes.length - 1]
  const endPoint = blockEl.contains(range.endContainer)
    ? textPoint(range.endContainer, range.endOffset)
    : { node: last, offset: last.nodeValue.length }
  if (!startPoint || !endPoint) return null
  return spanFromPoints(
    nodes.map((node) => node.nodeValue.length),
    { index: nodes.indexOf(startPoint.node), offset: startPoint.offset },
    { index: nodes.indexOf(endPoint.node), offset: endPoint.offset },
  )
}

/** Turn raw offsets into a DOM range so the browser can measure and paint that span. */
function rangeIn(el, span) {
  const nodes = textNodesOf(el)
  const range = document.createRange()
  let at = 0
  let started = false
  for (const node of nodes) {
    const length = node.nodeValue.length
    if (!started && at + length > span.start) {
      range.setStart(node, span.start - at)
      started = true
    }
    if (started && at + length >= span.end) {
      range.setEnd(node, span.end - at)
      return range
    }
    at += length
  }
  return null
}

/** The rendered text of a block, in the same order rangeIn walks it. */
function blockText(el) {
  return textNodesOf(el)
    .map((node) => node.nodeValue)
    .join('')
}

const CSS = `
.rl-root{position:relative;height:100%;display:flex;flex-direction:column;padding:18px 22px;
  --rl-comment:var(--ui-accent);--rl-question:var(--ui-purple);--rl-change:var(--ui-orange);
  --rl-comment-soft:color-mix(in oklab,var(--ui-accent) 16%,transparent);
  --rl-question-soft:color-mix(in oklab,var(--ui-purple) 16%,transparent);
  --rl-change-soft:color-mix(in oklab,var(--ui-orange) 16%,transparent)}
.rl-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--ui-stroke-secondary);padding-bottom:12px}
.rl-path{font-size:11px;color:var(--ui-text-tertiary);max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rl-main{flex:1;min-height:0;position:relative;margin-top:14px}
.rl-doc{height:100%;overflow:auto;padding-right:34px;max-width:720px;line-height:1.7;-webkit-user-select:text;user-select:text}
.rl-doc [data-rl-block]{position:relative;isolation:isolate;padding:2px 4px;border-radius:6px}
.rl-doc h1,.rl-doc h2,.rl-doc h3{font-weight:600;letter-spacing:-.01em;margin:14px 0 6px}
.rl-doc h1{font-size:17px}.rl-doc h2{font-size:15px}.rl-doc h3{font-size:13.5px}
.rl-doc ul,.rl-doc ol{padding-left:22px;margin:6px 0}
.rl-doc code{background:color-mix(in oklab,var(--ui-bg-elevated) 70%,transparent);border:1px solid var(--ui-stroke-tertiary);border-radius:5px;padding:1px 5px;font-size:12.5px}
.rl-doc pre{background:color-mix(in oklab,var(--ui-bg-elevated) 70%,transparent);border:1px solid var(--ui-stroke-tertiary);border-radius:8px;padding:10px 12px;overflow:auto;margin:8px 0}
.rl-doc pre code{border:0;background:none;padding:0}
.rl-doc blockquote{border-left:2px solid var(--ui-stroke-secondary);padding-left:10px;color:var(--ui-text-secondary);margin:8px 0}
.rl-doc table{border-collapse:collapse;margin:8px 0;font-size:13px}
.rl-doc th,.rl-doc td{border:1px solid var(--ui-stroke-secondary);padding:5px 10px;text-align:left}
.rl-doc a{color:var(--ui-accent)}
.rl-doc [data-rl-block]:hover{background:color-mix(in oklab,var(--ui-accent) 5%,transparent)}
.rl-line{display:flex;gap:10px;font-family:var(--ui-font-mono,ui-monospace,monospace);font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.rl-ln{flex:none;min-width:2.5em;text-align:right;color:var(--ui-text-quaternary);user-select:none}
.rl-code{flex:1;min-width:0}
.rl-tok-str{color:var(--ui-green)}
.rl-tok-com{color:var(--ui-text-quaternary);font-style:italic}
.rl-tok-kw{color:var(--ui-purple)}
.rl-tok-num{color:var(--ui-orange)}
.rl-tok-fn{color:var(--ui-accent)}
.rl-tok-typ{color:var(--ui-accent);font-weight:600}
.rl-tok-op{color:var(--ui-text-secondary)}
.rl-tok-dec{color:var(--ui-orange)}
.rl-asterisk{color:var(--ui-red);font-weight:700;font-size:15px;line-height:1}
.rl-doc mark{background:var(--rl-soft);color:inherit;border-radius:3px;padding:1px 2px;box-shadow:inset 0 -1px 0 var(--rl-line)}
.rl-doc mark.rl-sent{opacity:.45}
.rl-hl{position:absolute;inset:0;z-index:-1;pointer-events:none}
.rl-hl i{position:absolute;border-radius:3px;background:var(--rl-soft);box-shadow:inset 0 -1px 0 var(--rl-line)}
.rl-hl i.sent{opacity:.45}
.rl-hl i.done{opacity:.4}
.rl-marker{position:absolute;right:-26px;top:2px;width:20px;height:20px;border-radius:6px;border:1px solid var(--rl-line);background:var(--rl-soft);color:var(--rl-line);font-size:11px;line-height:1;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center}
.rl-marker:hover{background:color-mix(in oklab,var(--rl-line) 30%,transparent)}
.rl-marker.done{opacity:.4}
.rl-float{width:100%;border:1px solid var(--ui-stroke-secondary);border-left:2px solid var(--rl-line);border-radius:11px;padding:10px 12px;background:color-mix(in oklab,var(--ui-bg-elevated) 88%,transparent);backdrop-filter:blur(14px);box-shadow:0 10px 30px -14px rgba(0,0,0,.6);animation:rl-in .18s ease-out}
.rl-card{position:relative;border:1px solid var(--ui-stroke-secondary);border-left:2px solid var(--rl-line);border-radius:11px;padding:10px 12px;background:color-mix(in oklab,var(--ui-bg-elevated) 72%,transparent)}
@keyframes rl-in{from{opacity:0}}
.rl-kind{display:flex;align-items:center;gap:6px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--rl-line)}
.rl-quote{font-size:12px;color:var(--ui-text-tertiary);border-left:2px solid var(--ui-stroke-secondary);padding-left:8px;margin:6px 0;font-style:italic;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.rl-note{font-size:13px;line-height:1.55}
.rl-action{font-size:12.5px;line-height:1.5;color:var(--ui-text-secondary);margin-top:7px;padding-left:8px;border-left:2px solid var(--rl-line)}
.rl-action.quiet{color:var(--ui-text-tertiary);border-left-color:var(--ui-stroke-secondary)}
.rl-foot{display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:11px;color:var(--ui-text-tertiary)}
.rl-mini{border:0;background:none;color:var(--ui-text-tertiary);cursor:pointer;font-size:11px;padding:0}
.rl-mini:hover{color:var(--ui-text-primary)}
.rl-pill{position:absolute;z-index:10;display:flex;gap:2px;padding:4px;border-radius:10px;border:1px solid var(--ui-stroke-secondary);background:color-mix(in oklab,var(--ui-bg-elevated) 84%,transparent);backdrop-filter:blur(14px);box-shadow:0 10px 30px -14px rgba(0,0,0,.6);font-size:12px}
.rl-pill button{border:0;background:none;cursor:pointer;font-size:12px;font-weight:500;padding:5px 9px;border-radius:7px;color:var(--rl-line)}
.rl-pill button:hover{background:var(--rl-soft)}
.rl-pill i{width:1px;background:var(--ui-stroke-secondary);margin:2px 3px}
.rl-hint{font-size:11px;color:var(--ui-text-quaternary);padding-top:8px}
.rl-empty{font-size:12px;color:var(--ui-text-tertiary);padding:10px 0}
.rl-chip{display:flex;align-items:center;gap:5px;border:0;background:none;cursor:pointer;font-size:11px;padding:0 4px;color:var(--ui-text-tertiary)}
.rl-chip:hover{color:var(--ui-text-primary)}
.rl-chip b{font-weight:600;color:var(--ui-accent)}
.rl-tabs,.rl-threads{display:flex;gap:4px;flex-wrap:wrap;align-items:center;padding:8px 0 0}
.rl-tab{border:1px solid var(--ui-stroke-secondary);background:none;border-radius:7px;padding:2px 9px;font-size:11px;color:var(--ui-text-tertiary);cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rl-tab:hover{color:var(--ui-text-primary)}
.rl-tab.on{color:var(--ui-text-primary);background:color-mix(in oklab,var(--ui-accent) 14%,transparent);border-color:var(--ui-accent)}
.rl-browser-toggle{flex:none}
.rl-active{display:flex;align-items:baseline;gap:6px;flex:1 1 0;min-width:0;font-size:12px;color:var(--ui-text-primary);overflow:hidden;white-space:nowrap}
.rl-active b{font-weight:600;flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis}
.rl-active-dir{font-size:11px;color:var(--ui-text-tertiary);overflow:hidden;text-overflow:ellipsis}
.rl-browser{--rl-row-h:24px;max-height:calc(10 * var(--rl-row-h));overflow-y:auto;margin-top:8px;border:1px solid var(--ui-stroke-secondary);border-radius:8px;padding:0}
.rl-folder{height:var(--rl-row-h);line-height:var(--rl-row-h);padding:0 8px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--ui-text-quaternary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rl-browser .rl-tab{display:block;width:100%;max-width:none;height:var(--rl-row-h);text-align:left;border:0;border-radius:0;padding:0 8px 0 20px}
`

/**
 * A document path as one spelling: trimmed, with doubled backslashes collapsed. A JSON-escaped directive
 * attribute reaches the pane as `O:\\workspaces\\a.md`, while the backend reports `O:\workspaces\a.md`.
 */
function normalizeFilePath(value) {
  return String(value == null ? '' : value).trim().replace(/\\+/g, '\\')
}

/**
 * Comparison key of a path: separators and case folded, so `O:\a.md`, `O:\\a.md` and `o:/A.md` agree.
 * An archived OpenSpec location (`changes/archive/[YYYY-MM-DD-]<id>/...`) keys as its pre-archive
 * `changes/<id>/...`, so one file recorded before and after its change was archived is one entry.
 */
function pathKey(value) {
  return normalizeFilePath(value).replace(/\\+/g, '/').toLowerCase()
    .replace(/\/changes\/archive\/(?:\d{4}-\d{2}-\d{2}-)?([^/]+)(?=\/|$)/, '/changes/$1')
}

/**
 * Where an OpenSpec file moves when its change is archived: `.../changes/<id>/<rest>` becomes
 * `.../changes/archive/<id>/<rest>`, keeping the slash style. '' when there is no such location
 * (not under `changes/`, no change id, or already archived).
 */
function archiveFallbackPath(path) {
  const text = normalizeFilePath(path)
  const match = /(^|[\\/])changes([\\/])([^\\/]+)[\\/](?=[^\\/])/.exec(text)
  if (!match || match[3].toLowerCase() === 'archive') return ''
  const head = text.slice(0, match.index + match[1].length + 'changes'.length + match[2].length)
  return `${head}archive${match[2]}${text.slice(head.length)}`
}

// Where a document was actually read from, by pathKey: the pre-archive path a session still records
// cannot be read once its change is archived, so the pane asks for (and saves to) the archived file.
const RESOLVED_TARGETS = new Map()

/** The path to read and write for `path`: the archived location once it was found there, else `path`. */
function resolvedTargetPath(path) {
  return RESOLVED_TARGETS.get(pathKey(path)) || path
}

function samePath(a, b) {
  const key = pathKey(a)
  return key !== '' && key === pathKey(b)
}

/** Normalized, non-empty paths in order; of several spellings of one path the first wins. */
function dedupePaths(list) {
  const seen = new Set()
  const out = []
  for (const item of list || []) {
    const text = normalizeFilePath(item)
    const key = pathKey(text)
    if (text && !seen.has(key)) {
      seen.add(key)
      out.push(text)
    }
  }
  return out
}

/** Last path segment of a Windows or POSIX path. */
function fileBasename(path) {
  const text = String(path || '')
  return text.split(/[\\/]/).filter(Boolean).pop() || text
}

/** Containing folder of a Windows or POSIX path, forward-slashed; '' for a bare file name. */
function parentFolder(path) {
  const parts = normalizeFilePath(path).replace(/\\+/g, '/').split('/')
  parts.pop()
  return parts.length === 1 && parts[0] === '' ? '/' : parts.join('/')
}

/** A folder as its last two segments, enough to tell sibling folders apart; '.' for none. */
function shortFolderLabel(folder) {
  const label = String(folder || '').split('/').filter(Boolean).slice(-2).join('/')
  return label || (folder ? String(folder) : '.')
}

/**
 * Documents grouped by folder, folders and files in first-seen order; duplicate basenames stay apart.
 * Each group carries a `label`: the short two-segment label, except where several folders of the bundle
 * share it (`specs/x` vs `changes/x/specs/x`) - those are shown relative to their common ancestor.
 */
function groupByFolder(files) {
  const groups = []
  const byKey = new Map()
  dedupePaths(files).forEach((file) => {
    const folder = parentFolder(file)
    const key = pathKey(folder)
    if (!byKey.has(key)) {
      const group = { folder, label: shortFolderLabel(folder), files: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    byKey.get(key).files.push(file)
  })
  const clashes = new Map()
  groups.forEach((g) => {
    const k = g.label.toLowerCase()
    clashes.set(k, [...(clashes.get(k) || []), g])
  })
  clashes.forEach((clash) => {
    if (clash.length < 2) return
    const segs = clash.map((g) => g.folder.split('/').filter(Boolean))
    const limit = Math.min(...segs.map((s) => s.length)) - 1
    let shared = 0
    while (shared < limit && segs.every((s) => s[shared].toLowerCase() === segs[0][shared].toLowerCase())) shared += 1
    clash.forEach((g, i) => { g.label = segs[i].slice(shared).join('/') })
  })
  // A trimmed label can still equal another group's label: fall back to the full folder for those.
  const taken = new Map()
  groups.forEach((g) => taken.set(g.label.toLowerCase(), (taken.get(g.label.toLowerCase()) || 0) + 1))
  groups.forEach((g) => { if (taken.get(g.label.toLowerCase()) > 1) g.label = g.folder })
  return groups
}

/** Label of `folder` among `groups` (from groupByFolder); the short label for a folder outside them. */
function folderLabelOf(groups, folder) {
  const group = groups.find((g) => pathKey(g.folder) === pathKey(folder))
  return group ? group.label : shortFolderLabel(folder)
}

/**
 * The files a ::redline directive names: `file`, then `file_1..file_N` in numeric order, then an
 * optional JSON-array `files`. Unsupported extensions are dropped and duplicates keep first position.
 */
function parseBundleFiles(attrs) {
  const source = attrs || {}
  const wanted = []
  const push = (value) => {
    const text = normalizeFilePath(value)
    if (text && (hasExt(text, MD_EXT) || hasExt(text, CODE_EXT)) && !wanted.some((w) => samePath(w, text))) wanted.push(text)
  }
  push(source.file)
  Object.keys(source)
    .map((key) => /^file_(\d+)$/.exec(key))
    .filter((match) => match && Number(match[1]) >= 1)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .forEach((match) => push(source[match[0]]))
  if (source.files != null) {
    let list = source.files
    if (typeof list === 'string') {
      try { list = JSON.parse(list) } catch (error) { list = [] }
    }
    if (Array.isArray(list)) list.forEach(push)
  }
  return wanted
}

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/

/**
 * Split Markdown into review blocks on blank lines, except inside a fenced code block: a blank line
 * in a fence never ends the block, so the whole fence is one annotatable unit.
 */
function splitMarkdownBlocks(content) {
  const blocks = []
  let current = []
  let fence = null
  const flush = () => {
    if (current.length) blocks.push(current.join('\n'))
    current = []
  }
  String(content == null ? '' : content).split(/\r?\n/).forEach((line) => {
    if (fence) {
      current.push(line)
      const closer = line.trim()
      if (closer && closer.split('').every((ch) => ch === fence.char) && closer.length >= fence.size) fence = null
      return
    }
    if (!line.trim()) {
      flush()
      return
    }
    const opened = FENCE_OPEN.exec(line)
    if (opened && !(opened[1][0] === '`' && line.slice(opened[0].length).includes('`'))) {
      fence = { char: opened[1][0], size: opened[1].length }
    }
    current.push(line)
  })
  flush()
  return blocks
}

const MAX_RANGE_LINES = 200

/** The line block (`data-rl-block` index) a range endpoint sits in, or -1 outside the document. */
function blockIndexOf(docEl, node) {
  if (!node) return -1
  const el = node.nodeType === 3 ? node.parentElement : node
  const blockEl = el && el.closest ? el.closest('[data-rl-block]') : null
  if (!blockEl || (docEl.contains && !docEl.contains(blockEl))) return -1
  const raw = blockEl.dataset ? blockEl.dataset.rlBlock : blockEl.getAttribute('data-rl-block')
  const index = Number(raw)
  return Number.isInteger(index) ? index : -1
}

/**
 * A code selection as line anchors: first/last spanned line block (capped at 200 lines), 1-based
 * line numbers and the quote (the selected text for one line, the joined source lines for a range).
 */
function codeSelectionFromRange(docEl, blocks, range) {
  const from = blockIndexOf(docEl, range.startContainer)
  if (from < 0) return null
  let to = blockIndexOf(docEl, range.endContainer)
  let endFound = to >= 0
  if (!endFound) {
    // Ending at the document level (past the last line) spans to the last line; outside it stays on one.
    to = docEl.contains && docEl.contains(range.endContainer) ? Math.max(from, blocks.length - 1) : from
  }
  let lo = Math.min(from, to)
  let hi = Math.max(from, to)
  // A drag that ends at offset 0 of the next line has not selected anything on that line.
  if (endFound && hi > lo && range.endOffset === 0 && to === hi) hi -= 1
  hi = Math.min(lo + MAX_RANGE_LINES - 1, hi)
  const selected = typeof range.toString === 'function' ? String(range.toString()).trim() : ''
  const quote = lo === hi ? (selected || String(blocks[lo] || '').trim()) : blocks.slice(lo, hi + 1).join('\n')
  return { block: lo, endBlock: hi, line: lo + 1, endLine: hi + 1, quote }
}

/** True for a code annotation that spans more than one line. */
function isRangeItem(a) {
  return !!a && Number.isInteger(a.block) && Number.isInteger(a.endBlock) && a.endBlock > a.block
}

/** Which chat a batch goes to: an explicit re-bind, else the focused chat (standalone) or the card's pin. */
function resolveTargetSession({ pinnedSessionId, reboundSessionId, focusedSessionId, standalone } = {}) {
  return reboundSessionId || (standalone ? focusedSessionId : pinnedSessionId) || ''
}

/** Annotations for a Threads filter. Drafts are work in progress, so no filter lists them. */
function filterAnnotations(items, filter = 'all') {
  const real = (Array.isArray(items) ? items : []).filter((a) => a && !a.draft)
  return filter === 'all' || !filter ? real : real.filter((a) => a.status === filter)
}

/** The id `delta` steps from `currentId` in `ids`, wrapping at both ends; null for an empty list. */
function stepThread(ids, currentId, delta) {
  if (!ids || !ids.length) return null
  const at = ids.indexOf(currentId)
  if (at < 0) return delta < 0 ? ids[ids.length - 1] : ids[0]
  return ids[(((at + delta) % ids.length) + ids.length) % ids.length]
}

// Last answer per resource, so a poll can ask "has this changed since mtimeNs?" and reuse the data.
const POLL_CACHE = new Map()

/** `url` with its `path` query value swapped for `path`. */
function withPath(url, path) {
  return url.replace(/([?&]path=)[^&]*/, (_m, lead) => `${lead}${encodeURIComponent(path)}`)
}

/**
 * One poll of /doc or /annotations. Sends `since_mtime` once an answer is cached; an `unchanged`
 * reply returns the cached data untouched, anything else replaces it. `onChange` fires when a
 * cached document's text turns out to differ from the cached text. A path that cannot be read is
 * retried at its archived OpenSpec location; the location that answers is remembered.
 */
async function pollConditional(ctx, cache, key, url, onChange) {
  const prev = cache.get(key)
  const useSince = prev && Number.isFinite(prev.mtimeNs)
  const match = /[?&]path=([^&]*)/.exec(url)
  const path = match ? decodeURIComponent(match[1]) : ''
  const candidates = path ? [...new Set([resolvedTargetPath(path), path, archiveFallbackPath(path)].filter(Boolean))] : ['']
  let res
  let failure = null
  for (const candidate of candidates) {
    const target = candidate ? withPath(url, candidate) : url
    try {
      res = await ctx.rest(useSince ? `${target}${target.includes('?') ? '&' : '?'}since_mtime=${prev.mtimeNs}` : target)
      failure = null
      if (path) {
        if (candidate === path) RESOLVED_TARGETS.delete(pathKey(path))
        else RESOLVED_TARGETS.set(pathKey(path), candidate)
      }
      break
    } catch (error) {
      failure = failure || error
    }
  }
  if (failure) throw failure
  if (res && res.unchanged && prev) return prev.data
  if (res && Number.isFinite(res.mtimeNs)) cache.set(key, { mtimeNs: res.mtimeNs, data: res })
  // Only a different document text is a change worth flagging: a rewritten mtime with the same text is not.
  if (prev && prev.data && onChange && res && typeof res.content === 'string' && res.content !== prev.data.content) onChange()
  return res
}

// Tokens come lexed from the backend (Pygments) as a flat [class, text] list
// covering the whole file, newlines included; we split them back into lines so
// the gutter line numbers stay aligned. Empty list = plain-text fallback.
function tokensToLines(tokens) {
  const lines = [[]]
  let k = 0
  for (const [cls, text] of tokens) {
    const parts = String(text).split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([])
      const line = lines[lines.length - 1]
      if (parts[i]) line.push(cls ? jsx('span', { key: String(k++), className: `rl-tok-${cls}`, children: parts[i] }) : parts[i])
    }
  }
  return lines
}

export function buildBatchMessage(path, items, sidecarPath = '') {
  const slash = (value) => String(value).split(String.fromCharCode(92)).join('/')
  const sidecar = sidecarPath && slash(sidecarPath) !== slash(`${path}.redline.json`)
    ? ` Resolve status in sidecar: ${sidecarPath}.` : ''
  const head = `⁂ redline — review of ${path} (${items.length} notes). Change requests: edit ${path} in place — do not create a new copy or file.${sidecar}`
  const body = items.map((a, i) => {
    const k = KINDS[a.kind] || KINDS.comment
    const ranged = a.line && a.endLine && a.endLine > a.line
    const quote = ranged ? `L${a.line}-L${a.endLine}: ${a.quote}` : (a.line ? `L${a.line}: ${a.quote}` : a.quote)
    return `${i + 1}. [${k.label}] selection: "${quote}"\n   → ${a.note}`
  })
  return [head, ...body].join('\n')
}

function KindIcon({ kind }) {
  const k = KINDS[kind] || KINDS.comment
  return jsx('span', { style: { color: `var(${k.var})` }, children: k.short })
}

function Card({ a, draftText, onDraftText, onSaveDraft, onSend, onCancelDraft, onToggle, onRemove, onClose }) {
  const k = KINDS[a.kind] || KINDS.comment
  const resolution = resolutionLine(a)
  if (a.draft) {
    return jsxs('div', { className: 'rl-float', style: { '--rl-line': `var(${k.var})`, '--rl-soft': `var(${k.var}-soft)` }, children: [
      jsxs('div', { className: 'rl-kind', children: [jsx(KindIcon, { kind: a.kind }), k.label] }),
      jsx('div', { className: 'rl-quote', children: a.quote }),
      jsx(Textarea, {
        autoFocus: true, rows: 3, placeholder: 'Your comment, question, or request…',
        value: draftText, onChange: (e) => onDraftText(e.target.value),
      }),
      jsxs('div', { className: 'rl-foot', children: [
        jsx('button', { type: 'button', className: 'rl-mini', onClick: onCancelDraft, children: 'cancel' }),
        jsxs('span', { style: { display: 'flex', gap: 6 }, children: [
          jsx(Button, { size: 'sm', disabled: !draftText.trim(), onClick: () => onSaveDraft(a.id, draftText), children: 'Add to list' }),
          jsx(Button, { size: 'sm', variant: 'outline', disabled: !draftText.trim(), onClick: () => onSend(a.id, draftText), children: 'Send now' }),
        ] }),
      ] }),
    ] })
  }
  return jsxs('div', { className: 'rl-float', style: { '--rl-line': a.status === 'resolved' ? 'var(--ui-text-quaternary)' : `var(${k.var})`, '--rl-soft': `var(${k.var}-soft)` }, children: [
    jsxs('div', { className: 'rl-kind', children: [
      jsx(KindIcon, { kind: a.kind }), k.label,
      a.status === 'sent' && jsx('span', { style: { marginLeft: 'auto' }, children: 'sent' }),
      a.status === 'resolved' && jsx('span', { style: { marginLeft: 'auto' }, children: '✓ resolved' }),
      jsx('button', { type: 'button', className: 'rl-mini', style: { marginLeft: 6 }, onClick: onClose, children: '✕' }),
    ] }),
    jsx('div', { className: 'rl-quote', children: a.quote }),
    jsx('div', { className: 'rl-note', children: a.note }),
    resolution ? jsx('div', { className: `rl-action${a.action ? '' : ' quiet'}`, children: resolution }) : null,
    jsxs('div', { className: 'rl-foot', children: [
      jsx('button', { type: 'button', className: 'rl-mini', onClick: () => onRemove(a.id), children: 'remove' }),
      jsxs('span', { style: { display: 'flex', gap: 6, alignItems: 'center' }, children: [
        a.status === 'open' && a.note ? jsx(Button, { size: 'sm', variant: 'ghost', onClick: () => onSend(a.id, a.note), children: 'send now' }) : null,
        jsx('button', { type: 'button', className: 'rl-mini', onClick: () => onToggle(a.id), children: a.status === 'resolved' ? 'reopen' : 'resolve' }),
      ] }),
    ] }),
  ] })
}

// The chat the user is looking at: the stored id (what a directive's sessionId carries), else the runtime
// id, else the active runtime id. Read-only atoms; an older host without one of them is skipped.
const SESSION_ATOMS = ['focusedStoredSessionId', 'focusedSessionId', 'activeSessionId']
const NO_SESSION = atom('')
const sessionAtom = (name) => (host.state && host.state[name]) || NO_SESSION

function currentFocusedSessionId() {
  for (const name of SESSION_ATOMS) {
    try {
      const value = sessionAtom(name).get()
      if (value) return String(value)
    } catch (error) {
      // try the next atom
    }
  }
  return ''
}

// Reviewable documents per chat session. SESSION_BUNDLES is the live view, session-files:<id> in ctx.storage
// is its persisted copy, and $sessionBundles re-renders any open pane when a chat gains a document.
const MAX_SESSION_FILES = 32
const SESSION_BUNDLES = new Map()
const $sessionBundles = atom({})

const isReviewable = (path) => hasExt(path, MD_EXT) || hasExt(path, CODE_EXT)

function storedSessionFiles(ctx, sessionId) {
  let stored = []
  try { stored = ctx.storage.get(`session-files:${sessionId}`) } catch (error) { stored = [] }
  return dedupePaths([...(SESSION_BUNDLES.get(sessionId) || []), ...(Array.isArray(stored) ? stored : [])])
}

/** Record `files` as documents of `sessionId`. Files already known keep their place; new ones lead. */
function rememberSessionFiles(ctx, sessionId, files) {
  const sid = String(sessionId || '').trim()
  if (!sid) return []
  const previous = storedSessionFiles(ctx, sid)
  const fresh = dedupePaths(files).filter((f) => isReviewable(f) && !previous.some((p) => samePath(p, f)))
  if (!fresh.length) return previous
  const next = [...fresh, ...previous].slice(0, MAX_SESSION_FILES)
  SESSION_BUNDLES.set(sid, next)
  try { ctx.storage.set(`session-files:${sid}`, next) } catch (error) { /* storage is best effort */ }
  // Deferred: a directive registers while the transcript renders, and an atom set then would update the pane mid-render.
  queueMicrotask(() => $sessionBundles.set({ ...$sessionBundles.get(), [sid]: next }))
  return next
}

/** Backend rows that belong to `sessionId`. The backend filters too; this keeps an older gateway from leaking. */
function sessionRows(rows, sessionId) {
  if (!sessionId) return []
  return (Array.isArray(rows) ? rows : []).filter((r) => r && (r.sessionId === sessionId
    || (Array.isArray(r.sessions) && r.sessions.includes(sessionId))))
}

/** Ordered, de-duplicated documents of one session: registered directives, persisted copy, then the backend's rows. */
function sessionFilesFor(ctx, sessionId, centralRecent) {
  if (!sessionId) return []
  const fromBackend = sessionRows(centralRecent, sessionId).map((r) => r.path).filter(Boolean)
  return dedupePaths([...storedSessionFiles(ctx, sessionId), ...fromBackend])
}

/** The recent-rows query of one chat. Pane and status-bar chip share the key, so they share the answer. */
function recentSessionQuery(ctx, sessionId) {
  return {
    queryKey: ['redline:recent', sessionId],
    queryFn: () => ctx.rest(`/recent?limit=${MAX_SESSION_FILES}&session_id=${encodeURIComponent(sessionId)}`),
    enabled: !!sessionId, retry: false, refetchInterval: 5000,
  }
}

const FILTERS = [['all', 'All'], ['open', 'Open'], ['sent', 'Sent'], ['resolved', 'Resolved']]

function RedlinePane({ ctx, file, files, targetSessionId, standalone }) {
  const explicit = dedupePaths(Array.isArray(files) && files.length ? files : (file ? [file] : []))
  const first = explicit[0] || ''

  // Which chat this pane shows. A card pins its own chat until the user switches chats; a standalone pane
  // always follows the focused one. The atoms are subscribed, so a chat switch re-renders the pane.
  const storedFocus = useValue(sessionAtom('focusedStoredSessionId'))
  const runtimeFocus = useValue(sessionAtom('focusedSessionId'))
  const activeFocus = useValue(sessionAtom('activeSessionId'))
  useValue($sessionBundles)
  const focusedSession = String(storedFocus || runtimeFocus || activeFocus || '')

  const [activeState, setActive] = useState(first)
  const [draftText, setDraftText] = useState('')
  const [pill, setPill] = useState(null)
  const [shown, setShown] = useState(null)
  const [marks, setMarks] = useState({})
  const [rebound, setRebound] = useState('')
  const [initialFocused] = useState(focusedSession)
  const [lastFocused, setLastFocused] = useState(focusedSession)
  const [seenSession, setSeenSession] = useState(null)
  const [filter, setFilter] = useState('all')
  const [updated, setUpdated] = useState(false)
  const [browserChoice, setBrowserChoice] = useState(null)

  // "Bind to active chat" only lasts while that chat stays focused.
  let reboundNow = rebound
  if (lastFocused !== focusedSession) {
    setLastFocused(focusedSession)
    if (rebound) setRebound('')
    reboundNow = ''
  }
  // A card pins its chat until the user opens another one; a standalone pane always follows the focused chat.
  const followed = !standalone && focusedSession && focusedSession !== initialFocused ? focusedSession : ''
  // Whose documents the pane shows and whose recent files and sidecars it records.
  const effectiveSessionId = standalone ? focusedSession : (followed || targetSessionId || '')
  // Where a batch is delivered: an explicit re-bind wins, else the chat the pane shows.
  const deliverySessionId = followed
    ? (reboundNow || followed)
    : resolveTargetSession({
      pinnedSessionId: targetSessionId, reboundSessionId: reboundNow, focusedSessionId: focusedSession, standalone: !!standalone,
    })
  const measureRef = useRef(null)
  const docRef = useRef(null)
  const mainRef = useRef(null)

  const recentQ = useQuery(recentSessionQuery(ctx, effectiveSessionId))
  const centralRecent = sessionRows(recentQ.data && recentQ.data.items, effectiveSessionId)
  const sessionBundle = sessionFilesFor(ctx, effectiveSessionId, centralRecent)
  // The card's own files belong to its chat (or to a detached card); another chat never inherits them.
  const cardOwned = !standalone && (!effectiveSessionId || effectiveSessionId === targetSessionId)
  const bundle = cardOwned ? dedupePaths([...explicit, ...sessionBundle]) : sessionBundle

  // Reconcile the open document with the session in view, during render so no frame shows another chat's
  // file: a chat switch lands on that chat's first document, or on the empty state when it has none.
  let active = activeState
  if (seenSession !== effectiveSessionId) {
    setSeenSession(effectiveSessionId)
    const landing = bundle[0] || ''
    if (seenSession !== null || landing !== active) {
      active = landing
      setActive(landing)
    }
    if (seenSession !== null) {
      setShown(null)
      setPill(null)
      setUpdated(false)
      setBrowserChoice(null)
    }
  } else if (!active && bundle.length) {
    active = bundle[0]
    setActive(bundle[0])
  }

  // Open by default once the chat has two documents; the toggle then decides until the chat changes.
  const browserOpen = browserChoice === null ? bundle.length >= 2 : browserChoice
  const folderGroups = groupByFolder(bundle)

  const docQ = useQuery({
    queryKey: ['redline:doc', active],
    queryFn: () => pollConditional(ctx, POLL_CACHE, `doc:${active}`, `/doc?path=${encodeURIComponent(active)}`, () => setUpdated(true)),
    enabled: !!active, retry: false, refetchInterval: 3000, // ponytail: 3-second polling; since_mtime keeps an idle poll to one stat call
  })
  const annQ = useQuery({
    queryKey: ['redline:ann', active],
    queryFn: () => pollConditional(ctx, POLL_CACHE, `ann:${active}`, `/annotations?path=${encodeURIComponent(active)}`),
    enabled: !!active, retry: false, refetchInterval: 3000,
  })

  const items = (annQ.data && annQ.data.items) || []
  const sidecarPath = (annQ.data && annQ.data.sidecarPath) || ''
  const open = items.filter((a) => a.status === 'open')
  const filtered = filterAnnotations(items, filter)
  const visible = items.filter((a) => a.draft || filtered.includes(a))
  const unresolved = items.filter((a) => !a.draft && a.status !== 'resolved')
  useEffect(() => {
    if (!updated) return undefined
    const timer = setTimeout(() => setUpdated(false), 4000)
    return () => clearTimeout(timer)
  }, [updated])

  const isCode = active && hasExt(active, CODE_EXT)
  const tokLines = isCode && docQ.data && docQ.data.tokens && docQ.data.tokens.length
    ? tokensToLines(docQ.data.tokens) : null
  const blocks = !active || !docQ.data || typeof docQ.data.content !== 'string' ? [] : (isCode
    ? docQ.data.content.split('\n')
    : splitMarkdownBlocks(docQ.data.content))

  useEffect(() => { if (first) setActive(first) }, [first])

  const switchTo = (next) => {
    setActive(next)
    setShown(null)
    setPill(null)
    setUpdated(false)
  }

  // Threads are anchored to the rendered text, because the pane renders Markdown: the stored quote has
  // to be located in the DOM, not in the source. Measured after each render (the pane polls every 3s,
  // so agent edits flow through) and on resize. The wash and the margin markers read the result.
  const measure = () => {
    const doc = docRef.current
    if (!doc) return {}
    const blockEls = Array.from(doc.querySelectorAll('[data-rl-block]'))
    const texts = blockEls.map((el) => blockText(el))
    const next = {}
    items.forEach((a) => {
      if (isRangeItem(a)) {
        // A multi-line code selection is anchored by line numbers: wash every spanned line whole.
        const head = blockEls[a.block]
        if (!head) return
        const baseRect = head.getBoundingClientRect()
        const boxes = []
        for (let b = a.block; b <= Math.min(a.endBlock, blockEls.length - 1); b += 1) {
          const text = texts[b]
          const range = text ? rangeIn(blockEls[b], { start: 0, end: text.length }) : null
          if (!range) continue
          Array.from(range.getClientRects())
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .forEach((rect) => boxes.push({
              left: quantise(rect.left - baseRect.left),
              top: quantise(rect.top - baseRect.top),
              width: quantise(rect.width),
              height: quantise(rect.height),
            }))
        }
        const rows = mergeBoxes(boxes)
        if (rows.length) next[a.id] = { block: a.block, top: quantise(rows[0].top - 1), boxes: rows }
        return
      }
      // The block is resolved, not assumed: a paragraph added or removed above this thread shifts the
      // recorded index, and the passage is usually still there a block or two away.
      const resolved = resolveBlock(texts, a.block, a)
      if (!resolved) return
      const blockEl = blockEls[resolved.block]
      if (!blockEl) return
      const range = rangeIn(blockEl, resolved.span)
      if (!range) return
      const blockRect = blockEl.getBoundingClientRect()
      const boxes = Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => ({
          left: quantise(rect.left - blockRect.left),
          top: quantise(rect.top - blockRect.top),
          width: quantise(rect.width),
          height: quantise(rect.height),
        }))
      const rows = mergeBoxes(boxes)
      if (!rows.length) return
      next[a.id] = { block: resolved.block, top: quantise(rows[0].top - 1), boxes: rows }
    })
    return next
  }
  measureRef.current = measure
  useEffect(() => {
    const next = measureRef.current()
    if (!sameMarks(next, marks)) setMarks(next)
  })
  useEffect(() => {
    const remeasure = () => setMarks(measureRef.current())
    window.addEventListener('resize', remeasure)
    return () => window.removeEventListener('resize', remeasure)
  }, [])

  const save = (next) => {
    const key = ['redline:ann', active]
    ctx.rest('/annotations', { method: 'POST', body: { path: resolvedTargetPath(active), items: next, sessionId: effectiveSessionId || undefined } })
      .then((res) => {
        const previous = annQ.data || {}
        const saved = res && typeof res === 'object' ? res : {}
        const merged = {
          ...previous, unchanged: false, items: next,
          sidecarPath: saved.sidecarPath || previous.sidecarPath,
          storage: saved.storage || previous.storage,
          mtimeNs: Number.isFinite(saved.mtimeNs) ? saved.mtimeNs : previous.mtimeNs,
        }
        // Update the cache so the annotation appears immediately and the next poll is a cheap no-change.
        queryClient.setQueryData(key, merged)
        if (Number.isFinite(merged.mtimeNs)) POLL_CACHE.set(`ann:${active}`, { mtimeNs: merged.mtimeNs, data: merged })
        host.notify({ kind: 'info', message: `redline: saved ${next.length} annotations` })
      })
      .catch(() => host.notifyError('redline backend unavailable — enable the redline plugin (Capabilities → Plugins) and restart the gateway'))
  }

  const addDraft = (id, note) => {
    const a = items.find((x) => x.id === id)
    if (!a) return
    save([...items.filter((x) => x.id !== id), { ...a, note: note.trim(), draft: undefined, status: 'open' }])
    setDraftText('')
  }
  const toggle = (id) => save(items.map((a) => {
    if (a.id !== id) return a
    // Resolving here is the reviewer closing a thread; the agent's action line is separate, so record
    // who closed it and clear the record if it is reopened.
    return a.status === 'resolved'
      ? { ...a, status: 'open', closed_by: undefined }
      : { ...a, status: 'resolved', closed_by: 'reviewer' }
  }))
  const remove = (id) => save(items.filter((a) => a.id !== id))
  const resolveAll = () => {
    if (!unresolved.length) return
    save(items.map((a) => (a.draft || a.status === 'resolved' ? a : { ...a, status: 'resolved', closed_by: 'reviewer' })))
    setShown(null)
  }
  const jump = (delta) => {
    const id = stepThread(filtered.map((a) => a.id), shown, delta)
    if (!id) return
    setShown(id)
    const target = items.find((a) => a.id === id)
    const block = marks[id] ? marks[id].block : (target ? target.block : 0)
    const el = docRef.current && docRef.current.querySelector(`[data-rl-block="${block}"]`)
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' })
  }

  const bindToActiveChat = () => {
    const focused = currentFocusedSessionId()
    if (!focused) {
      host.notifyError('redline: no active chat to bind to; open a chat first')
      return
    }
    setRebound(focused)
    host.notify({ kind: 'info', message: 'redline: bound to the active chat' })
  }
  const deliveryTarget = () => (standalone
    ? resolveTargetSession({ reboundSessionId: reboundNow, focusedSessionId: currentFocusedSessionId(), standalone: true })
    : deliverySessionId)

  const onMouseUp = () => {
    const sel = window.getSelection()
    const picked = sel ? sel.toString().trim() : ''
    if (!picked || !sel.rangeCount || !mainRef.current || !docRef.current) { setPill(null); return }
    const range = sel.getRangeAt(0)
    if (!docRef.current.contains(range.startContainer)) { setPill(null); return }
    let node = range.startContainer
    if (node && node.nodeType === 3) node = node.parentElement
    const blockEl = node && node.closest ? node.closest('[data-rl-block]') : null
    if (!blockEl) { setPill(null); return }
    const r = range.getBoundingClientRect()
    const mb = mainRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(r.left - mb.left, mb.width - 260))
    const y = r.bottom - mb.top + 8
    if (isCode) {
      const spanned = codeSelectionFromRange(docRef.current, blocks, range)
      if (spanned && spanned.endBlock > spanned.block) {
        setPill({ ...spanned, x, y })
        return
      }
    }
    const span = selectionSpan(blockEl, range)
    if (!span) { setPill(null); return }
    setPill({
      block: Number(blockEl.dataset.rlBlock),
      // The rendered text of the selection, measured in the DOM: no markdown, no truncation, and the
      // same string the wash will paint.
      quote: blockText(blockEl).slice(span.start, span.end).trim(),
      start: span.start,
      end: span.end,
      x,
      y,
    })
  }
  const openKind = (kind) => {
    if (!pill) return
    const id = `a${Date.now()}`
    const line = isCode ? pill.block + 1 : undefined
    const multi = isCode && Number.isInteger(pill.endBlock) && pill.endBlock > pill.block
    const anchor = multi
      ? { endBlock: pill.endBlock, endLine: pill.endBlock + 1 }
      : { start: pill.start, end: pill.end, ...(isCode ? { endLine: line } : {}) }
    save([...items, { id, kind, block: pill.block, ...anchor, quote: pill.quote, note: '', status: 'open', draft: true, line }])
    setShown(id)
    setDraftText('')
    setPill(null)
    window.getSelection().removeAllRanges()
  }

  const sendBatch = () => {
    if (!open.length) return
    if (!submitToTarget(deliveryTarget(), buildBatchMessage(resolvedTargetPath(active), open, sidecarPath), !!standalone)) return
    save(items.map((a) => (a.status === 'open' ? { ...a, status: 'sent' } : a)))
    host.notify({ kind: 'info', message: `redline: ${open.length} annotations sent to Hermes` })
  }
  const sendOne = (id, note) => {
    const a = items.find((x) => x.id === id)
    if (!a) return
    const message = buildBatchMessage(resolvedTargetPath(active), [{ ...a, note: note.trim(), draft: undefined }], sidecarPath)
    if (!submitToTarget(deliveryTarget(), message, !!standalone)) return
    save(items.map((x) => (x.id === id ? { ...x, note: note.trim(), draft: undefined, status: 'sent' } : x)))
    setShown(null)
    setDraftText('')
    host.notify({ kind: 'info', message: 'redline: annotation sent to Hermes' })
  }

  return jsxs('div', { className: 'rl-root', children: [
    jsxs('div', { className: 'rl-head', children: [
      bundle.length ? jsx(Button, {
        size: 'sm', variant: 'ghost', className: 'rl-browser-toggle', 'aria-expanded': browserOpen,
        title: browserOpen ? 'Hide the file browser' : 'Show the file browser',
        onClick: () => setBrowserChoice(!browserOpen),
        children: jsx(Codicon, { name: browserOpen ? 'chevron-down' : 'chevron-right' }),
      }) : null,
      active ? jsxs('span', { className: 'rl-active', title: active, children: [
        jsx('b', { children: fileBasename(active) }),
        parentFolder(active) ? jsx('span', { className: 'rl-active-dir', children: folderLabelOf(folderGroups, parentFolder(active)) }) : null,
      ] }) : null,
      jsx('span', { style: { marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }, children: [
        updated ? jsx(Badge, { variant: 'outline', children: 'Updated' }) : null,
        !standalone ? jsx(Button, { size: 'sm', variant: 'ghost', title: 'Send this review to the chat that is open now', onClick: bindToActiveChat, children: 'Bind to active chat' }) : null,
        reboundNow ? jsx(Badge, { variant: 'outline', children: 'bound to active chat' }) : null,
        open.length ? jsx(Badge, { variant: 'outline', children: `${open.length} open` }) : null,
        jsx(Button, { size: 'sm', disabled: !open.length, onClick: sendBatch, children: `Send ${open.length || ''} to Hermes` }),
      ] }),
    ] }),
    bundle.length && browserOpen ? jsx('div', { className: 'rl-browser', children: folderGroups.flatMap((group) => [
      jsx('div', { className: 'rl-folder', title: group.folder, children: group.label }, `dir:${pathKey(group.folder)}`),
      ...group.files.map((f) => jsx('button', {
        type: 'button', className: `rl-tab${samePath(f, active) ? ' on' : ''}`, title: f, onClick: () => switchTo(f), children: fileBasename(f),
      }, pathKey(f))),
    ]) }) : null,
    items.length ? jsxs('div', { className: 'rl-threads', children: [
      jsx('span', { className: 'rl-mini', children: 'Threads' }),
      ...FILTERS.map(([id, label]) => jsx('button', {
        type: 'button', className: `rl-tab${filter === id ? ' on' : ''}`, onClick: () => setFilter(id), children: label,
      }, id)),
      jsx(Button, { size: 'sm', variant: 'ghost', disabled: !filtered.length, onClick: () => jump(-1), children: 'Prev' }),
      jsx(Button, { size: 'sm', variant: 'ghost', disabled: !filtered.length, onClick: () => jump(1), children: 'Next' }),
      jsx(Button, { size: 'sm', variant: 'ghost', disabled: !unresolved.length, onClick: resolveAll, children: 'Resolve all' }),
    ] }) : null,
    jsxs('div', { className: 'rl-main', ref: mainRef, children: [
      jsx('div', {
        ref: docRef, className: 'rl-doc', onMouseUp: onMouseUp,
        children: !active
          ? jsx('div', { className: 'rl-empty', children: centralRecent.length ? [
              jsx('div', { className: 'rl-mini', children: 'Recently annotated' }),
              ...centralRecent.map((r) => jsx('button', {
                type: 'button', className: 'rl-tab', title: r.path, onClick: () => switchTo(r.path),
                children: `${fileBasename(r.path)} · ${r.openCount} open`,
              }, r.sidecarPath || r.path)),
            ] : 'No documents to review in this session.' })
          : docQ.isPending
            ? jsx('div', { className: 'rl-empty', children: 'loading…' })
            : docQ.isError
              ? jsx('div', { className: 'rl-empty', children: `could not read ${active} — check the path (the redline backend must be active)` })
              : blocks.map((b, i) => {
                const blockItems = visible.filter((a) => (marks[a.id] ? marks[a.id].block : a.block) === i)
                const tops = blockMarkerTops(blockItems, marks)
                return jsxs('div', { 'data-rl-block': String(i), className: 'rl-block', children: [
                  jsx('div', { className: 'rl-hl', children: blockItems.flatMap((a) => {
                    const k = KINDS[a.kind] || KINDS.comment
                    return washBoxes(a, marks[a.id]).map((box, line) => jsx('i', {
                      className: a.status === 'sent' ? 'sent' : '',
                      style: {
                        '--rl-line': `var(${k.var})`, '--rl-soft': `var(${k.var}-soft)`,
                        left: box.left, top: box.top, width: box.width, height: box.height,
                      },
                    }, `${a.id}-${line}`))
                  }) }),
                  isCode
                    ? jsxs('div', { className: 'rl-line', children: [
                        jsx('span', { className: 'rl-ln', children: String(i + 1) }),
                        jsx('span', { className: 'rl-code', children: (tokLines && tokLines[i]) || b || ' ' }),
                      ] })
                    : jsx(MessageTextContent, { text: b, media: false }),
                  ...blockItems.map((a) => {
                    const k = KINDS[a.kind] || KINDS.comment
                    const row = tops.find((marker) => marker.id === a.id)
                    return jsx('button', {
                      type: 'button', className: `rl-marker${a.status === 'resolved' ? ' done' : ''}`,
                      style: { '--rl-line': `var(${k.var})`, '--rl-soft': `var(${k.var}-soft)`, top: row ? row.top : MARKER_TOP },
                      title: a.quote || a.note || k.label,
                      onClick: () => setShown(shown === a.id ? null : a.id),
                      children: markerGlyph(a),
                    }, a.id)
                  }),
                ] }, String(i))
              }) || null,
      }),
      shown ? (() => {
        const a = items.find((x) => x.id === shown)
        if (!a) return null
        const block = marks[a.id] ? marks[a.id].block : a.block
        const blockEl = docRef.current && docRef.current.querySelector(`[data-rl-block="${block}"]`)
        if (!blockEl || !mainRef.current) return null
        const bb = blockEl.getBoundingClientRect(), mb = mainRef.current.getBoundingClientRect()
        const row = blockMarkerTops(
          items.filter((x) => (marks[x.id] ? marks[x.id].block : x.block) === block), marks,
        ).find((marker) => marker.id === a.id)
        const top = clampToPane(bb.top - mb.top + (row ? row.top : MARKER_TOP), mb.height)
        return jsx('div', { style: { position: 'absolute', top, left: '50%', width: 'min(300px, 86%)', transform: 'translateX(-50%)', zIndex: 20 }, children: jsx(Card, {
          a, draftText, onDraftText: setDraftText, onSaveDraft: addDraft, onSend: sendOne,
          onCancelDraft: () => { save(items.filter((x) => x.id !== a.id)); setShown(null) },
          onToggle: toggle, onRemove: () => { remove(a.id); setShown(null) },
          onClose: () => setShown(null),
        }) })
      })() : null,
      pill ? jsxs('div', { className: 'rl-pill', style: { left: pill.x, top: pill.y }, children: [
        jsx('button', { type: 'button', style: { '--rl-line': 'var(--rl-comment)', '--rl-soft': 'var(--rl-comment-soft)' }, onClick: () => openKind('comment'), children: '◆ comment' }),
        jsx('i', {}),
        jsx('button', { type: 'button', style: { '--rl-line': 'var(--rl-question)', '--rl-soft': 'var(--rl-question-soft)' }, onClick: () => openKind('question'), children: '◇ question' }),
        jsx('i', {}),
        jsx('button', { type: 'button', style: { '--rl-line': 'var(--rl-change)', '--rl-soft': 'var(--rl-change-soft)' }, onClick: () => openKind('change'), children: '✎ change request' }),
      ] }) : null,
    ] }),
    jsx('div', { className: 'rl-hint', children: 'select text → ◆ comment · ◇ question · ✎ change request — the batch becomes a chat message' }),
  ] })
}

function submitToTarget(targetSessionId, message, standalone = false) {
  if (!targetSessionId) {
    host.notifyError(standalone
      ? 'redline: no active chat to send to; open a chat and try again — annotations remain unsent'
      : 'redline: this pane is detached; reopen it from a Redline card in the target chat')
    return false
  }
  if (!host.composer.submit(targetSessionId, message)) {
    host.notifyError('redline: target chat is unavailable; annotations remain unsent')
    return false
  }
  return true
}

function openStandalone(ctx) {
  host.openWorkspace('redline', {
    title: 'redline',
    dock: { pane: 'workspace', pos: 'right' },
    minWidth: '420px',
    render: () => jsx(RedlinePane, { ctx, standalone: true }, 'standalone'),
  })
}

function Chip({ ctx }) {
  // Follows the chat in view: the stored id, else the runtime id, else the active one.
  const stored = useValue(sessionAtom('focusedStoredSessionId'))
  const runtime = useValue(sessionAtom('focusedSessionId'))
  const active = useValue(sessionAtom('activeSessionId'))
  useValue($sessionBundles)
  const focusedSession = String(stored || runtime || active || '')
  const recentQ = useQuery(recentSessionQuery(ctx, focusedSession))
  const n = sessionFilesFor(ctx, focusedSession, sessionRows(recentQ.data && recentQ.data.items, focusedSession)).length
  if (!n) return null
  return jsxs('button', {
    type: 'button', className: 'rl-chip', title: `${n} reviewable ${n === 1 ? 'document' : 'documents'} in this chat — open Redline`,
    onClick: () => openStandalone(ctx),
    children: [jsx(Codicon, { name: 'comment-discussion', className: 'text-(--ui-accent)' }), jsx('b', { children: String(n) })],
  })
}

/**
 * Test seam. The suite in tests/ loads this file the way the Desktop runtime loader does, with SDK and
 * react stubs, and needs these to reach them from plain node. Not an API: the pane is the only
 * production consumer.
 */
export const internals = {
  locateQuote, spanFromPoints, spanForAnnotation, resolveBlock, stackPositions, mergeBoxes, quantise, sameMarks,
  washBoxes, markerGlyph, resolutionLine, blockMarkerTops, textNodesOf, selectionSpan, rangeIn, submitToTarget,
  normalizeFilePath, pathKey, dedupePaths, samePath, archiveFallbackPath, resolvedTargetPath, folderLabelOf, CSS,
  fileBasename, parentFolder, shortFolderLabel, groupByFolder, recentSessionQuery, parseBundleFiles, splitMarkdownBlocks, codeSelectionFromRange, buildBatchMessage, isRangeItem,
  resolveTargetSession, filterAnnotations, stepThread, pollConditional, MD_EXT, CODE_EXT,
  rememberSessionFiles, sessionFilesFor, sessionRows, currentFocusedSessionId, SESSION_BUNDLES, $sessionBundles,
}
export const __test = internals

export default {
  id: 'redline',
  name: 'Redline',
  register(ctx) {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    ctx.onDispose(() => style.remove())
    SESSION_BUNDLES.clear()
    $sessionBundles.set({})

    ctx.registerMany([
      { id: 'chip', area: STATUSBAR_AREAS.right, order: 130, render: () => jsx(Chip, { ctx }) },
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/redline' },
        render: () => jsx(RedlinePane, { ctx, standalone: true }, 'standalone'),
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 60,
        data: { codicon: 'comment-discussion', label: 'Redline', path: '/redline', asTile: true },
      },
      {
        id: 'directive',
        area: TRANSCRIPT_DIRECTIVE_AREA,
        data: {
          name: 'redline', // The agent writes ::redline{file="/path/to/file", file_1="/path/to/other"}
          render: ({ attrs, sessionId }) => {
            const bundleFiles = parseBundleFiles(attrs || {})
            if (!bundleFiles.length) return null
            rememberSessionFiles(ctx, sessionId, bundleFiles) // this chat now owns these documents
            const lead = bundleFiles[0]
            return jsxs('div', {
              className: 'rl-card', style: { '--rl-line': 'var(--ui-red)', maxWidth: 460 }, children: [
                jsxs('div', { className: 'rl-kind', children: [jsx('span', { className: 'rl-asterisk', children: '⁂' }), 'guided review'] }),
                jsx('div', { className: 'rl-note', children: lead }),
                bundleFiles.length > 1 ? jsx('div', { className: 'rl-path', children: `+${bundleFiles.length - 1} more` }) : null,
                jsx('div', { className: 'rl-foot', children: jsx(Button, {
                  size: 'sm',
                  onClick: () => host.openWorkspace('redline', {
                    title: 'redline',
                    dock: { pane: 'workspace', pos: 'right' },
                    minWidth: '420px',
                    render: () => jsx(RedlinePane, { ctx, file: lead, files: bundleFiles, targetSessionId: sessionId }, `${bundleFiles.join('|')}:${sessionId || ''}`),
                  }),
                  children: 'Review in Redline',
                }) }),
              ],
            })
          },
        },
      },
    ])
  },
}
