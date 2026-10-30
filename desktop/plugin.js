// Redline — guided Markdown and source-code review in Hermes Desktop.
// The directive opens a reviewable file for selected-text annotations, then sends a
// batch of comments, questions, or change requests to the agent composer.
// Persistence: <file><ext>.redline.json sidecar.

import {
  Badge, Button, Codicon, Input, MessageTextContent, STATUSBAR_AREAS,
  TRANSCRIPT_DIRECTIVE_AREA, Textarea, atom, host, queryClient, useQuery, useValue,
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

const KINDS = {
  comment: { label: 'comment', short: '◆', var: '--rl-comment' },
  question: { label: 'question', short: '◇', var: '--rl-question' },
  change: { label: 'change request', short: '✎', var: '--rl-change' },
}

const $openCount = atom(0)

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
.rl-title{font-size:15px;font-weight:600;letter-spacing:-.01em}
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
`

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

export function buildBatchMessage(path, items) {
  const head = `⁂ redline — review of ${path} (${items.length} notes). Change requests: edit ${path} in place — do not create a new copy or file.`
  const body = items.map((a, i) => {
    const k = KINDS[a.kind] || KINDS.comment
    const quote = a.line ? `L${a.line}: ${a.quote}` : a.quote
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

function RedlinePane({ ctx, file, targetSessionId }) {
  const [path, setPath] = useState(file || '')
  const [active, setActive] = useState(file || '')
  const [draftText, setDraftText] = useState('')
  const [pill, setPill] = useState(null)
  const [shown, setShown] = useState(null)
  const [marks, setMarks] = useState({})
  const measureRef = useRef(null)
  const docRef = useRef(null)
  const mainRef = useRef(null)

  const docQ = useQuery({
    queryKey: ['redline:doc', active],
    queryFn: () => ctx.rest(`/doc?path=${encodeURIComponent(active)}`),
    enabled: !!active, retry: false, refetchInterval: 3000, // ponytail: 3-second polling; upgrade to SSE if latency matters
  })
  const annQ = useQuery({
    queryKey: ['redline:ann', active],
    queryFn: () => ctx.rest(`/annotations?path=${encodeURIComponent(active)}`),
    enabled: !!active, retry: false, refetchInterval: 3000,
  })

  const items = (annQ.data && annQ.data.items) || []
  const open = items.filter((a) => a.status === 'open')
  useEffect(() => {
    $openCount.set(open.length)
    return () => $openCount.set(0)
  }, [open.length])

  const isCode = active && hasExt(active, CODE_EXT)
  const tokLines = isCode && docQ.data && docQ.data.tokens && docQ.data.tokens.length
    ? tokensToLines(docQ.data.tokens) : null
  const blocks = !active || !docQ.data ? [] : (isCode
    ? docQ.data.content.split('\n')
    : docQ.data.content.split(/\n[ \t]*\n/))

  useEffect(() => { if (file) { setActive(file); setPath(file) } }, [file])

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
    ctx.rest('/annotations', { method: 'POST', body: { path: active, items: next } })
      .then(() => {
        queryClient.setQueryData(['redline:ann', active], { items: next }) // Update the cache so the annotation appears immediately.
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
    const span = selectionSpan(blockEl, range)
    if (!span) { setPill(null); return }
    const r = range.getBoundingClientRect()
    const mb = mainRef.current.getBoundingClientRect()
    setPill({
      block: Number(blockEl.dataset.rlBlock),
      // The rendered text of the selection, measured in the DOM: no markdown, no truncation, and the
      // same string the wash will paint.
      quote: blockText(blockEl).slice(span.start, span.end).trim(),
      start: span.start,
      end: span.end,
      x: Math.max(0, Math.min(r.left - mb.left, mb.width - 260)),
      y: r.bottom - mb.top + 8,
    })
  }
  const openKind = (kind) => {
    if (!pill) return
    const id = `a${Date.now()}`
    const line = isCode ? pill.block + 1 : undefined
    save([...items, { id, kind, block: pill.block, quote: pill.quote, start: pill.start, end: pill.end, note: '', status: 'open', draft: true, line }])
    setShown(id)
    setDraftText('')
    setPill(null)
    window.getSelection().removeAllRanges()
  }

  const sendBatch = () => {
    if (!open.length) return
    if (!submitToTarget(targetSessionId, buildBatchMessage(active, open))) return
    save(items.map((a) => (a.status === 'open' ? { ...a, status: 'sent' } : a)))
    host.notify({ kind: 'info', message: `redline: ${open.length} annotations sent to Hermes` })
  }
  const sendOne = (id, note) => {
    const a = items.find((x) => x.id === id)
    if (!a) return
    if (!submitToTarget(targetSessionId, buildBatchMessage(active, [{ ...a, note: note.trim(), draft: undefined }]))) return
    save(items.map((x) => (x.id === id ? { ...x, note: note.trim(), draft: undefined, status: 'sent' } : x)))
    setShown(null)
    setDraftText('')
    host.notify({ kind: 'info', message: 'redline: annotation sent to Hermes' })
  }

  const load = () => {
    const p = path.trim()
    if (!p) return
    setActive(p)
    const recent = (ctx.storage.get('recent') || []).filter((x) => x !== p)
    ctx.storage.set('recent', [p, ...recent].slice(0, 6))
  }
  const recent = ctx.storage.get('recent') || []

  return jsxs('div', { className: 'rl-root', children: [
    jsxs('div', { className: 'rl-head', children: [
      jsx('span', { className: 'rl-title', children: 'redline' }),
      active ? jsx('span', { className: 'rl-path', title: active, children: active }) : null,
      jsx(Input, { value: path, placeholder: 'File path (Markdown or code)', className: 'w-64', onChange: (e) => setPath(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') load() } }),
      jsx(Button, { size: 'sm', variant: 'outline', onClick: load, children: 'open' }),
      recent.length ? jsx('span', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' }, children: recent.map((r) => jsx(Button, { size: 'sm', variant: 'ghost', className: 'rl-chip', onClick: () => { setActive(r); setPath(r) } }, r.split('/').pop())) }) : null,
      jsx('span', { style: { marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }, children: [
        open.length ? jsx(Badge, { variant: 'outline', children: `${open.length} open` }) : null,
        jsx(Button, { size: 'sm', disabled: !open.length, onClick: sendBatch, children: `Send ${open.length || ''} to Hermes` }),
      ] }),
    ] }),
    jsxs('div', { className: 'rl-main', ref: mainRef, children: [
      jsx('div', {
        ref: docRef, className: 'rl-doc', onMouseUp: onMouseUp,
        children: docQ.isPending && active
          ? jsx('div', { className: 'rl-empty', children: 'loading…' })
          : docQ.isError
            ? jsx('div', { className: 'rl-empty', children: `could not read ${active} — check the path (the redline backend must be active)` })
            : blocks.map((b, i) => {
              const blockItems = items.filter((a) => (marks[a.id] ? marks[a.id].block : a.block) === i)
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

function submitToTarget(targetSessionId, message) {
  if (!targetSessionId) {
    host.notifyError('redline: this pane is detached; reopen it from a Redline card in the target chat')
    return false
  }
  if (!host.composer.submit(targetSessionId, message)) {
    host.notifyError('redline: target chat is unavailable; annotations remain unsent')
    return false
  }
  return true
}

function Chip() {
  const n = useValue($openCount)
  if (!n) return null
  return jsxs('span', {
    className: 'rl-chip', title: 'open redline annotations',
    children: [jsx(Codicon, { name: 'tag', className: 'text-(--ui-accent)' }), jsx('b', { children: String(n) })],
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
}

export default {
  id: 'redline',
  name: 'Redline',
  register(ctx) {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    ctx.onDispose(() => style.remove())

    ctx.registerMany([
      { id: 'chip', area: STATUSBAR_AREAS.right, order: 130, render: () => jsx(Chip, {}) },
      {
        id: 'directive',
        area: TRANSCRIPT_DIRECTIVE_AREA,
        data: {
          name: 'redline', // The agent writes ::redline{file="/path/to/reviewable-file"}
          render: ({ attrs, sessionId }) => {
            const file = String(attrs.file || '').trim()
            if (!file || !(hasExt(file, MD_EXT) || hasExt(file, CODE_EXT))) return null
            return jsxs('div', {
              className: 'rl-card', style: { '--rl-line': 'var(--ui-red)', maxWidth: 460 }, children: [
                jsxs('div', { className: 'rl-kind', children: [jsx('span', { className: 'rl-asterisk', children: '⁂' }), 'guided review'] }),
                jsx('div', { className: 'rl-note', children: file }),
                jsx('div', { className: 'rl-foot', children: jsx(Button, {
                  size: 'sm',
                  onClick: () => host.openWorkspace('redline', {
                    title: 'redline',
                    dock: { pane: 'workspace', pos: 'right' },
                    minWidth: '420px',
                    render: () => jsx(RedlinePane, { ctx, file, targetSessionId: sessionId }, `${file}:${sessionId || ''}`),
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
