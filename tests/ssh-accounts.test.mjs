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
globalThis.document = { removeEventListener() {}, body: { style: { overflow: '' } } }
after(() => { globalThis.fetch = originalFetch; globalThis.document = originalDocument })
function loadModule(source, resolveImport = require) {
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(resolveImport, module, module.exports)
  return module.exports
}
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const apiModule = loadModule(read('../src/api.ts'))
const profileModule = loadModule(read('../src/security-profile.ts'))
const exampleModule = loadModule(read('../src/agent-config-template.ts'))
const accountsModule = loadModule(read('../src/ssh-accounts.ts'), name => {
  if (name === './security-profile') return profileModule
  throw new Error(`Unexpected dependency: ${name}`)
})
function mount(t, name, initialProps, dependencies = {}) {
  const { descriptor } = parse(read(`../src/components/${name}.vue`))
  const script = compileScript(descriptor, { id: `ssh-account-${name}` })
  const unmount = []
  const emitted = []
  const component = loadModule(script.content, name => {
    if (dependencies[name]) return dependencies[name]
    if (name === 'vue') return { ...vue, onMounted: () => {}, onBeforeUnmount: fn => unmount.push(fn) }
    if (name === '../api') return apiModule
    if (name === '../security-profile') return profileModule
    if (name === '../ssh-accounts') return accountsModule
    if (name === '../agent-config-template') return exampleModule
    if (name === 'lucide-vue-next') return new Proxy({}, { get: () => ({ render: () => null }) })
    if (name.endsWith('.vue')) return { default: { render: () => null } }
    throw new Error(`Unexpected dependency: ${name}`)
  }).default
  const props = vue.reactive(initialProps)
  const scope = vue.effectScope()
  const state = scope.run(() => component.setup(props, { expose() {}, emit: (name, ...values) => emitted.push([name, ...values]) }))
  t.after(() => { for (const fn of unmount) fn(); scope.stop() })
  async function render() {
    const template = compileTemplate({ source: descriptor.template.content, filename: `${name}.vue`, id: `ssh-account-${name}`, ssr: true, cssVars: descriptor.cssVars, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [])
    const { ssrRender } = loadModule(template.code)
    const context = {}
    const html = await renderToString(vue.createSSRApp({ ...component, setup: () => state, ssrRender }, props), context)
    return html + (context.teleports?.body || '')
  }
  return { state, props, emitted, unmount, render }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const tick = () => new Promise(resolve => setImmediate(resolve))
const machineA = '192.0.2.10'
const machineB = '192.0.2.11'
const user = (name = 'ops', uid = 1000, shell = '/bin/bash', login_shell = true) => ({ name, uid, gid: uid, shell, login_shell })
const snapshot = (overrides = {}) => ({ state: 'ready', source: '/etc/passwd', checked_at: new Date().toISOString(), total: 3, truncated: false, users: [user('root', 0), user(), user('daemon', 1, '/usr/sbin/nologin', false)], ...overrides })
const report = (overrides = {}, ip = machineA) => ({ machine_ip: ip, host: ip, time: new Date().toISOString(), received_at: new Date().toISOString(), data: { inventory: { ssh_accounts: snapshot(overrides) } } })
const machine = ip => ({ machine_ip: ip, alias: '', host: ip, connected: true, revision: '', status: 'unassigned', error: '', updated_at: null, applied_at: null })

test('account snapshots reject old agents, wrong machines, failed reads and malformed accounts', () => {
  const parse = accountsModule.sshAccountSnapshot
  assert.match(parse(undefined, machineA).message, /升级 Agent 并启用安全扩展/)
  assert.equal(parse({ ...report(), data: {} }, machineA).usable, false)
  assert.equal(parse(report(), machineB).usable, false)
  assert.match(parse(report({ state: 'error', error: 'permission denied' }), machineA).message, /permission denied/)
  assert.match(parse(report({ state: 'unsupported' }), machineA).message, /不支持/)
  for (const invalid of [
    { source: '/etc/shadow' }, { total: 1 }, { users: [user(), user()] },
    { total: 1, users: [user('ops*')] }, { total: 1, users: [{ ...user(), uid: 2 ** 32 }] },
    { total: 1, users: [{ ...user(), shell: '/bin/bash\n' }] },
  ]) assert.equal(parse(report(invalid), machineA).usable, false)
})

test('freshness requires both a current report and current host detection time; truncation is explicit', () => {
  const parse = accountsModule.sshAccountSnapshot
  const now = Date.now()
  assert.equal(parse(report(), machineA, now).usable, true)
  assert.equal(parse({ ...report(), received_at: new Date(now - 120_001).toISOString() }, machineA, now).usable, false)
  assert.equal(parse(report({ checked_at: new Date(now - 120_001).toISOString() }), machineA, now).usable, false)
  assert.equal(parse(report({ checked_at: 'invalid' }), machineA, now).usable, false)
  const periodic = report({ checked_at: new Date(now - 400_000).toISOString() })
  periodic.received_at = new Date(now - 400_000).toISOString()
  periodic.data.status_reporting = 'changes_only'
  periodic.data.snapshot_interval_seconds = 300
  assert.equal(parse(periodic, machineA, now).usable, true)
  assert.equal(parse(periodic, machineA, now + 201_000).usable, false)
  const limited = parse(report({ truncated: true, total: 300 }), machineA, now)
  assert.equal(limited.usable, true)
  assert.match(limited.message, /已截断.*3.*300/)
})

test('picker uses latest reported local accounts, never auto-selects root or noninteractive users', async t => {
  const { state, emitted, render } = mount(t, 'SshAccountPicker', { machineIP: machineA, disabled: false })
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `/api/security/status?machine_ip=${machineA}`)
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.method, undefined)
    return json({ items: [report()] })
  }
  await state.refreshAccounts()
  assert.equal(state.canSelect.value, true)
  assert.deepEqual([...state.selected.value], [])
  assert.deepEqual(state.visibleUsers.value.map(item => item.name), ['root', 'ops'])
  const html = await render()
  assert.match(html, /本地账户快照/)
  assert.match(html, /不会触发远程立即扫描/)
  assert.match(html, /下发目标已绑定/)
  assert.equal(/type="checkbox"[^>]* checked/.test(html), false)
  state.showNonLogin.value = true
  assert.equal(state.visibleUsers.value.length, 3)
  state.selected.value = ['ops', 'daemon', 'root', 'not-discovered']
  state.addSelected()
  assert.deepEqual(emitted, [['add', ['ops', 'root']]])
})

