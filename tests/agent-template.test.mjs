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

// Compile and execute the actual component and API code, without a DOM or new
// test dependencies. The only component stubs are icons and the delivery modal.
function loadModule(source, resolveImport = require) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(resolveImport, module, module.exports)
  return module.exports
}
const apiModule = loadModule(readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'))
const exampleModule = loadModule(readFileSync(new URL('../src/agent-config-template.ts', import.meta.url), 'utf8'))
const { descriptor } = parse(readFileSync(new URL('../src/components/AgentEncryption.vue', import.meta.url), 'utf8'))
const script = compileScript(descriptor, { id: 'agent-template-contract' }).content

function mount(t) {
  const unmount = []
  const component = loadModule(script, name => {
    if (name === 'vue') return { ...vue, onMounted: () => {}, onBeforeUnmount: fn => unmount.push(fn) }
    if (name === '../api') return apiModule
    if (name === '../agent-config-template') return exampleModule
    if (name === 'lucide-vue-next' || name === './AgentConfigDelivery.vue' || name === './SecurityProfileEditor.vue') return {}
    throw new Error(`Unexpected component dependency: ${name}`)
  }).default
  const scope = vue.effectScope()
  const state = scope.run(() => component.setup({}, { expose() {} }))
  // Initial load has already completed before the user clicks Save.
  state.templateAction.value = ''
  t.after(() => { for (const fn of unmount) fn(); scope.stop() })
  return { state, unmount }
}

const yaml = '# 完整保留注释和换行\nserver:\n  - sa.sa.ops.tw:55555\nfiles: []\n'
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})

test('save uses same-origin POST JSON API and confirms the exact submitted YAML', async t => {
  const { state } = mount(t)
  state.yaml.value = yaml
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return json({ yaml })
  }
  await state.saveTemplate()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/settings/agent-config-template')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.credentials, 'same-origin')
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].options.body), { yaml })
  assert.ok(calls[0].options.signal instanceof AbortSignal)
  assert.equal(calls[0].options.signal.aborted, false)
  const headers = Object.keys(calls[0].options.headers).map(key => key.toLowerCase())
  assert.equal(headers.includes('cookie'), false)
  assert.equal(headers.includes('authorization'), false)
  assert.equal(state.yaml.value, yaml)
  assert.match(state.message.value, /模板已存储到服务器/)
  assert.equal(state.error.value, '')
  assert.equal(state.templateAction.value, '')
})

test('403 JSON and HTML rejection preserve user YAML and existing ciphertext', async t => {
  const { state } = mount(t)
  state.yaml.value = yaml
  state.ciphertext.value = 'existing encrypted configuration'
  for (const response of [json({ message: '请求来源不受信任' }, 403), new Response('<html>Forbidden</html>', { status: 403 })]) {
    globalThis.fetch = async () => response
    await state.saveTemplate()
    assert.equal(state.yaml.value, yaml)
    assert.equal(state.ciphertext.value, 'existing encrypted configuration')
    assert.equal(state.message.value, '')
    assert.match(state.error.value, /请求来源不受信任|请求失败（403）/)
    assert.equal(state.templateAction.value, '')
  }
})

test('network rejection and mismatching confirmation preserve edits and never show success', async t => {
  const { state } = mount(t)
  state.yaml.value = yaml
  for (const fetch of [
    async () => { throw new Error('offline') },
    async () => json({ yaml: 'different template' }),
    async () => json({ yaml: null }),
  ]) {
    globalThis.fetch = fetch
    await state.saveTemplate()
    assert.equal(state.yaml.value, yaml)
    assert.equal(state.message.value, '')
    assert.match(state.error.value, /无法连接主控|服务器未确认/)
    assert.equal(state.templateAction.value, '')
  }
})

test('while save is pending a second click cannot submit a second request', async t => {
  const { state } = mount(t)
  state.yaml.value = yaml
  let finish
  let calls = 0
  globalThis.fetch = () => { calls++; return new Promise(resolve => { finish = resolve }) }
  const pending = state.saveTemplate()
  assert.equal(state.templateAction.value, 'save')
  assert.equal(state.pending.value, true)
  await state.saveTemplate()
  assert.equal(calls, 1)
  finish(json({ yaml }))
  await pending
  assert.equal(state.pending.value, false)
  assert.match(state.message.value, /模板已存储/)
})

test('unmount aborts the supplied signal and a late response cannot claim success', async t => {
  const { state, unmount } = mount(t)
  state.yaml.value = yaml
  let finish
  let signal
  globalThis.fetch = (_, options) => {
    signal = options.signal
    return new Promise(resolve => { finish = resolve })
  }
  const pending = state.saveTemplate()
  for (const fn of unmount) fn()
  assert.equal(signal.aborted, true)
  finish(json({ yaml }))
  await pending
  assert.equal(state.yaml.value, yaml)
  assert.equal(state.message.value, '')
  assert.equal(state.error.value, '')
  assert.equal(state.templateAction.value, '')
})

test('empty or oversized input is rejected before any API request', async t => {
  const { state } = mount(t)
  let calls = 0
  globalThis.fetch = async () => { calls++; return json({ yaml }) }
  for (const invalid of ['  \n', 'a'.repeat(4 * 1024 * 1024 + 1)]) {
    state.yaml.value = invalid
    await state.saveTemplate()
    assert.equal(calls, 0)
    assert.equal(state.yaml.value, invalid)
    assert.match(state.error.value, /最大 4 MiB/)
  }
})
