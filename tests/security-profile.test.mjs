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
function loadModule(source, resolveImport = require) {
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(resolveImport, module, module.exports)
  return module.exports
}
const apiModule = loadModule(readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'))
const profileModule = loadModule(readFileSync(new URL('../src/security-profile.ts', import.meta.url), 'utf8'))
const eventLabels = loadModule(readFileSync(new URL('../src/event-labels.ts', import.meta.url), 'utf8'))
const { descriptor } = parse(readFileSync(new URL('../src/components/SecurityProfileEditor.vue', import.meta.url), 'utf8'))
const script = compileScript(descriptor, { id: 'security-profile-contract' }).content
function mount(t, source = '# original\nserver: [127.0.0.1]\n') {
  const unmount = []
  const emitted = []
  const component = loadModule(script, name => {
    if (name === 'vue') return { ...vue, onMounted: () => {}, onBeforeUnmount: fn => unmount.push(fn) }
    if (name === '../api') return apiModule
    if (name === '../security-profile') return profileModule
    if (name === 'lucide-vue-next') return {}
    throw new Error(`Unexpected import: ${name}`)
  }).default
  const props = vue.reactive({ yaml: source, disabled: false })
  const scope = vue.effectScope()
  const state = scope.run(() => component.setup(props, { expose() {}, emit: (name, value) => emitted.push([name, value]) }))
  t.after(() => { for (const fn of unmount) fn(); scope.stop() })
  return { state, props, emitted, unmount }
}
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

test('form reads server-parsed YAML, preserves advanced keys, and marks a new preset unapplied', async t => {
  const { state, props, emitted } = mount(t)
  let payload
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/settings/security-profile/compose')
    payload = JSON.parse(options.body)
    assert.equal(options.credentials, 'same-origin')
    return json({ yaml: props.yaml, security: null })
  }
  await state.readYaml()
  assert.deepEqual(payload, { yaml: props.yaml })
  assert.equal(state.loaded.value, true)
  assert.equal(state.dirty.value, true)
  assert.equal(state.profile.value.tetragon.enabled, false)
  assert.equal(state.profile.value.tetragon.version, 'v1.7.1')
  assert.equal(state.profile.value.policies.mode, 'audit')
  assert.equal(state.profile.value.sudo.upload_io, false)
  assert.deepEqual([...state.profile.value.sudo.grants], [])
  assert.equal(state.profile.value.ssh_auth.alert_threshold, 5)
  assert.equal(emitted.some(([name]) => name === 'yaml'), false)
  globalThis.fetch = async () => json({ yaml: props.yaml, security: { auditd: { enabled: false, advanced_option: 'keep' }, policies: { sysctl: { 'kernel.kptr_restrict': '2' } } } })
  await state.readYaml()
  assert.equal(state.profile.value.auditd.enabled, false)
  assert.equal(state.profile.value.auditd.advanced_option, 'keep')
  assert.equal(state.sysctlText.value, 'kernel.kptr_restrict = 2')
  assert.equal(state.dirty.value, false)
})

test('compose submits the complete form and adopts only the confirmed server YAML', async t => {
  const { state, props, emitted } = mount(t)
  state.loaded.value = true
  state.changed()
  state.sysctlText.value = 'kernel.kptr_restrict = 2'
  const resultYaml = '# preserved\nsecurity:\n  enabled: true\n'
  globalThis.fetch = async (_, options) => {
    const payload = JSON.parse(options.body)
    assert.equal(payload.yaml, props.yaml)
    assert.equal(payload.security.policies.sysctl['kernel.kptr_restrict'], '2')
    assert.equal(payload.security.auditd.enabled, true)
    return json({ yaml: resultYaml, security: payload.security })
  }
  await state.compose()
  assert.deepEqual(emitted.filter(([name]) => name === 'yaml'), [['yaml', resultYaml]])
  assert.equal(state.dirty.value, false)
  assert.match(state.message.value, /合并到下方 YAML/)
})

test('invalid sysctl, stale YAML and permission rejection retain form edits', async t => {
  const { state, emitted } = mount(t)
  state.loaded.value = true
  state.changed()
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: '拒绝写入' }), { status: 403 }) }
  state.sysctlText.value = 'kernel.kptr_restrict'
  await state.compose()
  assert.equal(calls, 0)
  assert.match(state.error.value, /格式有误/)
  state.sysctlText.value = ''
  state.grantsText.value = '{}'
  await state.compose()
  assert.equal(calls, 0)
  assert.match(state.error.value, /JSON 数组/)
  state.grantsText.value = '[]'
  state.stale.value = true
  await state.compose()
  assert.equal(calls, 0)
  state.stale.value = false
  await state.compose()
  assert.equal(calls, 1)
  assert.equal(state.dirty.value, true)
  assert.match(state.error.value, /拒绝写入/)
  assert.equal(emitted.some(([name]) => name === 'yaml'), false)
})

test('unmount aborts pending composition and never emits a late configuration', async t => {
  const { state, emitted, unmount } = mount(t)
  state.loaded.value = true
  let finish
  let signal
  globalThis.fetch = (_, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve }) }
  const pending = state.compose()
  for (const fn of unmount) fn()
  assert.equal(signal.aborted, true)
  finish(json({ yaml: 'security: {}\n' }))
  await pending
  assert.equal(emitted.some(([name]) => name === 'yaml'), false)
})

test('sysctl parser rejects duplicates and never interprets values as shell commands', () => {
  assert.deepEqual(profileModule.parseSysctl('# comment\nnet.ipv4.ip_forward = 0\n'), { 'net.ipv4.ip_forward': '0' })
  assert.throws(() => profileModule.parseSysctl('kernel.kptr_restrict = 1\nkernel.kptr_restrict = 2'), /重复/)
  assert.throws(() => profileModule.parseSysctl('kernel/kptr_restrict = 2'), /格式有误/)
})

test('task output safely previews UTF-8 and preserves binary or malformed output boundaries', () => {
  assert.equal(eventLabels.taskOutputText(Buffer.from('任务输出\n<script>alert(1)</script>').toString('base64')), '任务输出\n<script>alert(1)</script>')
  assert.match(eventLabels.taskOutputText('/w=='), /二进制输出/)
  assert.match(eventLabels.taskOutputText('%%%'), /编码无效/)
  assert.equal(eventLabels.securityEventTitle({ kind: 'task_failed', message: 'Scheduled task failed' }), '计划任务执行失败')
})
