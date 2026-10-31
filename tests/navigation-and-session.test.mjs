// Standalone tile, clickable chip, session re-bind, Threads filter / jumper, conditional polling.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { find, loadPlugin } from './load-plugin.mjs'
import * as react from './stubs/react.mjs'
import * as sdk from './stubs/plugin-sdk.mjs'

const plugin = await loadPlugin()
const { resolveTargetSession, filterAnnotations, stepThread, pollConditional, resolvedTargetPath } = plugin.internals

const FILE = '/w/review.md'
const item = (id, status, extra = {}) => ({ id, kind: 'comment', block: 0, quote: `q-${id}`, note: `n-${id}`, status, ...extra })

async function register(items = [item('a', 'open')]) {
  sdk.__reset()
  react.__reset()
  sdk.__setQueryResult('redline:doc', { content: '# T\n\nBody.\n' })
  sdk.__setQueryResult('redline:ann', { items, sidecarPath: '/home/.hermes/redline/annotations/x-review.md.redline.json' })
  globalThis.document ??= { createElement: () => ({ remove() {} }), head: { appendChild() {} } }
  let entries = []
  const saves = []
  const ctx = {
    rest: async (...args) => { saves.push(args); return {} },
    storage: { get: () => [], set() {} }, onDispose() {},
    registerMany(next) { entries = next },
  }
  plugin.default.register(ctx)
  return { entries, saves, ctx, byId: (id) => entries.find((entry) => entry.id === id) }
}

function renderPane(pane) {
  react.__beginRender()
  return pane.type(pane.props)
}

const button = (tree, label) => find(tree, (n) => n.type === sdk.Button && String(n.props.children) === label)[0]
const sendButton = (tree) => find(tree, (n) => n.type === sdk.Button && String(n.props.children).startsWith('Send '))[0]

test('resolveTargetSession: re-bind beats everything, standalone follows focus, a card keeps its pin', () => {
  assert.equal(resolveTargetSession({ pinnedSessionId: 'A', focusedSessionId: 'B', standalone: false }), 'A')
  assert.equal(resolveTargetSession({ pinnedSessionId: 'A', reboundSessionId: 'B', focusedSessionId: 'C', standalone: false }), 'B')
  assert.equal(resolveTargetSession({ focusedSessionId: 'B', standalone: true }), 'B')
  assert.equal(resolveTargetSession({ pinnedSessionId: 'A', focusedSessionId: 'B', standalone: true }), 'B')
  assert.equal(resolveTargetSession({ standalone: true }), '')
  assert.equal(resolveTargetSession({}), '')
  assert.equal(resolveTargetSession(), '')
})

test('filterAnnotations returns the matching subset and never lists drafts', () => {
  const all = [item('1', 'open'), item('2', 'sent'), item('3', 'resolved'), item('4', 'open', { draft: true }), item('5', 'open')]
  assert.deepEqual(filterAnnotations(all, 'all').map((a) => a.id), ['1', '2', '3', '5'])
  assert.deepEqual(filterAnnotations(all, 'open').map((a) => a.id), ['1', '5'])
  assert.deepEqual(filterAnnotations(all, 'sent').map((a) => a.id), ['2'])
  assert.deepEqual(filterAnnotations(all, 'resolved').map((a) => a.id), ['3'])
  assert.deepEqual(filterAnnotations(undefined, 'open'), [])
})

test('stepThread wraps forward and backward and recovers from an unknown current id', () => {
  const ids = ['a', 'b', 'c']
  assert.equal(stepThread(ids, 'a', 1), 'b')
  assert.equal(stepThread(ids, 'c', 1), 'a')
  assert.equal(stepThread(ids, 'a', -1), 'c')
  assert.equal(stepThread(ids, 'b', -1), 'a')
  assert.equal(stepThread(ids, null, 1), 'a')
  assert.equal(stepThread(ids, 'gone', -1), 'c')
  assert.equal(stepThread([], 'a', 1), null)
  assert.equal(stepThread(['only'], 'only', 1), 'only')
})

test('registers a /redline route and a sidebar tile', async () => {
  const { byId } = await register()
  const page = byId('page')
  assert.equal(page.area, sdk.ROUTES_AREA)
  assert.equal(page.data.path, '/redline')
  const nav = byId('nav')
  assert.equal(nav.area, sdk.SIDEBAR_NAV_AREA)
  assert.equal(nav.order, 60)
  assert.deepEqual(nav.data, { codicon: 'comment-discussion', label: 'Redline', path: '/redline', asTile: true })
  const routed = page.render()
  assert.equal(routed.props.standalone, true)
})

