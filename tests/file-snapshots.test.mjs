import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'
import * as vue from 'vue'
import { renderToString } from 'vue/server-renderer'

const require = createRequire(import.meta.url)
const { parse, compileScript, compileTemplate } = require('vue/compiler-sfc')
function loadModule(source, resolveImport = require) {
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(resolveImport, module, module.exports)
  return module.exports
}
const modules = new Map()
function sourceModule(name) {
  if (!modules.has(name)) modules.set(name, loadModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), imported => imported.startsWith('./') ? sourceModule(imported.slice(2)) : require(imported)))
  return modules.get(name)
}
const { fileSnapshots } = sourceModule('file-snapshots')
const { securityEventTitle } = sourceModule('event-labels')
const event = (details = {}, overrides = {}) => ({ source: 'native_fim', kind: 'file_change', path: '/usr/local/123/123.sh', details: { change: 'modified', ...details }, ...overrides })
const before = { type: 'file', size: 12, sha256: 'a'.repeat(64) }
const after = { type: 'file', size: 24, sha256: 'b'.repeat(64) }

test('file snapshots are restricted to native FIM file-change events', () => {
  for (const data of [{}, event({}, { source: 'auditd' }), event({}, { kind: 'collection_error' }), event({}, { source: { name: 'native_fim' } })]) assert.deepEqual(fileSnapshots(data), [])
})

test('modified files retain separate before and after contents with validated metadata', () => {
  const snapshots = fileSnapshots(event({ before, after, previous_text: '#!/bin/sh\necho before\n', previous_content_status: 'captured', current_text: '#!/bin/sh\necho after\n', current_content_status: 'captured' }))
  assert.equal(snapshots.length, 2)
  assert.deepEqual(snapshots.map(item => item.key), ['previous', 'current'])
  assert.deepEqual(snapshots.map(item => item.text), ['#!/bin/sh\necho before\n', '#!/bin/sh\necho after\n'])
  assert.deepEqual(snapshots.map(item => item.sha256), [before.sha256, after.sha256])
  assert.deepEqual(snapshots.map(item => item.size), [12, 24])
  for (const snapshot of snapshots) {
    assert.equal(snapshot.status, 'captured')
    assert.equal(snapshot.truncated, false)
    assert.equal(typeof snapshot.label, 'string')
    assert.ok(snapshot.label.length > 0)
    assert.equal(typeof snapshot.statusLabel, 'string')
    assert.ok(snapshot.statusLabel.length > 0)
    assert.equal(typeof snapshot.note, 'string')
  }
})

test('added and deleted events distinguish non-existent sides from missing evidence', () => {
  const added = fileSnapshots(event({ change: 'added', after, current_text: 'echo created', current_content_status: 'captured' }))
  assert.equal(added[0].status, 'not_applicable')
  assert.equal(added[0].text, null)
  assert.equal(added[1].text, 'echo created')
  const deleted = fileSnapshots(event({ change: 'deleted', before, previous_text: 'echo deleted', previous_content_status: 'captured' }))
  assert.equal(deleted[0].text, 'echo deleted')
  assert.equal(deleted[1].status, 'not_applicable')
  assert.equal(deleted[1].text, null)
  const missing = fileSnapshots(event({ change: 'modified' }))
  assert.deepEqual(missing.map(item => item.status), ['unavailable', 'unavailable'])
  assert.deepEqual(missing.map(item => item.text), [null, null])
  assert.ok(missing.every(item => item.note.length > 0 || item.statusLabel.length > 0))
})

test('empty and truncated contents never look like a complete missing snapshot', () => {
  const snapshots = fileSnapshots(event({ previous_content_status: 'empty', previous_text: '', current_content_status: 'truncated', current_text: '#!/bin/sh\npart', current_text_truncated: true }))
  assert.equal(snapshots[0].status, 'empty')
  assert.equal(snapshots[0].text, '')
  assert.equal(snapshots[0].truncated, false)
  assert.equal(snapshots[1].status, 'truncated')
  assert.equal(snapshots[1].text, '#!/bin/sh\npart')
  assert.equal(snapshots[1].truncated, true)
  const flagged = fileSnapshots(event({ current_content_status: 'captured', current_text: 'limited', current_text_truncated: true }))[1]
  assert.equal(flagged.truncated, true)
})

