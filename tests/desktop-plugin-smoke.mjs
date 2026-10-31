#!/usr/bin/env node
/**
 * Headless smoke harness for desktop/plugin.js.
 *
 * Static runtime-loader invariants (the plugin is evaluated as one uncompiled ESM module):
 *   - imports only @hermes/plugin-sdk, react, react/jsx-runtime
 *   - no raw JSX, no fetch, no ctx.rest.post/put/delete/patch shorthands
 *   - no dangerouslySetInnerHTML, no literal http:// or https:// anywhere (comments included)
 * Dynamic checks load the file the way the Desktop loader does and inspect what it registers.
 *
 * Run: node tests/desktop-plugin-smoke.mjs     Exit 0 = pass, 1 = failure.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadPlugin } from './load-plugin.mjs'
import * as react from './stubs/react.mjs'
import * as sdk from './stubs/plugin-sdk.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, '../desktop/plugin.js'), 'utf8')

let passed = 0
const failures = []
function check(condition, name, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(name)
    console.error(`  FAIL  ${name}${detail ? `: ${detail}` : ''}`)
  }
}

console.log('=== Smoke harness: desktop/plugin.js ===\n')
console.log('[static] runtime-loader safety invariants')

const specs = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
const allowed = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
check(specs.length > 0, `found ${specs.length} import(s)`)
check(specs.every((s) => allowed.has(s)), 'no disallowed imports', specs.filter((s) => !allowed.has(s)).join(', '))
check(!/\brequire\(|module\.exports/.test(source), 'no CommonJS')
check(source.includes('export default'), 'has a default export')

const rawJsx = source.split('\n').filter((line) => {
  const t = line.trim()
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.includes('jsx(') || t.includes('jsxs(')) return false
  return /<[A-Z]/.test(t.replace(/(['"`])(?:(?!\1)[^\\]|\\.)*\1/g, ''))
})
check(rawJsx.length === 0, 'no raw JSX outside jsx()/jsxs()', rawJsx[0] && rawJsx[0].trim())

check(!/\bfetch\s*\(/.test(source) && !source.includes('window.fetch'), 'no fetch')
for (const verb of ['post', 'put', 'delete', 'patch']) check(!source.includes(`ctx.rest.${verb}`), `no ctx.rest.${verb}`)
check(!source.includes('dangerouslySetInnerHTML'), 'no dangerouslySetInnerHTML')
check(!/https?:\/\//.test(source), 'no literal http:// or https:// string anywhere')
check(source.includes("method: 'POST'"), 'mutations use ctx.rest(path, { method })')

console.log('\n[dynamic] registration through the loader')
const plugin = await loadPlugin()
sdk.__reset()
react.__reset()
globalThis.document ??= { createElement: () => ({ remove() {} }), head: { appendChild() {} } }
let entries = []
plugin.default.register({ rest: async () => ({}), storage: { get: () => [], set() {} }, onDispose() {}, registerMany(next) { entries = next } })
const byId = (id) => entries.find((e) => e.id === id)

check(plugin.default.id === 'redline', 'plugin id is redline')
check(!!byId('chip') && byId('chip').area === sdk.STATUSBAR_AREAS.right, 'statusbar chip registered')
check(byId('page') && byId('page').area === sdk.ROUTES_AREA && byId('page').data.path === '/redline', 'ROUTES_AREA /redline registered')
check(byId('nav') && byId('nav').area === sdk.SIDEBAR_NAV_AREA && byId('nav').data.asTile === true, 'SIDEBAR_NAV_AREA entry has asTile: true')
check(byId('directive') && byId('directive').data.name === 'redline', 'transcript directive registered')
const chipTree = byId('chip').render()
check(chipTree.type(chipTree.props) === null, 'chip renders nothing while the focused session has no reviewable document')
sdk.host.focusedSessionId = 'smoke-session'
byId('directive').data.render({ attrs: { file: '/smoke/a.md', file_1: '/smoke/b.md' }, sessionId: 'smoke-session' })
await new Promise((resolve) => setImmediate(resolve))
const chip = chipTree.type(chipTree.props)
check(chip && chip.type === 'button' && chip.props.type === 'button', 'chip renders a <button> once the session has documents')
check(chip && chip.props.children.some((c) => c && c.type === sdk.Codicon && c.props.name === 'comment-discussion'), 'chip uses the comment-discussion codicon')
check(chip && chip.props.children.some((c) => c && c.type === 'b' && c.props.children === '2'), 'chip shows the focused session document count in bold')
check(/\.rl-browser\{[^}]*overflow-y:auto/.test(plugin.internals.CSS), 'file browser CSS scrolls vertically')
for (const name of ['parentFolder', 'groupByFolder', 'shortFolderLabel', 'recentSessionQuery']) {
  check(typeof plugin.internals[name] === 'function', `helper ${name} is exported`)
}

const internals = plugin.internals
check(internals.__proto__ === Object.prototype && plugin.__test === plugin.internals, '__test aliases internals')
for (const name of ['fileBasename', 'parseBundleFiles', 'splitMarkdownBlocks', 'codeSelectionFromRange', 'buildBatchMessage',
  'resolveTargetSession', 'filterAnnotations', 'stepThread']) {
  check(typeof internals[name] === 'function', `helper ${name} is exported`)
}
check(internals.CODE_EXT.includes('.ps1') && internals.MD_EXT.length === 2, 'extension sets exported')

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.error(`FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
