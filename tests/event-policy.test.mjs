import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { after, test } from 'node:test'
import ts from 'typescript'
import * as vue from 'vue'

const require = createRequire(import.meta.url)
const { parse, compileScript } = require('vue/compiler-sfc')
const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
after(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow })
function loadModule(source, resolveImport = require) {
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(resolveImport, module, module.exports)
  return module.exports
}
const apiModule = loadModule(readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'))
const policyModule = loadModule(readFileSync(new URL('../src/event-policy.ts', import.meta.url), 'utf8'))
const { descriptor } = parse(readFileSync(new URL('../src/components/EventPolicySettings.vue', import.meta.url), 'utf8'))
const script = compileScript(descriptor, { id: 'event-policy-contract' }).content
function mount(t) {
  const unmount = []
  const emitted = []
  const component = loadModule(script, name => {
    if (name === 'vue') return { ...vue, onMounted: () => {}, onBeforeUnmount: fn => unmount.push(fn) }
    if (name === '../api') return apiModule
    if (name === '../event-policy') return policyModule
    if (name === 'lucide-vue-next') return {}
    throw new Error(`Unexpected import: ${name}`)
  }).default
  const scope = vue.effectScope()
  const state = scope.run(() => component.setup({}, { expose() {}, emit: (name, value) => emitted.push([name, value]) }))
  t.after(() => { for (const fn of unmount) fn(); scope.stop() })
  return { state, emitted, unmount }
}
const policy = (kinds = [], hours = 24) => ({ tetragon_ignored_kinds: kinds, scan_summary_retention_hours: hours })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('failed or malformed initial reads never enable a default-overwriting save', async t => {
  const { state, emitted } = mount(t)
  let calls = 0
  globalThis.fetch = async () => { calls++; return json({ error: '读取失败' }, 503) }
  await state.loadPolicy()
  assert.equal(state.policy.value, null)
  assert.equal(state.canSave.value, false)
  await state.savePolicy()
  assert.equal(calls, 1)
  assert.match(state.error.value, /读取事件策略失败/)
  globalThis.fetch = async () => json({ tetragon_ignored_kinds: [], scan_summary_retention_hours: 72 })
  await state.loadPolicy()
  assert.equal(state.policy.value, null)
  assert.equal(state.canSave.value, false)
  assert.match(state.error.value, /响应无效/)
  assert.deepEqual(emitted, [])
})

test('read uses persisted policy and shortcuts preserve other selected kinds until cleared', async t => {
  const { state } = mount(t)
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/settings/event-policy')
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.method, undefined)
    return json(policy(['process_lsm'], 12))
  }
  await state.loadPolicy()
  assert.equal(state.retentionHours.value, 12)
  assert.deepEqual([...state.ignoredKinds.value], ['process_lsm'])
  assert.equal(state.dirty.value, false)
  state.ignoreRoutineEvents()
  state.ignoreRoutineEvents()
  assert.deepEqual([...state.ignoredKinds.value], ['process_lsm', 'process_exec', 'process_exit'])
  assert.equal(state.canSave.value, true)
  state.clearIgnoredKinds()
  assert.deepEqual([...state.ignoredKinds.value], [])
  assert.deepEqual([...state.policy.value.tetragon_ignored_kinds], ['process_lsm'])
})

test('save sends exact PUT contract, blocks overlapping actions and adopts server confirmation', async t => {
  const { state, emitted } = mount(t)
  globalThis.fetch = async () => json(policy())
  await state.loadPolicy()
  state.ignoreRoutineEvents()
  state.retentionHours.value = 12
  let finish
  let calls = 0
  globalThis.fetch = (url, options) => {
    calls++
    assert.equal(url, '/api/settings/event-policy')
    assert.equal(options.method, 'PUT')
    assert.equal(options.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(options.body), policy(['process_exec', 'process_exit'], 12))
    return new Promise(resolve => { finish = resolve })
  }
  const saving = state.savePolicy()
  assert.equal(state.saving.value, true)
  assert.equal(state.canSave.value, false)
  await state.savePolicy()
  state.clearIgnoredKinds()
  assert.deepEqual([...state.ignoredKinds.value], ['process_exec', 'process_exit'])
  assert.equal(calls, 1)
  finish(json(policy(['process_exit', 'process_exec'], 24)))
  await saving
  assert.equal(state.retentionHours.value, 24)
  assert.deepEqual([...state.ignoredKinds.value], ['process_exec', 'process_exit'])
  assert.equal(state.dirty.value, false)
  assert.equal(state.canSave.value, false)
  assert.match(state.message.value, /全局生效/)
  assert.deepEqual(emitted, [['saved', policy(['process_exec', 'process_exit'])]])
})

test('save errors and malformed confirmation retain edits without claiming success', async t => {
  const { state, emitted } = mount(t)
  globalThis.fetch = async () => json(policy())
  await state.loadPolicy()
  state.ignoreRoutineEvents()
  state.retentionHours.value = 12
  globalThis.fetch = async () => json({ error: '拒绝写入' }, 403)
  await state.savePolicy()
  assert.match(state.error.value, /拒绝写入/)
  assert.equal(state.retentionHours.value, 12)
  assert.equal(state.canSave.value, true)
  assert.deepEqual(state.policy.value, policy())
  globalThis.fetch = async () => json(null)
  await state.savePolicy()
  assert.match(state.error.value, /响应无效/)
  assert.equal(state.dirty.value, true)
  assert.equal(state.message.value, '')
  assert.deepEqual(emitted, [])
})

test('expired authentication uses the shared auth-expired event', async t => {
  const { state } = mount(t)
  const events = []
  globalThis.window = { dispatchEvent: event => { events.push(event.type) } }
  globalThis.fetch = async () => json({ error: '未登录' }, 401)
  await state.loadPolicy()
  assert.deepEqual(events, ['auth-expired'])
  assert.equal(state.canSave.value, false)
})

test('unmount aborts pending saves and suppresses late state changes and refresh events', async t => {
  const { state, emitted, unmount } = mount(t)
  globalThis.fetch = async () => json(policy())
  await state.loadPolicy()
  state.ignoreRoutineEvents()
  let finish
  let signal
  globalThis.fetch = (_, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve }) }
  const pending = state.savePolicy()
  for (const fn of unmount) fn()
  assert.equal(signal.aborted, true)
  finish(json(policy(['process_exec', 'process_exit'])))
  await pending
  assert.deepEqual(state.policy.value, policy())
  assert.equal(state.message.value, '')
  assert.deepEqual(emitted, [])
})

test('all supported kinds are selectable and invalid values cannot become a saved policy', () => {
  const kinds = ['process_exec', 'process_exit', 'process_kprobe', 'process_tracepoint', 'process_loader', 'process_uprobe', 'process_lsm', 'process_usdt', 'runtime']
  assert.deepEqual(policyModule.tetragonKindOptions.map(option => option.value), kinds)
  assert.deepEqual(policyModule.readEventPolicy(policy([...kinds].reverse(), 12)), policy(kinds, 12))
  for (const value of [null, [], {}, policy(['unknown']), policy([12]), policy([], '24'), policy([], 0), { tetragon_ignored_kinds: null, scan_summary_retention_hours: 24 }]) {
    assert.throws(() => policyModule.readEventPolicy(value), /响应无效/)
  }
})