test('the status-bar chip is a button that opens the standalone workspace', async () => {
  const { byId, ctx } = await register()
  plugin.internals.rememberSessionFiles(ctx, 'test-session', ['/w/review.md'])
  const chip = byId('chip').render()
  const tree = chip.type(chip.props)
  assert.equal(tree.type, 'button')
  assert.equal(tree.props.type, 'button')
  assert.match(tree.props.className, /rl-chip/)
  tree.props.onClick()
  const opened = sdk.host.workspaces.at(-1)
  assert.ok(opened, 'chip click opened a workspace')
  assert.equal(renderPane(opened.render()).type, 'div')
  assert.equal(opened.render().props.standalone, true)
})

test('a card-opened pane keeps its pin until "Bind to active chat"; a standalone pane follows focus', async () => {
  const { byId } = await register()
  const [openCard] = find(byId('directive').data.render({ attrs: { file: FILE }, sessionId: 'session-A' }), (n) => n.type === sdk.Button)
  openCard.props.onClick()
  const carded = sdk.host.workspaces.at(-1).render()

  sdk.host.focusedSessionId = 'session-B'
  let tree = renderPane(carded)
  assert.ok(button(tree, 'Bind to active chat'), 'card pane offers the re-bind')
  sendButton(tree).props.onClick()
  assert.equal(sdk.host.submissions.at(-1).sessionId, 'session-A')

  button(renderPane(carded), 'Bind to active chat').props.onClick()
  tree = renderPane(carded)
  assert.ok(find(tree, (n) => n.props.children === 'bound to active chat').length)
  sendButton(tree).props.onClick()
  assert.equal(sdk.host.submissions.at(-1).sessionId, 'session-B')

  const standalone = byId('page').render()
  assert.equal(button(renderPane(standalone), 'Bind to active chat'), undefined)
  sdk.host.focusedSessionId = 'session-C'
  sendButton(renderPane(standalone)).props.onClick()
})

