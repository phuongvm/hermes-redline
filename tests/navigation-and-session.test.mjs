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
