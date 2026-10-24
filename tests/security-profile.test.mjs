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
    if (name === 'lucide-vue-next' || name === './SshAccountPicker.vue') return {}
    throw new Error(`Unexpected import: ${name}`)
  }).default
  const props = vue.reactive({ yaml: source, disabled: false })
  const scope = vue.effectScope()
  const state = scope.run(() => component.setup(props, { expose() {}, emit: (name, value) => emitted.push([name, value]) }))
  t.after(() => { for (const fn of unmount) fn(); scope.stop() })
  return { state, props, emitted, unmount }
}
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

test('new profiles include the complete standard cron scope without enabling enforcement or changing content defaults', () => {
  const expectedCron = ['/etc/crontab', '/etc/cron.d', '/etc/cron.hourly', '/etc/cron.daily', '/etc/cron.weekly', '/etc/cron.monthly', '/etc/cron.allow', '/etc/cron.deny', '/var/spool/cron', '/etc/anacrontab', '/etc/cron.yearly']
  const expected = ['/etc/passwd', '/etc/group', '/etc/shadow', '/etc/ssh', '/etc/sudoers', '/etc/sudoers.d', ...expectedCron]
  const profile = profileModule.defaultSecurityProfile()
  assert.deepEqual(profileModule.cronPaths, expectedCron)
  assert.deepEqual(profile.auditd.watch_paths, expected)
  assert.deepEqual(profile.native_fim.paths, expected)
  assert.equal(profile.policies.mode, 'audit')
  assert.equal(profile.native_fim.report_changes, false)
  assert.equal(profile.native_fim.capture_created_content, true)
  profile.auditd.watch_paths.pop()
  profile.native_fim.paths.push('/custom')
  assert.deepEqual(profileModule.defaultSecurityProfile().auditd.watch_paths, expected)
  assert.deepEqual(profileModule.defaultSecurityProfile().native_fim.paths, expected)
})

test('reading and composing an existing profile preserve its explicit audit and FIM scopes', async t => {
  const { state, props } = mount(t, '# existing deployment\nserver: []\n')
  const existing = { auditd: { enabled: true, watch_paths: ['/etc/cron.d', '/srv/custom-audit'] }, native_fim: { enabled: true, paths: ['/srv/custom-fim'], report_changes: true }, policies: { mode: 'audit' } }
  globalThis.fetch = async (_, options) => {
    const payload = JSON.parse(options.body)
    return json({ yaml: props.yaml, security: payload.security || existing })
  }
  await state.readYaml()
  assert.deepEqual([...state.profile.value.auditd.watch_paths], existing.auditd.watch_paths)
  assert.deepEqual([...state.profile.value.native_fim.paths], existing.native_fim.paths)
  state.profile.value.auditd.audit_exec = false
  state.changed()
  let submitted
  globalThis.fetch = async (_, options) => {
    submitted = JSON.parse(options.body)
    return json({ yaml: props.yaml, security: submitted.security })
  }
  await state.compose()
  assert.deepEqual(submitted.security.auditd.watch_paths, existing.auditd.watch_paths)
  assert.deepEqual(submitted.security.native_fim.paths, existing.native_fim.paths)
  assert.equal(submitted.security.native_fim.report_changes, true)
  assert.equal(submitted.security.policies.mode, 'audit')
})

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
  assert.equal(state.sysctlText.value, '')
  assert.equal(state.profile.value.policies.sysctl['kernel.kptr_restrict'], '2')
  assert.equal(state.dirty.value, false)
})

