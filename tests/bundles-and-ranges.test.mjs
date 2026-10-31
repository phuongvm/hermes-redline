// Multi-file bundles, fence-aware Markdown blocks, multi-line code ranges and the batch header.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { find, loadPlugin } from './load-plugin.mjs'
import * as react from './stubs/react.mjs'
import * as sdk from './stubs/plugin-sdk.mjs'

const plugin = await loadPlugin()
const { fileBasename, parseBundleFiles, splitMarkdownBlocks, codeSelectionFromRange, buildBatchMessage, isRangeItem,
  normalizeFilePath, pathKey, dedupePaths, samePath, MD_EXT, CODE_EXT } = plugin.internals

test('normalizeFilePath collapses doubled backslashes and pathKey folds separators and case', () => {
  assert.equal(normalizeFilePath('  O:\\\\\\\\workspaces\\\\\\\\a.md '), 'O:\\workspaces\\a.md')
  assert.equal(normalizeFilePath('O:\\workspaces\\a.md'), 'O:\\workspaces\\a.md')
  assert.equal(normalizeFilePath('O:/workspaces/a.md'), 'O:/workspaces/a.md')
  assert.equal(normalizeFilePath(null), '')
  const spellings = ['O:\\\\workspaces\\\\a.md', 'O:\\workspaces\\a.md', 'O:/workspaces/a.md', 'o:/Workspaces/A.MD']
  assert.equal(new Set(spellings.map(pathKey)).size, 1)
  assert.ok(spellings.every((s) => samePath(s, spellings[0])))
  assert.equal(samePath('O:\\a.md', 'O:\\b.md'), false)
  assert.equal(samePath('', ''), false)
})

test('dedupePaths keeps the first spelling of each path, normalized, in order', () => {
  assert.deepEqual(
    dedupePaths(['O:\\\\w\\\\a.md', 'O:\\w\\b.md', 'O:\\w\\a.md', 'O:/w/b.md', '', null, 'O:/w/c.md']),
    ['O:\\w\\a.md', 'O:\\w\\b.md', 'O:/w/c.md'])
})

test('parseBundleFiles folds escaped and mixed separator spellings into one file', () => {
  assert.deepEqual(
    parseBundleFiles({ file: 'O:\\\\w\\\\a.md', file_1: 'O:\\w\\a.md', file_2: 'O:/w/a.md', file_3: 'O:\\\\w\\\\b.md' }),
    ['O:\\w\\a.md', 'O:\\w\\b.md'])
})

test('fileBasename handles Windows and POSIX paths', () => {
  assert.equal(fileBasename('O:\\a\\b\\proposal.md'), 'proposal.md')
  assert.equal(fileBasename('/x/y/design.md'), 'design.md')
  assert.equal(fileBasename('O:\\a\\b\\'), 'b')
  assert.equal(fileBasename(''), '')
  assert.equal(fileBasename(undefined), '')
})

test('parseBundleFiles orders file, file_1..N numerically, drops unsupported and duplicate paths', () => {
  const files = parseBundleFiles({
    file: 'O:\\a\\proposal.md', file_2: 'O:\\a\\design.md', file_1: 'O:\\a\\spec.md', file_3: 'O:\\a\\logo.png',
    file_10: 'O:\\a\\last.md', file_0: 'O:\\a\\zero.md',
  })
  assert.deepEqual(files, ['O:\\a\\proposal.md', 'O:\\a\\spec.md', 'O:\\a\\design.md', 'O:\\a\\last.md'])
})

test('parseBundleFiles accepts a JSON-array files attribute and deduplicates in order', () => {
  assert.deepEqual(
    parseBundleFiles({ file: '/a.md', files: JSON.stringify(['/b.py', '/a.md', '/c.exe', '/d.ps1']) }),
    ['/a.md', '/b.py', '/d.ps1'])
  assert.deepEqual(parseBundleFiles({ files: 'not json' }), [])
  assert.deepEqual(parseBundleFiles({}), [])
  assert.deepEqual(parseBundleFiles({ file: '   ' }), [])
})

test('extension sets are the expanded ones', () => {
  assert.deepEqual(MD_EXT, ['.md', '.markdown'])
  for (const ext of ['.ps1', '.psm1', '.mjs', '.cjs', '.jsx', '.html', '.svg', '.css', '.scss', '.xml', '.ini', '.cfg']) {
    assert.ok(CODE_EXT.includes(ext), ext)
  }
})