test('unavailable, disabled, binary and sensitive snapshots cannot reveal an attached text field', () => {
  for (const status of ['binary', 'sensitive', 'disabled', 'unavailable']) {
    const snapshot = fileSnapshots(event({ current_content_status: status, current_text: 'must not display stale content' }))[1]
    assert.equal(snapshot.status, status)
    assert.equal(snapshot.text, null)
    assert.ok(snapshot.statusLabel.length > 0)
  }
})

test('legacy events retain string evidence but explicitly describe absent and transport-omitted contents', () => {
  const snapshots = fileSnapshots(event({ previous_text: 'old retained body', current_text: '', before, after }))
  assert.equal(snapshots[0].text, 'old retained body')
  assert.equal(snapshots[0].status, 'captured')
  assert.equal(snapshots[1].text, '')
  assert.equal(snapshots[1].status, 'empty')
  const omitted = fileSnapshots(event({ text_omitted_transport_limit: true }))
  for (const snapshot of omitted) {
    assert.equal(snapshot.status, 'unavailable')
    assert.equal(snapshot.text, null)
    assert.match(snapshot.note + snapshot.statusLabel, /传输|上报|大小|限|省略/)
  }
})

test('malformed contents and metadata cannot be coerced into credible file evidence', () => {
  for (const details of [null, [], 'invalid', 17]) {
    const snapshots = fileSnapshots(event({}, { details }))
    assert.equal(snapshots.length, 2)
    assert.ok(snapshots.every(item => item.status === 'unavailable' && item.text === null))
  }
  const malformed = fileSnapshots(event({ previous_text: { command: 'not plaintext' }, previous_content_status: 'captured', before: { type: 'file', size: -1, sha256: 'not-a-digest' }, current_text: ['not plaintext'], current_content_status: 'future_status', after: { size: '24', sha256: '<script>' } }))
  for (const snapshot of malformed) {
    assert.equal(snapshot.status, 'unavailable')
    assert.equal(snapshot.text, null)
    assert.equal(snapshot.size, null)
    assert.equal(snapshot.sha256, '')
    assert.doesNotMatch(snapshot.note, /\[object Object\]/)
  }
  const invalidStatus = fileSnapshots(event({ current_text: 'body', current_content_status: 'future_status', current_text_truncated: 'true' }))[1]
  assert.equal(invalidStatus.status, 'unavailable')
  assert.equal(invalidStatus.text, null)
  assert.equal(invalidStatus.truncated, false)
})

test('oversized legacy text is visibly truncated without breaking a Unicode surrogate pair', () => {
  const text = 'x'.repeat(65535) + '😀' + 'tail'
  const snapshot = fileSnapshots(event({ current_text: text, current_content_status: 'captured' }))[1]
  assert.equal(snapshot.status, 'truncated')
  assert.equal(snapshot.truncated, true)
  assert.equal(snapshot.text, 'x'.repeat(65535))
  assert.match(snapshot.note + snapshot.statusLabel, /截断|前缀|完整/)
})

test('non-regular and explicitly empty files preserve their distinct evidence states', () => {
  const snapshots = fileSnapshots(event({ before: { type: 'directory', size: 4096 }, previous_content_status: 'not_applicable', after: { type: 'file', size: 0 }, current_content_status: 'empty' }))
  assert.equal(snapshots[0].status, 'not_applicable')
  assert.equal(snapshots[0].text, null)
  assert.equal(snapshots[1].status, 'empty')
  assert.equal(snapshots[1].text, '')
})