test('switching machines invalidates old accounts immediately and ignores late old-machine requests', async t => {
  const { state, props, emitted } = mount(t, 'SshAccountPicker', { machineIP: '', disabled: false })
  const pending = new Map()
  globalThis.fetch = (url, options) => new Promise(resolve => { pending.set(url, { resolve, signal: options.signal }) })
  state.chooseMachine(machineA)
  assert.deepEqual(emitted, [['target-machine', machineA]])
  props.machineIP = machineA
  state.selected.value = ['root']
  state.chooseMachine(machineB)
  assert.deepEqual([...state.selected.value], [])
  assert.equal(state.canSelect.value, false)
  props.machineIP = machineB
  pending.get(`/api/security/status?machine_ip=${machineB}`).resolve(json({ items: [report({ total: 1, users: [user('newuser')] }, machineB)] }))
  await tick()
  pending.get(`/api/security/status?machine_ip=${machineA}`).resolve(json({ items: [report()] }))
  await tick()
  assert.equal(state.report.value.machine_ip, machineB)
  assert.deepEqual(state.snapshot.value.users.map(item => item.name), ['newuser'])
  state.chooseMachine('')
  assert.equal(state.report.value, undefined)
  assert.equal(state.canSelect.value, false)
})

test('failed refresh, expiry, disabled controls and unmount prevent using a retained list', async t => {
  const { state, props, emitted, unmount } = mount(t, 'SshAccountPicker', { machineIP: machineA, disabled: false })
  globalThis.fetch = async () => json({ items: [report()] })
  await state.refreshAccounts()
  state.selected.value = ['ops']
  props.disabled = true
  state.addSelected()
  assert.equal(emitted.length, 0)
  props.disabled = false
  state.report.value = report({ checked_at: new Date(Date.now() - 120_001).toISOString() })
  state.addSelected()
  assert.equal(emitted.length, 0)
  globalThis.fetch = async () => json({ error: 'unavailable' }, 503)
  await state.refreshAccounts()
  assert.equal(state.canSelect.value, false)
  assert.equal(state.report.value, undefined)
  let finish
  globalThis.fetch = () => new Promise(resolve => { finish = resolve })
  const inFlight = state.refreshAccounts()
  for (const fn of unmount) fn()
  finish(json({ items: [report()] }))
  await inFlight
  assert.equal(state.report.value, undefined)
})

test('discovered users preserve manual allowlists and do not enable SSH or enforce; changing host removes only additions', async t => {
  const { state, props } = mount(t, 'SecurityProfileEditor', { yaml: 'server: []\n', disabled: false, targetMachineIP: machineA })
  state.loaded.value = true
  state.profile.value.policies.ssh.allow_users = ['manual', 'ops']
  state.addDiscoveredUsers(['ops', 'ubuntu'])
  assert.deepEqual([...state.profile.value.policies.ssh.allow_users], ['manual', 'ops', 'ubuntu'])
  assert.equal(state.profile.value.policies.ssh.enabled, false)
  assert.equal(state.profile.value.policies.mode, 'audit')
  state.dirty.value = false
  props.targetMachineIP = machineB
  assert.deepEqual([...state.profile.value.policies.ssh.allow_users], ['manual', 'ops'])
  assert.equal(state.dirty.value, true)
  state.addDiscoveredUsers(['ec2-user'])
  state.sshUsers.value = 'manual\nec2-user\nexplicit'
  props.targetMachineIP = ''
  assert.deepEqual([...state.profile.value.policies.ssh.allow_users], ['manual', 'ec2-user', 'explicit'])
  state.addDiscoveredUsers(['should-not-add'])
  assert.equal(state.profile.value.policies.ssh.allow_users.includes('should-not-add'), false)
  await vue.nextTick()
})

