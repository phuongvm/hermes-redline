// Multi-file bundles, fence-aware Markdown blocks, multi-line code ranges and the batch header.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { find, loadPlugin } from './load-plugin.mjs'
import * as react from './stubs/react.mjs'
import * as sdk from './stubs/plugin-sdk.mjs'

const plugin = await loadPlugin()
const { fileBasename, parseBundleFiles, splitMarkdownBlocks, codeSelectionFromRange, buildBatchMessage, isRangeItem,
  normalizeFilePath, pathKey, dedupePaths, samePath, MD_EXT, CODE_EXT, parentFolder, groupByFolder, shortFolderLabel, archiveFallbackPath } = plugin.internals

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
  const browser = find(tree, (n) => n.props.className === 'rl-browser')
  assert.equal(browser.length, 1, 'three documents open the file browser by default')
  const tabs = find(browser[0], (n) => typeof n.props.className === 'string' && n.props.className.startsWith('rl-tab') && n.props.title)
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
  const tree = pane.type(pane.props)
  assert.equal(find(tree, (n) => n.props.className === 'rl-browser').length, 0, 'one document: browser closed by default')
  assert.equal(find(tree, (n) => n.props.className === 'rl-active')[0].props.title, '/x/one.md', 'the active file bar names the document')
})


// ------------------------------------------------------------------ folder grouping

test('parentFolder returns the containing folder of Windows and POSIX paths', () => {
  assert.equal(parentFolder('O:\\w\\openspec\\changes\\a\\tasks.md'), 'O:/w/openspec/changes/a')
  assert.equal(parentFolder('/x/y/design.md'), '/x/y')
  assert.equal(parentFolder('/design.md'), '/')
  assert.equal(parentFolder('design.md'), '')
})

test('groupByFolder groups files by folder, keeping first-seen order and the original paths', () => {
  const files = ['/w/a/tasks.md', '/w/b/tasks.md', '/w/a/spec.md', '\\w\\b\\spec.md', '/w/b/tasks.md']
  const groups = groupByFolder(files)
  assert.deepEqual(groups.map((g) => g.folder), ['/w/a', '/w/b'])
  assert.deepEqual(groups[0].files, ['/w/a/tasks.md', '/w/a/spec.md'])
  assert.deepEqual(groups[1].files, ['/w/b/tasks.md', '\\w\\b\\spec.md'], 'mixed separators fold into one folder; duplicates collapse')
})

test('groupByFolder keeps duplicate basenames apart under their own folders', () => {
  const groups = groupByFolder(['/w/c1/tasks.md', '/w/c2/tasks.md', '/w/c1/spec.md', '/w/c2/spec.md'])
  assert.equal(groups.length, 2)
  for (const g of groups) assert.deepEqual(g.files.map(fileBasename).sort(), ['spec.md', 'tasks.md'])
  assert.notEqual(groups[0].folder, groups[1].folder)
})

test('shortFolderLabel disambiguates with the trailing folders and keeps the root marker for top-level files', () => {
  assert.equal(shortFolderLabel('O:/w/openspec/changes/a'), 'changes/a')
  assert.equal(shortFolderLabel('/x'), 'x')
  assert.equal(shortFolderLabel(''), '.')
})

test('the browser groups duplicate basenames under folder headers and is bounded to ten rows with vertical scroll', async () => {
  const { card } = await mountDirective({ file: '/w/c1/tasks.md', file_1: '/w/c2/tasks.md', file_2: '/w/c1/spec.md', file_3: '/w/c2/spec.md' })
  const [open] = find(card, (n) => n.type === sdk.Button)
  open.props.onClick()
  const pane = sdk.host.workspaces.at(-1).render()
  react.__beginRender()
  const tree = pane.type(pane.props)
  const browser = find(tree, (n) => n.props.className === 'rl-browser')[0]
  const folders = find(browser, (n) => n.props.className === 'rl-folder')
  assert.deepEqual(folders.map((f) => f.props.title), ['/w/c1', '/w/c2'])
  const tabs = find(browser, (n) => typeof n.props.className === 'string' && n.props.className.startsWith('rl-tab') && n.props.title)
  assert.deepEqual(tabs.map((t) => t.props.title), ['/w/c1/tasks.md', '/w/c1/spec.md', '/w/c2/tasks.md', '/w/c2/spec.md'])
  assert.match(plugin.internals.CSS, /\.rl-browser\{[^}]*max-height:calc\(10 \* [^}]*overflow-y:auto/)
})

test('the active file bar shows the basename with its parent folder and the full path as title', async () => {
  const { card } = await mountDirective({ file: 'O:\\w\\changes\\a\\tasks.md', file_1: 'O:\\w\\changes\\b\\tasks.md' })
  const [open] = find(card, (n) => n.type === sdk.Button)
  open.props.onClick()
  const pane = sdk.host.workspaces.at(-1).render()
  react.__beginRender()
  const tree = pane.type(pane.props)
  const active = find(tree, (n) => n.props.className === 'rl-active')[0]
  assert.equal(active.props.title, 'O:\\w\\changes\\a\\tasks.md')
  const text = JSON.stringify(active.props.children)
  assert.match(text, /tasks\.md/)
  assert.match(text, /changes\/a/)
})


