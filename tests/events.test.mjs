import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { after, test } from 'node:test'
import ts from 'typescript'
import * as vue from 'vue'
import { renderToString } from 'vue/server-renderer'

const require = createRequire(import.meta.url)
const { parse, compileScript, compileTemplate } = require('vue/compiler-sfc')
const originalFetch = globalThis.fetch
const originalDocument = globalThis.document
const originalWindow = globalThis.window
after(() => { globalThis.fetch = originalFetch; globalThis.document = originalDocument; globalThis.window = originalWindow })
function loadModule(source, resolveImport = require) {
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(resolveImport, module, module.exports)
  return module.exports
}
const modules = new Map()
function sourceModule(name) {
  if (!modules.has(name)) modules.set(name, loadModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), name => name.startsWith('./') ? sourceModule(name.slice(2)) : require(name)))
  return modules.get(name)
}
const { eventStatusPresentation } = sourceModule('event-presentation')
const { descriptor } = parse(readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8'))
const script = compileScript(descriptor, { id: 'events-contract' })
const template = compileTemplate({ source: descriptor.template.content, filename: 'App.vue', id: 'events-contract', ssr: true, cssVars: descriptor.cssVars, compilerOptions: { bindingMetadata: script.bindings } })
assert.deepEqual(template.errors, [])
const { ssrRender } = loadModule(template.code)
const stub = { render: () => null }
function mount(t) {
  globalThis.document = { hidden: false, activeElement: null, addEventListener() {}, removeEventListener() {} }
  globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }
  const cleanup = []
  const component = loadModule(script.content, name => {
    if (name === 'vue') return { ...vue, onMounted: () => {}, onBeforeUnmount: fn => cleanup.push(fn) }
    if (name === 'lucide-vue-next') return new Proxy({}, { get: () => stub })
    if (name.endsWith('.vue')) return { default: stub }
    if (name.endsWith('.css')) return {}
    if (name.startsWith('./')) return sourceModule(name.slice(2))
    throw new Error(`Unexpected import: ${name}`)
  }).default
  const scope = vue.effectScope()
  const state = scope.run(() => component.setup({}, { expose() {} }))
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url: new URL(url, 'http://localhost'), options })
    return new Response(JSON.stringify(url.startsWith('/api/events?') ? { items: [], total: 0 } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { scope.stop(); for (const fn of cleanup) fn() })
  const eventRequests = () => requests.filter(request => request.url.pathname === '/api/events')
  async function render() {
    const context = {}
    const html = await renderToString(vue.createSSRApp({ ...component, setup: () => state, ssrRender }), context)
    return html + (context.teleports?.body || '')
  }
  return { state, requests, eventRequests, render }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const command = status => ({ id: 1, event_id: 'command-id', machine_ip: '192.0.2.1', host: 'test-host', type: 'command_history', status, time: '2026-10-19T01:02:03Z', received_at: '2026-10-19T01:02:04Z', notes: '', data: { command: 'echo test', user: 'ops', terminal: '/dev/pts/0', path: '/var/log/history.log' } })

test('command records use neutral recorded status even when legacy rows are resolved', () => {
  for (const status of ['open', 'resolved']) assert.deepEqual(eventStatusPresentation(command(status)), { label: '已记录', tone: 'neutral', resolved: false })
  assert.deepEqual(eventStatusPresentation({ type: 'alert', status: 'open', data: {} }), { label: '待处理', tone: 'warning', resolved: false })
  assert.deepEqual(eventStatusPresentation({ type: 'alert', status: 'resolved', data: {} }), { label: '已处理', tone: 'success', resolved: true })
  assert.deepEqual(eventStatusPresentation({ type: 'security_event', status: 'open', data: { severity: 'warning' } }), { label: '待处理', tone: 'warning', resolved: false })
  assert.deepEqual(eventStatusPresentation({ type: 'component_status', status: 'open', data: {} }), { label: '已记录', tone: 'neutral', resolved: false })
  for (const type of ['ssh_login', 'scan_summary']) assert.deepEqual(eventStatusPresentation({ type, status: 'open', data: {} }), { label: '待处理', tone: 'neutral', resolved: false })
})

test('switching from an alert filter to commands clears status and requests default descending order', async t => {
  const { state, eventRequests } = mount(t)
  state.view.value = 'events'
  state.eventStatusFilter.value = 'open'
  state.appliedEvents.value = { q: 'ops', from: '', to: '', status: 'open' }
  state.eventPage.value = 4
  state.setEventType('command_history')
  await flush()
  assert.equal(state.eventStatusFilter.value, '')
  assert.equal(state.appliedEvents.value.status, '')
  assert.equal(state.eventPage.value, 1)
  const { searchParams } = eventRequests().at(-1).url
  assert.equal(searchParams.get('type'), 'command_history')
  assert.equal(searchParams.has('status'), false)
  assert.equal(searchParams.get('q'), 'ops')
  assert.equal(searchParams.get('order'), 'desc')
  assert.equal(searchParams.get('page'), '1')
})

test('command requests reject inherited status and apply ascending order before pagination', async t => {
  const { state, eventRequests } = mount(t)
  state.view.value = 'events'
  state.eventType.value = 'command_history'
  state.appliedEvents.value.status = 'resolved'
  state.eventPage.value = 8
  state.eventOrder.value = 'asc'
  state.changeEventOrder()
  await flush()
  const { searchParams } = eventRequests().at(-1).url
  assert.equal(searchParams.has('status'), false)
  assert.equal(searchParams.get('order'), 'asc')
  assert.equal(searchParams.get('page'), '1')
  state.eventPage.value = 2
  await state.loadPage()
  assert.equal(eventRequests().at(-1).url.searchParams.get('order'), 'asc')
  assert.equal(eventRequests().at(-1).url.searchParams.get('page'), '2')
  state.clearFilters()
  await flush()
  assert.equal(state.eventOrder.value, 'desc')
  assert.equal(eventRequests().at(-1).url.searchParams.get('order'), 'desc')
})

test('other event tabs retain status filters and their existing default ordering', async t => {
  const { state, eventRequests } = mount(t)
  state.view.value = 'events'
  state.eventType.value = 'alert'
  state.appliedEvents.value.status = 'open'
  state.eventOrder.value = 'asc'
  await state.loadPage()
  const { searchParams } = eventRequests().at(-1).url
  assert.equal(searchParams.get('status'), 'open')
  assert.equal(searchParams.has('order'), false)
})

test('saving command notes omits status for both open and resolved legacy records', async t => {
  const { state, requests } = mount(t)
  for (const status of ['open', 'resolved']) {
    state.dialog.value = 'event'
    state.activeEvent.value = command(status)
    state.eventStatus.value = status === 'open' ? 'resolved' : 'open'
    state.eventNotes.value = '已核实执行背景'
    await state.saveDialog()
    const patch = requests.filter(request => request.options.method === 'PATCH').at(-1)
    assert.equal(patch.url.pathname, '/api/events/1')
    assert.deepEqual(JSON.parse(patch.options.body), { notes: '已核实执行背景' })
  }
  state.dialog.value = 'event'
  state.activeEvent.value = { ...command('open'), type: 'alert' }
  state.eventStatus.value = 'resolved'
  state.eventNotes.value = '已处理'
  await state.saveDialog()
  assert.deepEqual(JSON.parse(requests.filter(request => request.options.method === 'PATCH').at(-1).options.body), { status: 'resolved', notes: '已处理' })
})

test('actual command list and detail render recorded status with notes and no processing controls', async t => {
  const { state, render } = mount(t)
  state.booting.value = false
  state.authenticated.value = true
  state.view.value = 'events'
  state.eventType.value = 'command_history'
  state.events.value = [command('resolved')]
  state.dialog.value = 'event'
  state.activeEvent.value = command('resolved')
  const html = await render()
  assert.match(html, /记录状态/)
  assert.equal((html.match(/已记录/g) || []).length, 2)
  assert.doesNotMatch(html, /已处理|待处理|aria-label="处理状态"/)
  assert.doesNotMatch(html, /<option value="resolved"/)
  assert.match(html, /aria-label="发生时间排序"/)
  assert.match(html, /最新优先/)
  assert.match(html, /时间正序/)
  assert.match(html, /<textarea[^>]*maxlength="4000"/)
  assert.match(html, /保存备注/)
})
