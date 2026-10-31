// Standalone tile, clickable chip, session re-bind, Threads filter / jumper, conditional polling.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { find, loadPlugin } from './load-plugin.mjs'
import * as react from './stubs/react.mjs'
import * as sdk from './stubs/plugin-sdk.mjs'

const plugin = await loadPlugin()
const { resolveTargetSession, filterAnnotations, stepThread, pollConditional } = plugin.internals

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
  const { byId } = await register()
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

const shownPath = (tree) => (find(tree, (n) => n.props.className === 'rl-path' && n.props.title)[0] || { props: {} }).props.title || ''
const tabTitles = (tree) => find(tree, (n) => typeof n.props.className === 'string' && n.props.className.startsWith('rl-tab') && n.props.title).map((n) => n.props.title)
const emptyText = (tree) => find(tree, (n) => n.props.className === 'rl-empty').map((n) => JSON.stringify(n.props.children)).join('|')
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
  const input = find(tree, (n) => n.type === sdk.Input)[0]
  assert.equal(input.props.value, '', 'path box cleared too')

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
  assert.deepEqual(tabTitles(tree), [], 'a single document needs no tab strip')
  assert.deepEqual(plugin.internals.sessionRows(rows, 'session-A').map((r) => r.path), ['/A/annotated.md'])
  assert.deepEqual(plugin.internals.sessionRows(rows, ''), [])
})

test('opening a path records it under recent:<chat> and the chat documents, never the global recent list', async () => {
  const { standalone, store, ctx } = await registerScoped()
  sdk.host.focusedStoredSessionId = 'session-A'
  const pane = standalone.render()
  let tree = renderPane(pane)
  const input = find(tree, (n) => n.type === sdk.Input)[0]
  input.props.onChange({ target: { value: '/A/typed.md' } })
  tree = renderPane(pane)
  button(tree, 'open').props.onClick()
  await flush()
  assert.deepEqual(store.get('recent:session-A'), ['/A/typed.md'])
  assert.equal(store.has('recent'), false, 'the global recent key is never written')
  assert.deepEqual(plugin.internals.sessionFilesFor(ctx, 'session-A', []), ['/A/typed.md'])
  assert.deepEqual(recentChips(renderPane(pane)), ['typed.md'])

  sdk.host.focusedStoredSessionId = 'session-B'
  assert.deepEqual(recentChips(renderPane(pane)), [], 'another chat does not see session-A recents')
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