// ------------------------------------------------------------------ archived OpenSpec changes
// Session 20261031_191521_4d8634: files were recorded under openspec/changes/<id>/... and later archived
// to openspec/changes/archive/<id>/...; the same change also owns openspec/specs/<id>/spec.md.

test('archiveFallbackPath maps changes/<id>/<rest> to changes/archive/<id>/<rest> and keeps the slash style', () => {
  assert.equal(archiveFallbackPath('O:\\w\\openspec\\changes\\x\\tasks.md'), 'O:\\w\\openspec\\changes\\archive\\x\\tasks.md')
  assert.equal(archiveFallbackPath('O:/w/openspec/changes/x/specs/x/spec.md'), 'O:/w/openspec/changes/archive/x/specs/x/spec.md')
  assert.equal(archiveFallbackPath('/w/openspec/changes/x/design.md'), '/w/openspec/changes/archive/x/design.md')
  assert.equal(archiveFallbackPath('O:\\\\w\\\\openspec\\\\changes\\\\x\\\\tasks.md'), 'O:\\w\\openspec\\changes\\archive\\x\\tasks.md', 'doubled backslashes are normalised first')
})

test('archiveFallbackPath answers an empty string when there is nothing to fall back to', () => {
  assert.equal(archiveFallbackPath('O:/w/openspec/changes/archive/x/tasks.md'), '', 'already archived')
  assert.equal(archiveFallbackPath('O:/w/openspec/specs/x/spec.md'), '', 'not under changes/')
  assert.equal(archiveFallbackPath('O:/w/openspec/changes/tasks.md'), '', 'no change id segment')
  assert.equal(archiveFallbackPath(''), '')
  assert.equal(archiveFallbackPath(null), '')
})

test('a pre-archive and a post-archive path of one file fold into one entry', () => {
  const live = 'O:\\w\\openspec\\changes\\x\\tasks.md'
  const archived = 'O:/w/openspec/changes/archive/x/tasks.md'
  assert.ok(samePath(live, archived))
  assert.ok(samePath(live, 'O:/w/openspec/changes/archive/2026-10-31-x/tasks.md'), 'dated archive folder')
  assert.equal(samePath('O:/w/openspec/changes/x/tasks.md', 'O:/w/openspec/changes/y/tasks.md'), false)
  assert.deepEqual(dedupePaths([live, archived, 'O:/w/openspec/changes/x/design.md']), [live, 'O:/w/openspec/changes/x/design.md'])
  assert.equal(groupByFolder([live, archived]).length, 1)
  assert.deepEqual(groupByFolder([live, archived])[0].files, [live])
})

const SPEC_LIVE = 'O:\\w\\openspec\\specs\\x\\spec.md'
const SPEC_DELTA = 'O:\\w\\openspec\\changes\\x\\specs\\x\\spec.md'

test('groupByFolder gives every folder of a bundle its own label, extending colliding two-segment labels', () => {
  const groups = groupByFolder([SPEC_LIVE, SPEC_DELTA, 'O:/w/openspec/changes/x/tasks.md', 'O:/w/openspec/changes/x/design.md'])
  assert.equal(groups.length, 3)
  const labels = groups.map((g) => g.label)
  assert.equal(new Set(labels.map((l) => l.toLowerCase())).size, 3, `labels must be distinct: ${labels}`)
  assert.equal(shortFolderLabel(groups[0].folder), shortFolderLabel(groups[1].folder), 'the plain labels did collide')
  assert.equal(groups[0].label, 'specs/x')
  assert.equal(groups[1].label, 'changes/x/specs/x')
  assert.equal(groups[2].label, 'changes/x', 'a folder that never collided keeps its short label')
})

test('groupByFolder keeps the short label for every folder when none collide', () => {
  const groups = groupByFolder(['/w/c1/tasks.md', '/w/c2/tasks.md'])
  assert.deepEqual(groups.map((g) => g.label), groups.map((g) => shortFolderLabel(g.folder)))
})

test('the browser headers and the active-file directory indicator disambiguate colliding folders', async () => {
  const { card } = await mountDirective({ file: SPEC_DELTA, file_1: SPEC_LIVE })
  const [open] = find(card, (n) => n.type === sdk.Button)
  open.props.onClick()
  const pane = sdk.host.workspaces.at(-1).render()
  react.__beginRender()
  const tree = pane.type(pane.props)
  const browser = find(tree, (n) => n.props.className === 'rl-browser')[0]
  const headers = find(browser, (n) => n.props.className === 'rl-folder').map((f) => f.props.children)
  assert.equal(new Set(headers).size, 2, `distinct headers: ${headers}`)
  assert.deepEqual(headers, ['changes/x/specs/x', 'specs/x'])
  const dir = find(tree, (n) => n.props.className === 'rl-active-dir')[0]
  assert.equal(dir.props.children, 'changes/x/specs/x', 'the active-file bar uses the same disambiguated label')
})
