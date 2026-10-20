import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { after, test } from 'node:test'
import ts from 'typescript'
import * as vue from 'vue'

const require = createRequire(import.meta.url)
const { parse, compileScript } = require('vue/compiler-sfc')
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch })
function load(source, resolveImport = require) {
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(resolveImport, module, module.exports)
  return module.exports
}
const helper = load(readFileSync(new URL('../src/agent-updates.ts', import.meta.url), 'utf8'))
const apiModule = load(readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'))
const { descriptor } = parse(readFileSync(new URL('../src/components/AgentUpdateSettings.vue', import.meta.url), 'utf8'))
const script = compileScript(descriptor, { id: 'agent-updates' }).content
function mount(t) {
  const cleanup = []
  const component = load(script, name => {
    if (name === 'vue') return { ...vue, onMounted() {}, onBeforeUnmount: fn => cleanup.push(fn) }
    if (name === '../api') return apiModule
    if (name === '../agent-updates') return helper
    if (name === 'lucide-vue-next' || name === './Pagination.vue') return {}
    throw new Error(`Unexpected import ${name}`)
  }).default
  const scope = vue.effectScope()
  const state = scope.run(() => component.setup({ refreshToken: '' }, { expose() {} }))
  t.after(() => { cleanup.forEach(fn => fn()); scope.stop() })
  return { state, cleanup }
}
const release = (overrides = {}) => ({ version: '0.7.4', goos: 'linux', goarch: 'amd64', sha256: 'a'.repeat(64), size: 4000000, binary_sha256: 'b'.repeat(64), binary_size: 9000000, created_at: '2026-10-20T10:00:00Z', ...overrides })
const machine = (overrides = {}) => ({ machine_ip: '172.22.0.11', host: 'ip-172-22-0-11', alias: '', connected: true, supported: true, agent_version: '0.7.3', goos: 'linux', goarch: 'amd64', job_id: '', target_version: '', status: 'idle', error: '', updated_at: null, completed_at: null, ...overrides })
const initial = (overrides = {}) => ({ source_dir: '/usr/local/anquan-agent/dist', release: release(), source_error: '', items: [machine()], ...overrides })
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

test('version comparison uses numeric components and rejects ambiguous development versions', () => {
  assert.equal(helper.compareAgentVersions('0.7.10', '0.7.9'), 1)
  assert.equal(helper.compareAgentVersions('v0.7.3', '0.7.3'), 0)
  assert.equal(helper.compareAgentVersions('0.7.2', '0.7.3'), -1)
  for (const version of ['development', '0.7', '0.7.4-beta', '00.7.4', '9007199254740992.0.1']) assert.equal(helper.compareAgentVersions(version, '0.7.3'), null)
})

test('machine eligibility requires online capability, matching platform, newer version, and no active job', () => {
  assert.equal(helper.agentUpdateReason(machine(), release()), '')
  assert.match(helper.agentUpdateReason(machine(), null), /打包/)
  assert.match(helper.agentUpdateReason(machine({ connected: false }), release()), /未在线/)
  assert.match(helper.agentUpdateReason(machine({ supported: false, agent_version: '0.7.2' }), release()), /手工部署/)
  assert.match(helper.agentUpdateReason(machine({ goarch: 'arm64' }), release()), /不匹配/)
  assert.match(helper.agentUpdateReason(machine({ goos: 'windows' }), release()), /不匹配/)
  assert.match(helper.agentUpdateReason(machine({ agent_version: '0.7.4' }), release()), /相同或更高/)
  assert.match(helper.agentUpdateReason(machine({ agent_version: '0.8.0' }), release()), /相同或更高/)
  assert.match(helper.agentUpdateReason(machine({ agent_version: 'development' }), release()), /无法比较/)
  for (const status of ['pending', 'downloading', 'restarting']) assert.match(helper.agentUpdateReason(machine({ status }), release()), /正在执行/)
  assert.equal(helper.agentUpdateReason(machine({ status: 'rolled_back' }), release()), '')
})

test('polling removes no-longer-eligible choices and changes of release clear the whole selection', () => {
  const ips = ['172.22.0.11', '172.22.0.12']
  const unchanged = initial({ items: [machine(), machine({ machine_ip: ips[1], connected: false })] })
  assert.deepEqual(helper.reconcileAgentUpdateSelection(ips, release().sha256, unchanged), { ips: [ips[0]], releaseChanged: false })
  const replaced = initial({ release: release({ sha256: 'c'.repeat(64) }) })
  assert.deepEqual(helper.reconcileAgentUpdateSelection(ips, release().sha256, replaced), { ips: [], releaseChanged: true })
  assert.deepEqual(helper.reconcileAgentUpdateSelection(ips, release().sha256, initial({ release: null })), { ips: [], releaseChanged: true })
})

test('invalid server responses cannot expose selectable machines', async t => {
  const { state } = mount(t)
  globalThis.fetch = async () => json(initial({ items: [machine({ connected: 'yes' })] }))
  await state.refresh()
  assert.equal(state.settings.value, null)
  assert.match(state.loadError.value, /响应无效/)
  assert.throws(() => helper.parseAgentUpdateSettings(initial({ release: release({ sha256: 'invalid' }) })), /响应无效/)
  assert.throws(() => helper.parseAgentUpdateSettings(initial({ items: [machine(), machine()] })), /响应无效/)
})

test('select current page includes only eligible machines and search preserves selection', async t => {
  const { state } = mount(t)
  const items = [machine(), machine({ machine_ip: '172.22.0.12', supported: false, agent_version: '0.7.2' }), machine({ machine_ip: '172.22.0.13', goarch: 'arm64' })]
  globalThis.fetch = async () => json(initial({ items }))
  await state.refresh()
  state.toggleVisible()
  assert.deepEqual(state.selectedIPs.value, ['172.22.0.11'])
  state.search.value = '172.22.0.12'
  assert.equal(state.filtered.value.length, 1)
  assert.deepEqual(state.selectedIPs.value, ['172.22.0.11'])
  state.toggle(items[1])
  assert.deepEqual(state.selectedIPs.value, ['172.22.0.11'])
})

test('submitting requires an explicit review and binds the selected machines to its package snapshot', async t => {
  const { state } = mount(t)
  globalThis.fetch = async () => json(initial())
  await state.refresh()
  state.toggle(state.settings.value.items[0])
  let calls = 0
  globalThis.fetch = async (_url, request) => {
    calls++
    assert.equal(request.method, 'POST')
    assert.deepEqual(JSON.parse(request.body), { machine_ips: ['172.22.0.11'], release_sha256: release().sha256 })
    return json(initial({ items: [machine({ job_id: 'job-1', target_version: '0.7.4', status: 'pending' })] }))
  }
  await state.submit()
  assert.equal(calls, 0)
  state.openReview()
  assert.deepEqual(state.review.value.ips, ['172.22.0.11'])
  await state.submit()
  assert.equal(calls, 1)
  assert.equal(state.review.value, null)
  assert.deepEqual(state.selectedIPs.value, [])
  assert.match(state.message.value, /已提交 1 台机器升级至 0.7.4/)
  assert.equal(state.settings.value.items[0].status, 'pending')
})

test('release replacement and disconnect invalidate a pending confirmation', async t => {
  const { state } = mount(t)
  globalThis.fetch = async () => json(initial())
  await state.refresh()
  state.toggle(state.settings.value.items[0]); state.openReview()
  globalThis.fetch = async () => json(initial({ release: release({ sha256: 'c'.repeat(64) }) }))
  await state.refresh()
  assert.deepEqual(state.selectedIPs.value, [])
  assert.equal(state.review.value, null)
  assert.match(state.selectionNotice.value, /更新包已变更/)
  state.toggle(state.settings.value.items[0]); state.openReview()
  globalThis.fetch = async () => json(initial({ release: release({ sha256: 'c'.repeat(64) }), items: [machine({ connected: false })] }))
  await state.refresh()
  assert.deepEqual(state.selectedIPs.value, [])
  assert.equal(state.review.value, null)
  assert.match(state.selectionNotice.value, /连接、版本或任务状态已变更/)
})

test('failed submissions retain feedback and never announce success during subsequent polling', async t => {
  const { state } = mount(t)
  globalThis.fetch = async () => json(initial())
  await state.refresh()
  state.toggle(state.settings.value.items[0]); state.openReview()
  globalThis.fetch = async () => json({ message: '升级授权已过期' }, 409)
  await state.submit()
  assert.match(state.actionError.value, /升级授权已过期/)
  assert.equal(state.message.value, '')
  assert.equal(state.selectedIPs.value.length, 1)
  globalThis.fetch = async () => json(initial())
  await state.refresh()
  assert.match(state.actionError.value, /升级授权已过期/)
})

test('packaging uses the fixed server source without accepting an arbitrary browser-supplied path', async t => {
  const { state } = mount(t)
  globalThis.fetch = async (url, request) => {
    assert.equal(url, '/api/settings/agent-updates/package')
    assert.equal(request.method, 'POST')
    assert.deepEqual(JSON.parse(request.body), {})
    return json(initial())
  }
  await state.preparePackage()
  assert.equal(state.release.value.version, '0.7.4')
  assert.match(state.message.value, /已读取主控程序/)
})

test('unmount cancels in-flight requests and prevents later state changes', async t => {
  const { state, cleanup } = mount(t)
  let signal
  let finish
  globalThis.fetch = async (_url, request) => { signal = request.signal; return new Promise(resolve => { finish = resolve }) }
  const refresh = state.refresh()
  cleanup[0]()
  assert.equal(signal.aborted, true)
  finish(json(initial()))
  await refresh
  assert.equal(state.settings.value, null)
})