test('splitMarkdownBlocks keeps a fenced block with blank lines whole', () => {
  const text = 'Intro paragraph.\n\n```python\ndef f():\n\n    return 1\n```\n\nClosing paragraph.\n'
  const blocks = splitMarkdownBlocks(text)
  assert.equal(blocks.length, 3)
  assert.equal(blocks[0], 'Intro paragraph.')
  assert.equal(blocks[1], '```python\ndef f():\n\n    return 1\n```')
  assert.equal(blocks[2], 'Closing paragraph.')
})

test('splitMarkdownBlocks handles tilde fences and longer fences containing shorter ones', () => {
  const tilde = splitMarkdownBlocks('a\n\n~~~yaml\nk: 1\n\nj: 2\n~~~\n\nz')
  assert.equal(tilde.length, 3)
  assert.ok(tilde[1].includes('k: 1\n\nj: 2'))
  const nested = splitMarkdownBlocks('a\n\n````md\n```\n\ninner\n```\n````\n\nz')
  assert.equal(nested.length, 3)
  assert.ok(nested[1].endsWith('````') && nested[1].includes('inner'))
})

test('splitMarkdownBlocks without fences splits on blank lines and tolerates CRLF and an unclosed fence', () => {
  assert.deepEqual(splitMarkdownBlocks('a\nb\n\n\n  \nc\r\n\r\nd'), ['a\nb', 'c', 'd'])
  assert.deepEqual(splitMarkdownBlocks('x\n\n```\nopen\n\nstill open'), ['x', '```\nopen\n\nstill open'])
  assert.deepEqual(splitMarkdownBlocks(''), [])
  assert.deepEqual(splitMarkdownBlocks(null), [])
})

// A minimal DOM: line blocks as elements the way the pane renders them (data-rl-block on each).
function fakeDoc(lineCount) {
  const blocks = Array.from({ length: lineCount }, (_, i) => {
    const el = { nodeType: 1, dataset: { rlBlock: String(i) }, closest: (sel) => (sel === '[data-rl-block]' ? el : null) }
    const text = { nodeType: 3, parentElement: el }
    el.text = text
    return el
  })
  return {
    blocks,
    docEl: { contains: (node) => !!node && (node === blocks.docEl || blocks.some((b) => b === node || b.text === node)) },
  }
}

const sourceLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)

test('codeSelectionFromRange builds an L-range across lines 10..14', () => {
  const { blocks, docEl } = fakeDoc(30)
  const range = { startContainer: blocks[9].text, endContainer: blocks[13].text, startOffset: 0, endOffset: 4, toString: () => 'ignored' }
  const sel = codeSelectionFromRange(docEl, sourceLines, range)
  assert.deepEqual(sel, { block: 9, endBlock: 13, line: 10, endLine: 14, quote: sourceLines.slice(9, 14).join('\n') })
  assert.equal(isRangeItem(sel), true)
})

test('codeSelectionFromRange normalises a backwards DOM order and caps at 200 lines', () => {
  const { blocks, docEl } = fakeDoc(300)
  const lines = Array.from({ length: 300 }, (_, i) => `l${i}`)
  const range = { startContainer: blocks[250].text, endContainer: blocks[10].text, startOffset: 0, endOffset: 2, toString: () => '' }
  const sel = codeSelectionFromRange(docEl, lines, range)
  assert.equal(sel.block, 10)
  assert.equal(sel.endBlock, 209)
  assert.equal(sel.endLine - sel.line + 1, 200)
})

test('codeSelectionFromRange ignores a trailing drag onto offset 0 of the next line and keeps single lines single', () => {
  const { blocks, docEl } = fakeDoc(30)
  const dragged = codeSelectionFromRange(docEl, sourceLines,
    { startContainer: blocks[41 - 41 + 4].text, endContainer: blocks[5].text, startOffset: 1, endOffset: 0, toString: () => 'x' })
  assert.equal(dragged.endBlock, 4)
  const single = codeSelectionFromRange(docEl, sourceLines,
    { startContainer: blocks[41 - 41 + 2].text, endContainer: blocks[2].text, startOffset: 0, endOffset: 4, toString: () => 'line' })
  assert.deepEqual(single, { block: 2, endBlock: 2, line: 3, endLine: 3, quote: 'line' })
  assert.equal(isRangeItem(single), false)
  assert.equal(codeSelectionFromRange(docEl, sourceLines, { startContainer: { nodeType: 3, parentElement: null }, endContainer: null }), null)
})