test('native FIM list titles identify the user-visible added, modified and deleted operation', () => {
  const labels = { added: '新增文件', modified: '文件内容或属性已修改', deleted: '文件已删除', missing: '监控文件不存在' }
  for (const [change, label] of Object.entries(labels)) assert.equal(securityEventTitle(event({ change })), label)
  assert.equal(securityEventTitle(event({ change: 'added' }, { source: 'other' })), '文件发生变化')
  assert.equal(securityEventTitle(event({}, { details: null })), '文件发生变化')
  assert.equal(securityEventTitle({ kind: 'file_added' }), '新增文件')
})

function detailsComponent(filename = 'SecurityEventDetails.vue') {
  const { descriptor } = parse(readFileSync(new URL(`../src/components/${filename}`, import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: 'file-evidence-contract' })
  const template = compileTemplate({ source: descriptor.template.content, filename, id: 'file-evidence-contract', ssr: true, cssVars: descriptor.cssVars || [], compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const { ssrRender } = loadModule(template.code)
  const component = loadModule(script.content, name => name === './PolicyStatusDetails.vue' ? detailsComponent('PolicyStatusDetails.vue') : name === 'vue' ? vue : name.startsWith('../') ? sourceModule(name.slice(3)) : require(name)).default
  return { ...component, ssrRender }
}

test('policy check details show expected, actual, diagnostics and unknown legacy modes as escaped text', async () => {
  const component = { name: 'policies', enabled: true, installed: true, running: false, state: 'audit_drift', policy_mode: 'audit', checked_at: '2026-10-23T01:02:03Z', checks: [
    { setting: 'sysctl.kernel.kptr_restrict', expected: '2', actual: '1', compliant: false, message: 'only checked' },
    { setting: 'ssh.allow_sources', expected: '192.0.2.0/24', actual: '', compliant: false, error: '<script>denied</script>' },
  ] }
  const html = await renderToString(vue.createSSRApp(detailsComponent('PolicyStatusDetails.vue'), { component }))
  assert.match(html, /仅检查（audit），未执行新的加固/)
  assert.match(html, /检查时间：[^<]*2026/)
  assert.match(html, /未达标 2 项/)
  assert.match(html, /检查失败 1 项/)
  assert.match(html, /目标<\/dt><dd>2<\/dd>/)
  assert.match(html, /实际<\/dt><dd>1<\/dd>/)
  assert.match(html, /only checked/)
  assert.match(html, /&lt;script&gt;denied&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>/)
  const legacy = await renderToString(vue.createSSRApp(detailsComponent('PolicyStatusDetails.vue'), { component: { ...component, policy_mode: undefined, checked_at: undefined, state: 'drift', checks: [] } }))
  assert.match(legacy, /旧版或未知模式/)
  assert.match(legacy, /检查时间：未上报/)
  assert.match(legacy, /未包含检查明细/)
})

test('event detail shows captured script text as escaped text, including the retained deleted body', async () => {
  const payload = '#!/bin/sh\n<script>alert("x")</script>\necho & done'
  const data = event({ change: 'deleted', before, previous_content_status: 'captured', previous_text: payload })
  const html = await renderToString(vue.createSSRApp(detailsComponent(), { data, type: 'security_event' }))
  assert.match(html, /#!\/bin\/sh/)
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/)
  assert.match(html, /echo &amp; done/)
  assert.doesNotMatch(html, /<script>|v-html=/)
  assert.match(html, new RegExp(before.sha256))
  assert.match(html, /<pre[^>]*>[^]*#!\/bin\/sh/)
})

test('event detail exposes absence and truncation without presenting invented or complete contents', async () => {
  const data = event({ previous_content_status: 'unavailable', current_content_status: 'truncated', current_text: 'echo partial', current_text_truncated: true })
  const html = await renderToString(vue.createSSRApp(detailsComponent(), { data, type: 'security_event' }))
  assert.match(html, /echo partial/)
  assert.match(html, /截断/)
  assert.match(html, /未|无法|不可|缺少/)
  assert.doesNotMatch(html, /\[object Object\]/)
})
