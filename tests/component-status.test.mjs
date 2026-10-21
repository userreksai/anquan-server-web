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
const apiModule = load(readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'))
const profileModule = load(readFileSync(new URL('../src/security-profile.ts', import.meta.url), 'utf8'))
const { descriptor } = parse(readFileSync(new URL('../src/components/SecurityComponentStatus.vue', import.meta.url), 'utf8'))
const script = compileScript(descriptor, { id: 'component-status' }).content
function mount(t, initialProps = {}) {
  const cleanup = []
  const component = load(script, name => {
    if (name === 'vue') return { ...vue, onMounted() {}, onBeforeUnmount: fn => cleanup.push(fn) }
    if (name === '../api') return apiModule
    if (name === '../security-profile') return profileModule
    if (name === 'lucide-vue-next' || name === './Pagination.vue') return {}
    throw new Error(`Unexpected import ${name}`)
  }).default
  const props = vue.reactive({ machineIP: undefined, refreshToken: 0, ...initialProps })
  const scope = vue.effectScope()
  const state = scope.run(() => component.setup(props, { expose() {} }))
  let disposed = false
  function unmount() {
    if (disposed) return
    disposed = true
    cleanup.forEach(fn => fn())
    scope.stop()
  }
  t.after(unmount)
  return { state, props, unmount }
}
const machine = (machine_ip, overrides = {}) => ({ machine_ip, host: `host-${machine_ip}`, alias: '', connected: true, revision: '', status: 'applied', error: '', updated_at: null, applied_at: null, ...overrides })
const component = (overrides = {}) => ({ name: 'auditd', enabled: true, installed: true, running: true, state: 'running', ...overrides })
const report = (machine_ip, overrides = {}) => ({ machine_ip, host: `host-${machine_ip}`, time: new Date().toISOString(), received_at: new Date().toISOString(), data: { components: [component()] }, ...overrides })
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function respond(machines, reports, sessions = []) {
  globalThis.fetch = async url => {
    const path = new URL(url, 'http://localhost').pathname
    if (path === '/api/settings/agent-config-deliveries') return json({ items: machines })
    if (path === '/api/security/status') return json({ items: reports })
    if (path === '/api/security/sudo-sessions') return json({ items: sessions, total: sessions.length, page: 1, page_size: 10 })
    throw new Error(`Unexpected endpoint ${url}`)
  }
}
const fleet = count => Array.from({ length: count }, (_, index) => machine(`10.0.${Math.floor((index + 1) / 256)}.${(index + 1) % 256}`))
const ips = rows => rows.map(row => row.machine_ip)
async function settle() { await vue.nextTick(); await Promise.resolve(); await vue.nextTick() }

test('a 300-machine fleet has bounded pages and numeric IP order independent of server order', async t => {
  const { state } = mount(t)
  const machines = fleet(300)
  respond([...machines].reverse(), [])
  await state.refresh()
  assert.equal(state.rows.value.length, 300)
  assert.equal(state.visible.value.length, 10)
  assert.deepEqual(ips(state.visible.value), ips(machines.slice(0, 10)))
  state.pageSize.value = 25
  await settle()
  state.page.value = 12
  assert.deepEqual(ips(state.visible.value), ips(machines.slice(275)))
  respond([...machines.slice(150), ...machines.slice(0, 150)], [])
  await state.refresh()
  await settle()
  assert.equal(state.page.value, 12)
  assert.deepEqual(ips(state.visible.value), ips(machines.slice(275)))
})

test('search reaches machines on other pages and changing search or page size resets to page one', async t => {
  const { state } = mount(t)
  const machines = fleet(300)
  machines[276].alias = 'Argentina gateway'
  machines[277].host = 'Unique-Host-278'
  respond(machines, [])
  await state.refresh()
  state.page.value = 15
  state.search.value = ' ARGENTINA '
  await settle()
  assert.equal(state.page.value, 1)
  assert.deepEqual(ips(state.visible.value), [machines[276].machine_ip])
  state.search.value = 'unique-host-278'
  await settle()
  assert.deepEqual(ips(state.visible.value), [machines[277].machine_ip])
  state.search.value = machines[299].machine_ip
  await settle()
  assert.deepEqual(ips(state.visible.value), [machines[299].machine_ip])
  state.search.value = ''
  await settle()
  state.page.value = 15
  state.pageSize.value = 50
  await settle()
  assert.equal(state.page.value, 1)
  assert.equal(state.visible.value.length, 50)
})

test('status and connection filters cover the full fleet, compose with search, and leave overview counts intact', async t => {
  const { state } = mount(t)
  const machines = [
    machine('10.0.0.1'),
    machine('10.0.0.2', { alias: 'Gateway East' }),
    machine('10.0.0.3', { connected: false }),
    machine('10.0.0.4'),
  ]
  const reports = [
    report('10.0.0.1'),
    report('10.0.0.2', { data: { components: [component({ running: false, state: 'error', error: 'installation failed' })] } }),
    report('10.0.0.3', { received_at: new Date(Date.now() - 3_600_000).toISOString() }),
  ]
  respond(machines, reports)
  await state.refresh()
  assert.deepEqual(state.summary.value, { all: 4, error: 1, stale: 1, missing: 1 })
  state.statusFilter.value = 'error'
  await settle()
  assert.deepEqual(ips(state.rows.value), ['10.0.0.2'])
  state.search.value = 'gateway'
  state.connectionFilter.value = 'offline'
  await settle()
  assert.equal(state.rows.value.length, 0)
  assert.deepEqual(state.summary.value, { all: 4, error: 1, stale: 1, missing: 1 })
  state.search.value = ''
  state.statusFilter.value = 'stale'
  await settle()
  assert.deepEqual(ips(state.rows.value), ['10.0.0.3'])
  state.connectionFilter.value = 'all'
  state.statusFilter.value = 'missing'
  await settle()
  assert.deepEqual(ips(state.rows.value), ['10.0.0.4'])
  state.clearFilters()
  await settle()
  assert.equal(state.statusFilter.value, 'all')
  assert.equal(state.connectionFilter.value, 'all')
  assert.equal(state.search.value, '')
  assert.equal(state.rows.value.length, 4)
})

test('changing status or connection filters from a later page always returns to the first matching page', async t => {
  const { state } = mount(t)
  const machines = fleet(50).map((row, index) => ({ ...row, connected: index % 2 === 0 }))
  respond(machines, [])
  await state.refresh()
  state.page.value = 4
  state.statusFilter.value = 'missing'
  await settle()
  assert.equal(state.page.value, 1)
  state.page.value = 3
  state.connectionFilter.value = 'offline'
  await settle()
  assert.equal(state.page.value, 1)
  assert.equal(state.rows.value.length, 25)
  assert.ok(state.visible.value.every(row => !row.connected))
})

test('disabled components do not classify a host as abnormal while a failing enabled component does', async t => {
  const { state } = mount(t)
  respond([machine('10.0.0.1'), machine('10.0.0.2'), machine('10.0.0.3')], [
    report('10.0.0.1', { data: { components: [component({ enabled: false, running: false, state: 'error', error: 'previous disabled component error' })] } }),
    report('10.0.0.2', { data: { components: [component({ state: 'disabled', error: 'previous error' })] } }),
    report('10.0.0.3', { data: { components: [component({ running: false, state: 'install_failed', message: 'package unavailable' })] } }),
  ])
  await state.refresh()
  state.statusFilter.value = 'error'
  await settle()
  assert.deepEqual(ips(state.rows.value), ['10.0.0.3'])
  assert.deepEqual(state.summary.value, { all: 3, error: 1, stale: 0, missing: 0 })
})

test('enabled stopped or uninstalled components remain abnormal without an error field', async t => {
  const { state } = mount(t)
  const states = ['stopped', 'missing', 'not_installed']
  const machines = states.map((_, index) => machine(`10.0.0.${index + 1}`))
  respond(machines, machines.map((row, index) => report(row.machine_ip, {
    data: { components: [component({ running: false, installed: index === 0, state: states[index], message: 'component is not available' })] },
  })))
  await state.refresh()
  assert.deepEqual(state.summary.value, { all: 3, error: 3, stale: 0, missing: 0 })
  state.statusFilter.value = 'error'
  await settle()
  assert.deepEqual(ips(state.rows.value), ips(machines))
  assert.ok(state.rows.value.every(row => row.counts.error === 1))
})

test('refresh advances report freshness using both the legacy and snapshot-specific deadlines', async t => {
  const originalNow = Date.now
  const startedAt = Date.parse('2026-10-21T00:00:00Z')
  let currentTime = startedAt
  Date.now = () => currentTime
  try {
    const { state } = mount(t)
    const received_at = new Date(startedAt).toISOString()
    respond([machine('10.0.0.1'), machine('10.0.0.2')], [
      report('10.0.0.1', { received_at }),
      report('10.0.0.2', { received_at, data: { components: [component()], status_reporting: 'changes_only', snapshot_interval_seconds: 300 } }),
    ])
    await state.refresh()
    state.statusFilter.value = 'stale'
    await settle()
    assert.equal(state.summary.value.stale, 0)
    assert.equal(state.rows.value.length, 0)
    currentTime = startedAt + 120_001
    await state.refresh()
    await settle()
    assert.equal(state.summary.value.stale, 1)
    assert.deepEqual(ips(state.rows.value), ['10.0.0.1'])
    currentTime = startedAt + 600_001
    await state.refresh()
    await settle()
    assert.equal(state.summary.value.stale, 2)
    assert.deepEqual(ips(state.rows.value), ['10.0.0.1', '10.0.0.2'])
  } finally {
    Date.now = originalNow
  }
})

test('refresh preserves page, filters and expansion while removed machines clamp the page to the last valid page', async t => {
  const { state } = mount(t)
  const machines = fleet(50)
  respond(machines, [])
  await state.refresh()
  state.search.value = 'host-'
  state.statusFilter.value = 'missing'
  state.connectionFilter.value = 'online'
  await settle()
  state.page.value = 4
  state.toggleDetails(machines[30].machine_ip)
  await state.refresh()
  await settle()
  assert.equal(state.page.value, 4)
  assert.equal(state.search.value, 'host-')
  assert.equal(state.statusFilter.value, 'missing')
  assert.equal(state.connectionFilter.value, 'online')
  assert.equal(state.expandedIPs.value.has(machines[30].machine_ip), true)
  respond(machines.slice(0, 13), [])
  await state.refresh()
  await settle()
  assert.equal(state.page.value, 2)
  assert.equal(state.visible.value.length, 3)
  assert.equal(state.expandedIPs.value.has(machines[30].machine_ip), false)
  respond([], [])
  await state.refresh()
  await settle()
  assert.equal(state.page.value, 1)
  assert.equal(state.visible.value.length, 0)
})

test('report-only machines remain visible once and a machine-scoped view excludes other hosts', async t => {
  const { state } = mount(t, { machineIP: '10.0.0.2' })
  respond([machine('10.0.0.1')], [report('10.0.0.2'), report('10.0.0.1')])
  await state.refresh()
  assert.deepEqual(ips(state.allRows.value), ['10.0.0.2'])
  assert.equal(state.rows.value[0].connected, false)
  assert.equal(state.rows.value[0].report.machine_ip, '10.0.0.2')
  assert.deepEqual(state.summary.value, { all: 1, error: 0, stale: 0, missing: 0 })
})

test('details are explicitly toggled, survive paging, and reset with the machine scope', async t => {
  const { state, props } = mount(t)
  const machines = fleet(30)
  respond(machines, machines.map(row => report(row.machine_ip)))
  await state.refresh()
  assert.equal(state.expandedIPs.value.size, 0)
  state.toggleDetails(machines[0].machine_ip)
  assert.equal(state.expandedIPs.value.has(machines[0].machine_ip), true)
  state.page.value = 2
  state.toggleDetails(machines[10].machine_ip)
  state.page.value = 1
  assert.equal(state.expandedIPs.value.has(machines[0].machine_ip), true)
  state.toggleDetails(machines[0].machine_ip)
  assert.equal(state.expandedIPs.value.has(machines[0].machine_ip), false)
  state.page.value = 2
  state.sessionPage.value = 3
  props.machineIP = machines[10].machine_ip
  await settle()
  assert.equal(state.page.value, 1)
  assert.equal(state.sessionPage.value, 1)
  assert.equal(state.expandedIPs.value.size, 0)
  assert.deepEqual(ips(state.rows.value), [machines[10].machine_ip])
})

test('a failed refresh retains the last successful machine and component data', async t => {
  const { state } = mount(t)
  const machines = [machine('10.0.0.1')]
  const reports = [report('10.0.0.1')]
  respond(machines, reports)
  await state.refresh()
  const previousMachines = state.machines.value
  const previousReports = state.reports.value
  globalThis.fetch = async () => json({ message: '主控暂时不可用' }, 503)
  await state.refresh()
  assert.equal(state.machines.value, previousMachines)
  assert.equal(state.reports.value, previousReports)
  assert.deepEqual(ips(state.visible.value), ['10.0.0.1'])
  assert.match(state.error.value, /主控暂时不可用/)
  assert.equal(state.loading.value, false)
})

test('unmount aborts every status request and ignores responses that arrive afterwards', async t => {
  const { state, unmount } = mount(t)
  const pending = []
  globalThis.fetch = async (url, options) => new Promise(resolve => { pending.push({ url, signal: options.signal, resolve }) })
  const refresh = state.refresh()
  assert.equal(pending.length, 3)
  unmount()
  assert.ok(pending.every(request => request.signal.aborted))
  for (const request of pending) request.resolve(json({ items: request.url.includes('deliveries') ? [machine('10.0.0.1')] : [], total: 0 }))
  await refresh
  assert.equal(state.machines.value.length, 0)
  assert.equal(state.reports.value.length, 0)
})