test('buildBatchMessage formats L-ranges, single lines, Markdown quotes', () => {
  const items = [
    { kind: 'change', line: 10, endLine: 14, quote: 'a\nb', note: 'tighten' },
    { kind: 'comment', line: 42, endLine: 42, quote: 'x = 1', note: 'why' },
    { kind: 'question', line: 7, quote: 'y', note: 'n' },
    { kind: 'comment', quote: 'plain md', note: 'm' },
  ]
  const text = buildBatchMessage('/w/app.py', items)
  assert.match(text, /1\. \[change request\] selection: "L10-L14: a\nb"/)
  assert.match(text, /2\. \[comment\] selection: "L42: x = 1"/)
  assert.match(text, /3\. \[question\] selection: "L7: y"/)
  assert.match(text, /4\. \[comment\] selection: "plain md"/)
  assert.doesNotMatch(text.split('\n')[0], /Resolve status in sidecar/)
})

test('buildBatchMessage names a centralized sidecar and omits the adjacent one', () => {
  const item = [{ kind: 'comment', quote: 'q', note: 'n' }]
  const central = 'C:\\Users\\x\\.hermes\\redline\\annotations\\abcd-plan.md.redline.json'
  assert.ok(buildBatchMessage('/w/plan.md', item, central).split('\n')[0].endsWith(`Resolve status in sidecar: ${central}.`))
  assert.doesNotMatch(buildBatchMessage('/w/plan.md', item, '/w/plan.md.redline.json'), /Resolve status/)
  assert.doesNotMatch(buildBatchMessage('C:\\w\\plan.md', item, 'C:/w/plan.md.redline.json'), /Resolve status/)
  assert.doesNotMatch(buildBatchMessage('/w/plan.md', item, ''), /Resolve status/)
})

async function mountDirective(attrs, sessionId = 'sess-1') {
  sdk.__reset()
  react.__reset()
  sdk.__setQueryResult('redline:doc', { content: '# T\n\nBody.\n' })
  sdk.__setQueryResult('redline:ann', { items: [] })
  globalThis.document ??= { createElement: () => ({ remove() {} }), head: { appendChild() {} } }
  let entries = []
  plugin.default.register({
    rest: async () => ({}), storage: { get: () => [], set() {} }, onDispose() {},
    registerMany(next) { entries = next },
  })
  const directive = entries.find((entry) => entry.id === 'directive')
  return { card: directive.data.render({ attrs, sessionId }), directive }
}

test('a multi-attribute directive shows +N more and opens the pane with a tab per file', async () => {
  const attrs = { file: 'O:\\a\\proposal.md', file_2: 'O:\\a\\design.md', file_1: 'O:\\a\\spec.md', file_3: 'O:\\a\\logo.png' }
  const { card } = await mountDirective(attrs)
  const more = find(card, (n) => n.props.className === 'rl-path' && n.props.children === '+2 more')
  assert.equal(more.length, 1)
  const [open] = find(card, (n) => n.type === sdk.Button && n.props.children === 'Review in Redline')
  open.props.onClick()
  const pane = sdk.host.workspaces.at(-1).render()
  assert.deepEqual(pane.props.files, ['O:\\a\\proposal.md', 'O:\\a\\spec.md', 'O:\\a\\design.md'])
  assert.equal(pane.props.targetSessionId, 'sess-1')
  react.__beginRender()
  const tree = pane.type(pane.props)
  const tabs = find(tree, (n) => typeof n.props.className === 'string' && n.props.className.startsWith('rl-tab') && n.props.title)
  assert.deepEqual(tabs.map((t) => t.props.children), ['proposal.md', 'spec.md', 'design.md'])
})

test('a directive with no supported file renders nothing and a single file shows one tab', async () => {
  const none = await mountDirective({ file: '/x/logo.png' })
  assert.equal(none.card, null)
  const { card } = await mountDirective({ file: '/x/one.md' })
  assert.equal(find(card, (n) => n.props.className === 'rl-path').length, 0)
  const [open] = find(card, (n) => n.type === sdk.Button)
  open.props.onClick()
  const pane = sdk.host.workspaces.at(-1).render()
  react.__beginRender()
  const tabs = find(pane.type(pane.props), (n) => typeof n.props.className === 'string' && n.props.className.startsWith('rl-tab') && n.props.title)
  assert.deepEqual(tabs.map((t) => t.props.title), ['/x/one.md'])
})
