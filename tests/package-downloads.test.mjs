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
const { descriptor } = parse(readFileSync(new URL('../src/components/PackageDownloadSettings.vue', import.meta.url), 'utf8'))
const script = compileScript(descriptor, { id: 'package-downloads' }).content
function mount(t) {
  const cleanup = []
  const component = load(script, name => {
    if (name === 'vue') return { ...vue, onMounted() {}, onBeforeUnmount: fn => cleanup.push(fn) }
    if (name === '../api') return apiModule
    if (name === 'lucide-vue-next') return {}
    throw new Error(`Unexpected import ${name}`)
  }).default
  const scope = vue.effectScope()
  const state = scope.run(() => component.setup({ refreshToken: '' }, { expose() {} }))
  t.after(() => { cleanup.forEach(fn => fn()); scope.stop() })
  return state
}
const initial = (overrides = {}) => ({ enabled: false, expires_at: null, window_minutes: 15, allowed_hosts: ['archive.ubuntu.com', '*.ec2.archive.ubuntu.com'], active_sessions: 0, active_connections: 0, bytes_transferred: 0, ...overrides })
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

test('an unsuccessful or malformed read never authorizes downloads', async t => {
  const state = mount(t)
  let calls = 0
  globalThis.fetch = async () => { calls++; return json({ message: 'offline' }, 503) }
  await state.refresh()
  await state.save(true)
  assert.equal(calls, 1)
  assert.equal(state.settings.value, null)
  assert.equal(state.enabled.value, false)
  globalThis.fetch = async () => json(initial({ enabled: true, expires_at: 'invalid' }))
  await state.refresh()
  assert.equal(state.settings.value, null)
  assert.match(state.error.value, /响应无效/)
})

test('enabling explicitly submits the selected window and allowlist', async t => {
  const state = mount(t)
  globalThis.fetch = async () => json(initial())
  await state.refresh()
  state.windowMinutes.value = 30
  state.hosts.value = 'archive.ubuntu.com\napi.github.com\narchive.ubuntu.com'
  globalThis.fetch = async (url, request) => {
    assert.equal(url, '/api/settings/package-downloads')
    assert.equal(request.method, 'PUT')
    assert.equal(request.credentials, 'same-origin')
    const body = JSON.parse(request.body)
    assert.deepEqual(body, { enabled: true, window_minutes: 30, allowed_hosts: ['archive.ubuntu.com', 'api.github.com'] })
    return json(initial({ ...body, expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() }))
  }
  await state.save(true)
  assert.equal(state.enabled.value, true)
  assert.equal(state.dirty.value, false)
})

test('emergency close uses confirmed settings even with an invalid unsaved allowlist', async t => {
  const state = mount(t)
  const opened = initial({ enabled: true, expires_at: new Date(Date.now() + 600000).toISOString(), active_connections: 2 })
  globalThis.fetch = async () => json(opened)
  await state.refresh()
  state.hosts.value = 'invalid://draft'
  state.windowMinutes.value = 60
  globalThis.fetch = async (_url, request) => {
    assert.deepEqual(JSON.parse(request.body), { enabled: false, window_minutes: 15, allowed_hosts: opened.allowed_hosts })
    return json(initial())
  }
  await state.save(false)
  assert.equal(state.enabled.value, false)
  assert.equal(state.settings.value.active_connections, 0)
  assert.equal(state.hosts.value, 'invalid://draft')
  assert.equal(state.dirty.value, true)
})

test('polling preserves drafts and a failed close never reports success', async t => {
  const state = mount(t)
  globalThis.fetch = async () => json(initial({ enabled: true, expires_at: new Date(Date.now() + 600000).toISOString() }))
  await state.refresh()
  state.hosts.value = 'my-mirror.example.com'
  await state.refresh()
  assert.equal(state.hosts.value, 'my-mirror.example.com')
  globalThis.fetch = async () => json({ message: '关闭失败' }, 500)
  await state.save(false)
  assert.equal(state.enabled.value, true)
  assert.equal(state.message.value, '')
  assert.match(state.error.value, /关闭失败/)
})

test('expired authorization is displayed as closed without waiting for polling', async t => {
  const state = mount(t)
  globalThis.fetch = async () => json(initial({ enabled: true, expires_at: new Date(Date.now() + 1000).toISOString() }))
  await state.refresh()
  assert.equal(state.enabled.value, true)
  state.now.value = Date.now() + 2000
  assert.equal(state.enabled.value, false)
  assert.equal(state.remaining.value, '')
})