test('reading a different explicit YAML clears discovery provenance but composing the same source keeps it', async t => {
  const { state, props } = mount(t, 'SecurityProfileEditor', { yaml: 'server: []\n', disabled: false, targetMachineIP: machineA })
  globalThis.fetch = async (_, options) => {
    const payload = JSON.parse(options.body)
    return json({ yaml: payload.yaml, security: payload.security || { policies: { ssh: { allow_users: payload.yaml.startsWith('# explicitly') ? ['manual', 'ops'] : ['manual', 'ubuntu'] } } } })
  }
  await state.readYaml()
  state.addDiscoveredUsers(['ops'])
  await state.compose()
  props.targetMachineIP = machineB
  assert.deepEqual([...state.profile.value.policies.ssh.allow_users], ['manual', 'ubuntu'])
  state.addDiscoveredUsers(['ops'])
  props.yaml = '# explicitly loaded template\nserver: []\n'
  await state.readYaml()
  props.targetMachineIP = ''
  assert.deepEqual([...state.profile.value.policies.ssh.allow_users], ['manual', 'ops'])
})

test('picker initially disabled by template loading fetches machines and the bound snapshot when enabled', async t => {
  const { state, props } = mount(t, 'SshAccountPicker', { machineIP: machineA, disabled: true })
  const calls = []
  globalThis.fetch = async url => { calls.push(url); return json({ items: url.includes('/security/status') ? [report()] : [machine(machineA)] }) }
  await state.refreshMachines()
  await state.refreshAccounts()
  assert.equal(calls.length, 0)
  props.disabled = false
  await tick()
  assert.equal(calls.length, 2)
  assert.equal(state.machines.value.length, 1)
  assert.equal(state.canSelect.value, true)
})

test('actual parent template passes account-machine binding to delivery and clearing it propagates back to editor', async t => {
  let editorProps, deliveryProps, editorEmit, deliveryEmit
  const editor = { props: ['yaml', 'targetMachineIP'], setup(props, { emit }) { editorProps = props; editorEmit = emit; return () => null } }
  const delivery = { props: ['yaml', 'targetMachineIP'], setup(props, { emit }) { deliveryProps = props; deliveryEmit = emit; return () => null } }
  const { state, render } = mount(t, 'AgentEncryption', { showSecurity: true }, { './SecurityProfileEditor.vue': { default: editor }, './AgentConfigDelivery.vue': { default: delivery } })
  state.templateAction.value = ''
  await render()
  editorEmit('target-machine', machineA)
  await render()
  assert.equal(state.targetMachineIP.value, machineA)
  assert.equal(editorProps.targetMachineIP, machineA)
  assert.equal(deliveryProps.targetMachineIP, machineA)
  deliveryEmit('clear-target')
  await render()
  assert.equal(state.targetMachineIP.value, '')
  assert.equal(editorProps.targetMachineIP, '')
  assert.equal(deliveryProps.targetMachineIP, '')
})

test('delivery binds selection to the account machine and rejects manipulated cross-machine selections before POST', async t => {
  const { state, props } = mount(t, 'AgentConfigDelivery', { yaml: 'server: []\n', disabled: false, targetMachineIP: '' })
  state.items.value = [machine(machineA), machine(machineB)]
  state.selectedIPs.value = [machineB]
  props.targetMachineIP = machineA
  assert.deepEqual([...state.selectedIPs.value], [machineA])
  assert.deepEqual(state.filtered.value.map(item => item.machine_ip), [machineA])
  state.toggle(machineB)
  state.toggleVisible()
  assert.deepEqual([...state.selectedIPs.value], [machineA])
  let posts = 0
  globalThis.fetch = async () => { posts++; return json({ items: [] }) }
  for (const ips of [[machineB], [machineA, machineB], [machineA, 'unknown'], []]) {
    state.selectedIPs.value = ips
    await state.submit()
    assert.match(state.submitError.value, /绑定/)
  }
  assert.equal(posts, 0)
  props.targetMachineIP = ''
  assert.deepEqual([...state.selectedIPs.value], [])
  state.toggle(machineB)
  assert.deepEqual([...state.selectedIPs.value], [machineB])
})

test('bound delivery POST sends only that machine and disabled form cannot send stale YAML', async t => {
  const { state, props } = mount(t, 'AgentConfigDelivery', { yaml: 'server: []\n', disabled: false, targetMachineIP: machineA })
  state.items.value = [machine(machineA), machine(machineB)]
  state.selectedIPs.value = [machineA]
  const posts = []
  globalThis.fetch = async (_, options) => {
    if (options.method === 'POST') posts.push(JSON.parse(options.body))
    return json({ items: [machine(machineA), machine(machineB)] })
  }
  props.disabled = true
  await state.submit()
  assert.equal(posts.length, 0)
  props.disabled = false
  await state.submit()
  assert.deepEqual(posts, [{ yaml: 'server: []\n', machine_ips: [machineA] }])
})