test('compose submits the complete form and adopts only the confirmed server YAML', async t => {
  const { state, props, emitted } = mount(t)
  state.loaded.value = true
  state.changed()
  state.profile.value.policies.sysctl = profileModule.setKernelPolicy({}, 'kernel.kptr_restrict', true)
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

test('component status keeps legacy two-minute expiry unless changes-only snapshots are declared', () => {
  const receivedAt = Date.parse('2026-10-17T03:00:00Z')
  const report = { received_at: new Date(receivedAt).toISOString(), data: { snapshot_interval_seconds: 300 } }
  assert.equal(profileModule.componentReportStale(report, receivedAt + 120_000), false)
  assert.equal(profileModule.componentReportStale(report, receivedAt + 120_001), true)
  report.data.status_reporting = 'periodic'
  assert.equal(profileModule.componentReportStale(report, receivedAt + 120_001), true)
})

test('changes-only status allows two snapshot intervals with a two-minute minimum', () => {
  const receivedAt = Date.parse('2026-10-17T03:00:00Z')
  const report = { received_at: new Date(receivedAt).toISOString(), data: { status_reporting: 'changes_only', snapshot_interval_seconds: 300 } }
  assert.equal(profileModule.componentReportStale(report, receivedAt + 300_000), false)
  assert.equal(profileModule.componentReportStale(report, receivedAt + 600_000), false)
  assert.equal(profileModule.componentReportStale(report, receivedAt + 600_001), true)
  report.data.snapshot_interval_seconds = 1
  assert.equal(profileModule.componentReportStale(report, receivedAt + 120_000), false)
  assert.equal(profileModule.componentReportStale(report, receivedAt + 120_001), true)
  report.data.snapshot_interval_seconds = 3600
  assert.equal(profileModule.componentReportStale(report, receivedAt + 7_200_000), false)
  assert.equal(profileModule.componentReportStale(report, receivedAt + 7_200_001), true)
  report.data.snapshot_interval_seconds = 86400
  assert.equal(profileModule.componentReportStale(report, receivedAt + 172_800_000), false)
  assert.equal(profileModule.componentReportStale(report, receivedAt + 172_800_001), true)
})

test('malformed or unbounded snapshot intervals cannot extend status freshness', () => {
  const receivedAt = Date.parse('2026-10-17T03:00:00Z')
  for (const interval of [undefined, null, 0, -1, NaN, Infinity, 300.5, '300', [], {}, 86401, Number.MAX_SAFE_INTEGER]) {
    const report = { received_at: new Date(receivedAt).toISOString(), data: { status_reporting: 'changes_only', snapshot_interval_seconds: interval } }
    assert.equal(profileModule.componentReportStale(report, receivedAt + 120_001), true, `interval: ${String(interval)}`)
  }
})

test('task output safely previews UTF-8 and preserves binary or malformed output boundaries', () => {
  assert.equal(eventLabels.taskOutputText(Buffer.from('任务输出\n<script>alert(1)</script>').toString('base64')), '任务输出\n<script>alert(1)</script>')
  assert.match(eventLabels.taskOutputText('/w=='), /二进制输出/)
  assert.match(eventLabels.taskOutputText('%%%'), /编码无效/)
  assert.equal(eventLabels.securityEventTitle({ kind: 'task_failed', message: 'Scheduled task failed' }), '计划任务执行失败')
})

test('four kernel switches are independent, off by default, and preserve loaded custom values', () => {
  const expected = { 'kernel.dmesg_restrict': '1', 'kernel.kptr_restrict': '2', 'net.ipv4.conf.all.rp_filter': '1', 'net.ipv4.tcp_syncookies': '1' }
  assert.deepEqual(profileModule.defaultSecurityProfile().policies.sysctl, {})
  assert.deepEqual(Object.fromEntries(profileModule.kernelPolicies.map(({ key, value }) => [key, value])), expected)
  let values = { 'kernel.kptr_restrict': '1', 'net.ipv4.ip_forward': '0' }
  const loaded = profileModule.mergeProfile(profileModule.defaultSecurityProfile(), { policies: { sysctl: values } })
  assert.equal(loaded.policies.sysctl['kernel.kptr_restrict'], '1')
  assert.equal(profileModule.advancedSysctl(values), 'net.ipv4.ip_forward = 0')
  assert.deepEqual(profileModule.mergeAdvancedSysctl(values, 'net.ipv4.ip_forward = 1'), { 'kernel.kptr_restrict': '1', 'net.ipv4.ip_forward': '1' })
  for (const [key, value] of Object.entries(expected)) {
    const before = { ...values }
    const enabled = profileModule.setKernelPolicy(values, key, true)
    assert.deepEqual(values, before, 'toggle must not mutate the loaded config in place')
    assert.equal(enabled[key], value)
    values = enabled
  }
  values = profileModule.setKernelPolicy(values, 'kernel.kptr_restrict', false)
  assert.equal(Object.hasOwn(values, 'kernel.kptr_restrict'), false)
  assert.equal(values['net.ipv4.tcp_syncookies'], '1')
  assert.equal(values['net.ipv4.ip_forward'], '0')
  assert.throws(() => profileModule.mergeAdvancedSysctl(values, 'kernel.kptr_restrict = 1'), /独立开关/)
})

test('policy summaries separate audit, enforcement and legacy unknown evidence', () => {
  const component = { name: 'policies', enabled: true, installed: true, running: false, state: 'drift' }
  assert.equal(profileModule.policyMode(component), '')
  assert.match(profileModule.policyState(component), /模式未上报/)
  assert.equal(profileModule.policyMode({ ...component, state: 'applied' }), '')
  assert.match(profileModule.policyState({ ...component, state: 'applied' }), /未上报核验结论/)
  assert.match(profileModule.policyState({ ...component, policy_mode: 'audit' }), /未执行加固/)
  assert.match(profileModule.policyState({ ...component, policy_mode: 'enforce' }), /加固结果偏离/)
  assert.equal(profileModule.policyMode({ ...component, state: 'audit', policy_mode: 'enforce' }), 'enforce')
  assert.equal(profileModule.policyMode({ ...component, state: 'audit', policy_mode: 'future' }), '')
  assert.equal(profileModule.policyState({ ...component, state: 'audit' }), '仅检查')
  assert.equal(profileModule.policyState({ ...component, state: 'audit', checks: [{ compliant: true }] }), '仅检查（已达标）')
  assert.equal(profileModule.policyState({ ...component, state: 'no_policies' }), '未选择加固策略')
  assert.equal(profileModule.policyState({ ...component, state: 'compliant', policy_mode: 'enforce' }), '加固检查已达标')
  assert.equal(profileModule.policyState({ ...component, state: 'error', policy_mode: 'audit' }), '策略检查失败')
})