test('a standalone pane submits to the focused chat, or leaves annotations unsent with an error', async () => {
  const { byId, saves } = await register()
  const pane = byId('page').render()
  sdk.host.focusedSessionId = 'session-B'
  sendButton(renderPane(pane)).props.onClick()
  assert.equal(sdk.host.submissions.at(-1).sessionId, 'session-B')
  assert.match(sdk.host.submissions.at(-1).message, /Resolve status in sidecar: \/home\/\.hermes\/redline\/annotations\//)

  const before = saves.length
  sdk.host.focusedSessionId = ''
  sendButton(renderPane(pane)).props.onClick()
  assert.equal(sdk.host.submissions.length, 1)
  assert.equal(saves.length, before, 'nothing saved when there is no target chat')
  assert.match(sdk.host.errors.at(-1), /no active chat.*remain unsent/i)

  sdk.host.focusedSessionId = 'session-B'
  sdk.host.submitResult = false
  sendButton(renderPane(pane)).props.onClick()
  assert.equal(saves.length, before)
  assert.match(sdk.host.errors.at(-1), /target chat is unavailable.*remain unsent/i)
})

test('the Threads bar offers the four filters, Prev/Next and Resolve all', async () => {
  const { byId, saves } = await register([item('a', 'open'), item('b', 'sent'), item('c', 'resolved')])
  const pane = byId('page').render()
  // The file is chosen through the recent list; type it in via the card path instead for a fixed file.
  const [openCard] = find(byId('directive').data.render({ attrs: { file: FILE }, sessionId: 's' }), (n) => n.type === sdk.Button)
  openCard.props.onClick()
  const carded = sdk.host.workspaces.at(-1).render()
  const tree = renderPane(carded)
  const bar = find(tree, (n) => n.props.className === 'rl-threads')[0]
  assert.ok(bar, 'threads bar present when there are annotations')
  const labels = find(bar, (n) => typeof n.props.children === 'string').map((n) => n.props.children)
  for (const label of ['Threads', 'All', 'Open', 'Sent', 'Resolved', 'Prev', 'Next', 'Resolve all']) assert.ok(labels.includes(label), label)

  find(bar, (n) => n.props.children === 'Sent')[0].props.onClick()
  const afterFilter = renderPane(carded)
  const visibleMarkers = find(afterFilter, (n) => typeof n.props.className === 'string' && n.props.className.startsWith('rl-marker'))
  assert.deepEqual(visibleMarkers.map((m) => m.props.title), ['q-b'], 'only the sent thread keeps a marker')

  button(renderPane(carded), 'Resolve all').props.onClick()
  const [, call] = saves.at(-1)
  assert.deepEqual(call.body.items.map((a) => a.status), ['resolved', 'resolved', 'resolved'])
  assert.ok(call.body.items.filter((a) => a.id !== 'c').every((a) => a.closed_by === 'reviewer'))
  assert.ok(pane)
})

test('pollConditional sends since_mtime once cached, reuses data on unchanged and flags real changes', async () => {
  const cache = new Map()
  const urls = []
  const replies = [
    { mtimeNs: 5, unchanged: false, content: 'v1' },
    { mtimeNs: 5, unchanged: true },
    { mtimeNs: 9, unchanged: false, content: 'v2' },
  ]
  const ctx = { rest: async (url) => { urls.push(url); return replies.shift() } }
  let changed = 0
  const first = await pollConditional(ctx, cache, 'doc:/a', '/doc?path=%2Fa', () => { changed += 1 })
  assert.equal(first.content, 'v1')
  const second = await pollConditional(ctx, cache, 'doc:/a', '/doc?path=%2Fa', () => { changed += 1 })
  assert.equal(second.content, 'v1', 'unchanged reuses the cached payload')
  const third = await pollConditional(ctx, cache, 'doc:/a', '/doc?path=%2Fa', () => { changed += 1 })
  assert.equal(third.content, 'v2')
  assert.deepEqual(urls, ['/doc?path=%2Fa', '/doc?path=%2Fa&since_mtime=5', '/doc?path=%2Fa&since_mtime=5'])
  assert.equal(changed, 1, 'only the real change fires onChange; the first load does not')
})

test('pollConditional stays quiet when a full reply carries the same content (float64-rounded mtime idle poll)', async () => {
  const cache = new Map()
  const replies = [
    { mtimeNs: 1793456789123456800, unchanged: false, content: 'same' },
    { mtimeNs: 1793456789123456789, unchanged: false, content: 'same' },
    { mtimeNs: 1793456789123456800, unchanged: false, content: 'same' },
    { mtimeNs: 1793456789999999999, unchanged: false, content: 'edited' },
  ]
  const ctx = { rest: async () => replies.shift() }
  let changed = 0
  for (let i = 0; i < 4; i += 1) {
    const res = await pollConditional(ctx, cache, 'doc:/a', '/doc?path=%2Fa', () => { changed += 1 })
    assert.equal(res.content, i === 3 ? 'edited' : 'same')
  }
  assert.equal(changed, 1, 'only the genuine content edit flashes Updated')
})

test('pollConditional never flags a content-less reply (annotations) because only /doc text edits flash Updated', async () => {
  const cache = new Map()
  const replies = [{ mtimeNs: 1, unchanged: false, items: [] }, { mtimeNs: 2, unchanged: false, items: [{ id: 'a' }] }]
  const ctx = { rest: async () => replies.shift() }
  let changed = 0
  await pollConditional(ctx, cache, 'ann:/a', '/annotations?path=%2Fa', () => { changed += 1 })
  await pollConditional(ctx, cache, 'ann:/a', '/annotations?path=%2Fa', () => { changed += 1 })
  assert.equal(changed, 0)
})


// ------------------------------------------------------------------ session-scoped documents

const flush = () => new Promise((resolve) => setImmediate(resolve))

async function registerScoped({ recent = [], items = [] } = {}) {
  sdk.__reset()
  react.__reset()
  sdk.__setQueryResult('redline:doc', { content: '# T\n\nBody.\n' })
  sdk.__setQueryResult('redline:ann', { items, sidecarPath: '/home/.hermes/redline/annotations/x.redline.json' })
  sdk.__setQueryResult('redline:recent', { items: recent })
  globalThis.document ??= { createElement: () => ({ remove() {} }), head: { appendChild() {} } }
  let entries = []
  const calls = []
  const store = new Map()
  const ctx = {
    rest: async (...args) => { calls.push(args); return {} },
    storage: { get: (key) => store.get(key), set: (key, value) => { store.set(key, value) } },
    onDispose() {},
    registerMany(next) { entries = next },
  }
  plugin.default.register(ctx)
  const byId = (id) => entries.find((entry) => entry.id === id)
  return { ctx, calls, store, byId, directive: byId('directive').data.render, standalone: byId('page') }
}

const shownPath = (tree) => (find(tree, (n) => n.props.className === 'rl-active')[0] || { props: {} }).props.title || ''
const tabTitles = (tree) => find(tree, (n) => typeof n.props.className === 'string' && n.props.className.startsWith('rl-tab') && n.props.title).map((n) => n.props.title)
const emptyText = (tree) => find(tree, (n) => n.props.className === 'rl-empty').map((n) => JSON.stringify(n.props.children)).join('|')
const toggleButton = (tree) => find(tree, (n) => n.type === sdk.Button && n.props.className === 'rl-browser-toggle')[0]
const recentChips = (tree) => find(tree, (n) => n.props.className === 'rl-chip' && n.type === sdk.Button).map((n) => n.key)

test('a ::redline directive registers its files against the chat that rendered it', async () => {
  const { directive, store, ctx } = await registerScoped()
  directive({ attrs: { file: '/A/doc1.md', file_1: '/A/doc2.md' }, sessionId: 'session-A' })
  directive({ attrs: { file: '/B/docB.md' }, sessionId: 'session-B' })
  directive({ attrs: { file: '/A/doc1.md' }, sessionId: null })
  await flush()
  assert.deepEqual(plugin.internals.SESSION_BUNDLES.get('session-A'), ['/A/doc1.md', '/A/doc2.md'])
  assert.deepEqual(store.get('session-files:session-A'), ['/A/doc1.md', '/A/doc2.md'])
  assert.deepEqual(plugin.internals.SESSION_BUNDLES.get('session-B'), ['/B/docB.md'])
  assert.deepEqual(plugin.internals.$sessionBundles.get()['session-A'], ['/A/doc1.md', '/A/doc2.md'])
  assert.deepEqual(plugin.internals.sessionFilesFor(ctx, 'session-A', []), ['/A/doc1.md', '/A/doc2.md'])
  assert.deepEqual(plugin.internals.sessionFilesFor(ctx, '', []), [])
})

test('the side pane shows the focused chat documents and switches when the chat changes', async () => {
  const { directive, standalone } = await registerScoped()
  directive({ attrs: { file: '/A/doc1.md', file_1: '/A/doc2.md' }, sessionId: 'session-A' })
  directive({ attrs: { file: '/B/docB.md' }, sessionId: 'session-B' })
  await flush()
  const pane = standalone.render()

  sdk.host.focusedStoredSessionId = 'session-A'
  let tree = renderPane(pane)
  assert.equal(shownPath(tree), '/A/doc1.md')
  assert.deepEqual(tabTitles(tree), ['/A/doc1.md', '/A/doc2.md'])

  sdk.host.focusedStoredSessionId = 'session-B'
  tree = renderPane(pane)
  assert.equal(shownPath(tree), '/B/docB.md')
  assert.ok(!tabTitles(tree).some((t) => t.startsWith('/A/')), 'no tab of the other chat')
  sendButton(tree).props.onClick?.()
})

test('switching to a chat with no documents clears the pane and leaks nothing from other chats', async () => {
  const stray = [
    { path: '/old/redline_cutover.py', sidecarPath: '/h/1.json', openCount: 0 },
    { path: '/old/spec.md', sidecarPath: '/h/2.json', openCount: 0, sessionId: 'session-A' },
  ]
  const { directive, standalone, store } = await registerScoped({ recent: stray })
  store.set('recent', ['/legacy/global.md'])
  directive({ attrs: { file: '/A/docA.md' }, sessionId: 'session-A' })
  await flush()
  const pane = standalone.render()

  sdk.host.focusedStoredSessionId = 'session-A'
  assert.equal(shownPath(renderPane(pane)), '/A/docA.md')

  sdk.host.focusedStoredSessionId = 'session-empty'
  const tree = renderPane(pane)
  assert.equal(shownPath(tree), '', 'active document cleared')
  assert.deepEqual(tabTitles(tree), [])
  assert.deepEqual(recentChips(tree), [], 'global recent chips are never shown')
  assert.doesNotMatch(emptyText(tree), /redline_cutover|spec\.md|docA|global\.md|Recently annotated/)
  assert.match(emptyText(tree), /No documents to review in this session\./)
  assert.equal(find(tree, (n) => n.type === sdk.Input).length, 0, 'no manual path box')

  sdk.host.focusedStoredSessionId = 'session-A'
  assert.equal(shownPath(renderPane(pane)), '/A/docA.md', 'switching back restores the chat documents')
})

test('the pane follows the runtime and active session ids when no stored id is focused', async () => {
  const { directive, standalone } = await registerScoped()
  directive({ attrs: { file: '/R/run.md' }, sessionId: 'runtime-1' })
  directive({ attrs: { file: '/C/act.md' }, sessionId: 'active-1' })
  await flush()
  const pane = standalone.render()
  sdk.host.focusedSessionId = 'runtime-1'
  assert.equal(shownPath(renderPane(pane)), '/R/run.md')
  assert.equal(plugin.internals.currentFocusedSessionId(), 'runtime-1')
  sdk.host.focusedSessionId = ''
  sdk.host.activeSessionId = 'active-1'
  assert.equal(shownPath(renderPane(pane)), '/C/act.md')
  sdk.host.focusedStoredSessionId = 'stored-wins'
  assert.equal(plugin.internals.currentFocusedSessionId(), 'stored-wins')
})

test('a card-opened pane keeps its own documents until the user switches chats, then follows the new chat', async () => {
  const { directive, byId } = await registerScoped()
  sdk.host.focusedStoredSessionId = 'session-A'
  directive({ attrs: { file: '/A/doc1.md', file_1: '/A/doc2.md' }, sessionId: 'session-A' })
  directive({ attrs: { file: '/B/docB.md' }, sessionId: 'session-B' })
  await flush()
  const [openCard] = find(directive({ attrs: { file: '/A/doc1.md', file_1: '/A/doc2.md' }, sessionId: 'session-A' }), (n) => n.type === sdk.Button)
  openCard.props.onClick()
  const carded = sdk.host.workspaces.at(-1).render()

  let tree = renderPane(carded)
  assert.equal(shownPath(tree), '/A/doc1.md')
  sendButton(tree).props.onClick?.()

  sdk.host.focusedStoredSessionId = 'session-B'
  tree = renderPane(carded)
  assert.equal(shownPath(tree), '/B/docB.md')
  assert.ok(!tabTitles(tree).some((t) => t.startsWith('/A/')))
  assert.ok(byId('chip'))

  sdk.host.focusedStoredSessionId = 'session-empty'
  assert.equal(shownPath(renderPane(carded)), '')
})

test('the recent query is scoped to the chat and a foreign row from an unfiltered gateway is dropped', async () => {
  const rows = [
    { path: '/A/annotated.md', sidecarPath: '/h/a.json', openCount: 2, sessionId: 'session-A' },
    { path: '/old/unscoped.md', sidecarPath: '/h/u.json', openCount: 1 },
    { path: '/B/other.md', sidecarPath: '/h/b.json', openCount: 1, sessionId: 'session-B' },
  ]
  const { standalone } = await registerScoped({ recent: rows })
  sdk.host.focusedStoredSessionId = 'session-A'
  const tree = renderPane(standalone.render())
  assert.equal(shownPath(tree), '/A/annotated.md', 'a backend row of this chat opens automatically')
  assert.deepEqual(tabTitles(tree), [], 'a single document keeps the file browser closed until toggled')
  toggleButton(tree).props.onClick()
  assert.deepEqual(tabTitles(renderPane(standalone.render())), ['/A/annotated.md'], 'the toggle opens the browser with the one document')
  assert.deepEqual(plugin.internals.sessionRows(rows, 'session-A').map((r) => r.path), ['/A/annotated.md'])
  assert.deepEqual(plugin.internals.sessionRows(rows, ''), [])
})

test('the compact header has no title, raw path, manual path box, open button or recent chips', async () => {
  const { directive, standalone, store } = await registerScoped()
  store.set('recent:session-A', ['/A/old.md'])
  directive({ attrs: { file: '/A/doc1.md', file_1: '/A/doc2.md' }, sessionId: 'session-A' })
  await flush()
  sdk.host.focusedStoredSessionId = 'session-A'
  const tree = renderPane(standalone.render())
  const head = find(tree, (n) => n.props.className === 'rl-head')[0]
  assert.ok(head, 'header present')
  assert.equal(find(tree, (n) => n.props.className === 'rl-title').length, 0)
  assert.equal(find(tree, (n) => n.props.className === 'rl-path').length, 0)
  assert.equal(find(tree, (n) => n.type === sdk.Input).length, 0)
  assert.equal(button(tree, 'open'), undefined)
  assert.deepEqual(recentChips(tree), [])
  assert.equal(find(head, (n) => typeof n.props.className === 'string' && n.props.className.startsWith('rl-tab')).length, 0, 'no flat pill tabs in the header')
  const active = find(head, (n) => n.props.className === 'rl-active')[0]
  assert.equal(active.props.title, '/A/doc1.md', 'header shows the selected file with its full path as title')
  assert.ok(toggleButton(head), 'header carries the browser toggle')
  const browser = find(tree, (n) => n.props.className === 'rl-browser')[0]
  const tabs = find(browser, (n) => typeof n.props.className === 'string' && n.props.className.startsWith('rl-tab') && n.props.title)
  assert.deepEqual(tabs.map((t) => t.props.title), ['/A/doc1.md', '/A/doc2.md'], 'session documents live in the file browser')
  assert.deepEqual(tabs.map((t) => t.props.children), ['doc1.md', 'doc2.md'])
  assert.match(plugin.internals.CSS, /\.rl-tab\{[^}]*max-width:220px[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/)
})

test('escaped, native and forward-slash spellings of one document make one tab', async () => {
  const { directive, standalone, store, ctx } = await registerScoped()
  directive({ attrs: { file: 'O:\\\\w\\\\a.md', file_1: 'O:\\\\w\\\\b.md' }, sessionId: 'session-A' })
  directive({ attrs: { file: 'O:\\w\\a.md', file_1: 'O:/w/b.md', file_2: 'O:/w/c.md' }, sessionId: 'session-A' })
  await flush()
  assert.equal(plugin.internals.SESSION_BUNDLES.get('session-A').length, 3)
  assert.ok(plugin.internals.SESSION_BUNDLES.get('session-A').every((f) => !f.includes('\\\\')), 'no doubled backslashes kept')
  // a persisted copy written before the fix is folded on read
  store.set('session-files:session-B', ['O:\\\\w\\\\a.md', 'O:\\w\\a.md', 'O:/w/a.md'])
  assert.deepEqual(plugin.internals.sessionFilesFor(ctx, 'session-B', [{ path: 'o:/W/A.md', sessionId: 'session-B' }]), ['O:\\w\\a.md'])
  sdk.host.focusedStoredSessionId = 'session-A'
  const tree = renderPane(standalone.render())
  assert.equal(tabTitles(tree).length, 3)
  assert.equal(new Set(tabTitles(tree).map(plugin.internals.pathKey)).size, 3)
})

test('opening files records them under the chat documents only through directives, never a global recent list', async () => {
  const { directive, store, ctx } = await registerScoped()
  directive({ attrs: { file: '/A/typed.md' }, sessionId: 'session-A' })
  await flush()
  assert.equal(store.has('recent'), false, 'the global recent key is never written')
  assert.deepEqual(plugin.internals.sessionFilesFor(ctx, 'session-A', []), ['/A/typed.md'])
})

test('saving annotations tags the sidecar with the chat in view', async () => {
  const { standalone, calls, directive } = await registerScoped({ items: [item('a', 'open')] })
  directive({ attrs: { file: '/A/doc1.md' }, sessionId: 'session-A' })
  await flush()
  sdk.host.focusedStoredSessionId = 'session-A'
  const pane = standalone.render()
  button(renderPane(pane), 'Resolve all').props.onClick()
  const [url, options] = calls.at(-1)
  assert.equal(url, '/annotations')
  assert.equal(options.body.path, '/A/doc1.md')
  assert.equal(options.body.sessionId, 'session-A')
})


// ------------------------------------------------------------------ file browser toggle

const named = (tree, cls) => find(tree, (n) => n.props.className === cls)

test('the file browser opens by default for two or more documents and stays closed until toggled for one', async () => {
  const { directive, standalone } = await registerScoped()
  directive({ attrs: { file: '/A/doc1.md', file_1: '/A/doc2.md' }, sessionId: 'session-A' })
  directive({ attrs: { file: '/B/docB.md' }, sessionId: 'session-B' })
  await flush()
  const pane = standalone.render()

  sdk.host.focusedStoredSessionId = 'session-A'
  assert.equal(named(renderPane(pane), 'rl-browser').length, 1, 'two documents: open by default')
  assert.equal(toggleButton(renderPane(pane)).props['aria-expanded'], true)

  toggleButton(renderPane(pane)).props.onClick()
  assert.equal(named(renderPane(pane), 'rl-browser').length, 0, 'toggled closed')
  assert.equal(named(renderPane(pane), 'rl-browser').length, 0, 'stays closed across renders')
  assert.equal(toggleButton(renderPane(pane)).props['aria-expanded'], false)
  assert.equal(shownPath(renderPane(pane)), '/A/doc1.md', 'the active file bar stays when the browser is closed')

  toggleButton(renderPane(pane)).props.onClick()
  assert.equal(named(renderPane(pane), 'rl-browser').length, 1, 'toggled open again')
})

test('clicking a file in the browser switches the active file bar and keeps the browser open', async () => {
  const { directive, standalone } = await registerScoped()
  directive({ attrs: { file: '/A/doc1.md', file_1: '/A/doc2.md' }, sessionId: 'session-A' })
  await flush()
  sdk.host.focusedStoredSessionId = 'session-A'
  const pane = standalone.render()
  const second = find(renderPane(pane), (n) => typeof n.props.className === 'string' && n.props.className.startsWith('rl-tab') && n.props.title === '/A/doc2.md')[0]
  second.props.onClick()
  const tree = renderPane(pane)
  assert.equal(shownPath(tree), '/A/doc2.md')
  assert.equal(named(tree, 'rl-browser').length, 1)
})

// ------------------------------------------------------------------ status-bar chip

const chipTree = (byId) => {
  const chip = byId('chip').render()
  return chip.type(chip.props)
}
const chipCount = (byId) => find(chipTree(byId), (n) => n.type === 'b')[0].props.children

test('the chip hides when the focused session has no reviewable document', async () => {
  const { byId, directive } = await registerScoped()
  directive({ attrs: { file: '/A/doc1.md' }, sessionId: 'session-A' })
  await flush()
  sdk.host.focusedStoredSessionId = 'session-empty'
  assert.equal(chipTree(byId), null)
})

test('the chip shows the comment-discussion icon and a bold count of the focused session documents', async () => {
  const { byId, directive } = await registerScoped()
  directive({ attrs: { file: '/A/doc1.md', file_1: '/A/doc2.md', file_2: '/A/doc3.md' }, sessionId: 'session-A' })
  directive({ attrs: { file: '/B/docB.md' }, sessionId: 'session-B' })
  await flush()

  sdk.host.focusedStoredSessionId = 'session-A'
  const tree = chipTree(byId)
  assert.equal(tree.type, 'button')
  assert.match(tree.props.className, /rl-chip/)
  assert.equal(find(tree, (n) => n.type === sdk.Codicon)[0].props.name, 'comment-discussion')
  assert.equal(chipCount(byId), '3')

  sdk.host.focusedStoredSessionId = 'session-B'
  assert.equal(chipCount(byId), '1', 'the count follows the focused session')
})

test('the chip follows stored, runtime and active ids in that order and subscribes to the session recent query', async () => {
  const { byId, directive } = await registerScoped()
  directive({ attrs: { file: '/R/run.md', file_1: '/R/run2.md' }, sessionId: 'runtime-1' })
  directive({ attrs: { file: '/C/act.md' }, sessionId: 'active-1' })
  await flush()
  sdk.host.focusedSessionId = 'runtime-1'
  assert.equal(chipCount(byId), '2')
  assert.deepEqual(sdk.host.queryKeys.at(-1), ['redline:recent', 'runtime-1'])
  sdk.host.focusedSessionId = ''
  sdk.host.activeSessionId = 'active-1'
  assert.equal(chipCount(byId), '1')
  assert.deepEqual(sdk.host.queryKeys.at(-1), ['redline:recent', 'active-1'])
  sdk.host.focusedStoredSessionId = 'runtime-1'
  assert.equal(chipCount(byId), '2')
  assert.deepEqual(sdk.host.queryKeys.at(-1), ['redline:recent', 'runtime-1'])
})

test('the chip counts backend rows of the session once alongside its registered documents', async () => {
  const rows = [
    { path: '/A/doc1.md', sidecarPath: '/h/1.json', openCount: 1, sessionId: 'session-A' },
    { path: '/A/annotated.md', sidecarPath: '/h/2.json', openCount: 1, sessionId: 'session-A' },
    { path: '/B/other.md', sidecarPath: '/h/3.json', openCount: 1, sessionId: 'session-B' },
  ]
  const { byId, directive } = await registerScoped({ recent: rows })
  directive({ attrs: { file: '/A/doc1.md' }, sessionId: 'session-A' })
  await flush()
  sdk.host.focusedStoredSessionId = 'session-A'
  assert.equal(chipCount(byId), '2', 'doc1 counted once, annotated.md from the backend, no foreign row')
  sdk.host.focusedStoredSessionId = 'session-C'
  assert.equal(chipTree(byId), null)
})

test('the session recent query is limited to 32 rows and scoped to the session', async () => {
  const { ctx } = await registerScoped()
  const urls = []
  const probe = { ...ctx, rest: async (url) => { urls.push(url); return {} } }
  const options = plugin.internals.recentSessionQuery(probe, 'session A')
  assert.deepEqual(options.queryKey, ['redline:recent', 'session A'])
  assert.equal(options.enabled, true)
  await options.queryFn()
  assert.deepEqual(urls, ['/recent?limit=32&session_id=session%20A'])
  assert.equal(plugin.internals.recentSessionQuery(probe, '').enabled, false)
})


// ------------------------------------------------------------------ archived OpenSpec changes
// A document recorded under openspec/changes/<id>/... is later archived to openspec/changes/archive/<id>/...

const LIVE_DOC = 'O:/w/openspec/changes/arch1/tasks.md'
const ARCHIVED_DOC = 'O:/w/openspec/changes/archive/arch1/tasks.md'
const docUrl = (path) => `/doc?path=${encodeURIComponent(path)}`

test('pollConditional retries an archived location when the pre-archive path cannot be read, and remembers it', async () => {
  const cache = new Map()
  const urls = []
  const ctx = {
    rest: async (url) => {
      urls.push(url)
      if (url.includes(encodeURIComponent(LIVE_DOC))) throw new Error('404 file not found')
      return { mtimeNs: 7, unchanged: false, content: 'archived text', path: ARCHIVED_DOC }
    },
  }
  const first = await pollConditional(ctx, cache, `doc:${LIVE_DOC}`, docUrl(LIVE_DOC))
  assert.equal(first.content, 'archived text')
  assert.deepEqual(urls, [docUrl(LIVE_DOC), docUrl(ARCHIVED_DOC)])
  assert.equal(resolvedTargetPath(LIVE_DOC), ARCHIVED_DOC)

  urls.length = 0
  await pollConditional(ctx, cache, `doc:${LIVE_DOC}`, docUrl(LIVE_DOC))
  assert.deepEqual(urls, [`${docUrl(ARCHIVED_DOC)}&since_mtime=7`], 'later polls go straight to the archived file')
})

test('pollConditional rethrows the original error when no archived location answers or none exists', async () => {
  const boom = new Error('404 original')
  await assert.rejects(pollConditional({ rest: async () => { throw boom } }, new Map(), 'doc:a', docUrl('O:/w/openspec/changes/zzz/tasks.md')), (e) => e === boom)
  const urls = []
  await assert.rejects(pollConditional({ rest: async (u) => { urls.push(u); throw boom } }, new Map(), 'doc:b', docUrl('O:/w/openspec/specs/zzz/spec.md')), (e) => e === boom)
  assert.equal(urls.length, 1, 'a path with no archive candidate is asked once')
  assert.equal(resolvedTargetPath('O:/w/openspec/specs/zzz/spec.md'), 'O:/w/openspec/specs/zzz/spec.md', 'unresolved paths resolve to themselves')
})

test('annotations polling follows the archived path too', async () => {
  const urls = []
  const ctx = { rest: async (url) => { urls.push(url); if (url.includes(encodeURIComponent('/changes/arch2/'))) throw new Error('404'); return { mtimeNs: 3, items: [] } } }
  const res = await pollConditional(ctx, new Map(), 'ann:x', `/annotations?path=${encodeURIComponent('O:/w/openspec/changes/arch2/design.md')}`)
  assert.deepEqual(res.items, [])
  assert.equal(urls[1], `/annotations?path=${encodeURIComponent('O:/w/openspec/changes/archive/arch2/design.md')}`)
})

test('saving annotations posts to the archived file that actually exists', async () => {
  const live = 'O:/w/openspec/changes/arch3/proposal.md'
  const archived = 'O:/w/openspec/changes/archive/arch3/proposal.md'
  const { byId, saves } = await register([item('a', 'open')])
  await pollConditional({ rest: async (url) => { if (!url.includes('archive')) throw new Error('404'); return { mtimeNs: 1, content: 'x' } } },
    new Map(), `doc:${live}`, docUrl(live))
  const [openCard] = find(byId('directive').data.render({ attrs: { file: live }, sessionId: 's' }), (n) => n.type === sdk.Button)
  openCard.props.onClick()
  button(renderPane(sdk.host.workspaces.at(-1).render()), 'Resolve all').props.onClick()
  const [url, call] = saves.at(-1)
  assert.equal(url, '/annotations')
  assert.equal(call.body.path, archived)
})
