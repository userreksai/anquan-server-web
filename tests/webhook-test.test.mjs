import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

// Compile the actual request implementation with the existing TypeScript dependency.
const temp = mkdtempSync(join(tmpdir(), 'anquan-webhook-contract-'))
for (const source of ['api', 'webhook-test']) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../src/${source}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  writeFileSync(join(temp, `${source}.js`), outputText)
}
writeFileSync(join(temp, 'package.json'), '{"type":"commonjs"}')
const { requestWebhookTest } = createRequire(import.meta.url)(join(temp, 'webhook-test.js'))
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch; rmSync(temp, { recursive: true, force: true }) })

const accepted = { message: '接收接口确认成功', success: true, text: '实际测试正文', format: 'feishu', http_status: 200, business_code: 0, duration_ms: 12 }
function respond(body, status = 200) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
async function rejectsResult(body) {
  respond(body)
  const result = await requestWebhookTest('/webhooks/1/test', '测试配置')
  assert.equal(result.result, null)
  assert.match(result.error, /格式不匹配/)
}

test('verified Lark success preserves actual text and response metadata', async () => {
  respond(accepted)
  const result = await requestWebhookTest('/webhooks/1/test', 'Lark')
  assert.deepEqual(result.result, accepted)
  assert.equal(result.error, '')
})

test('HTTP 502 preserves rejection details rather than converting them to success', async () => {
  const rejected = { ...accepted, success: false, message: '业务码 9499：关键词不匹配', business_code: 9499 }
  respond(rejected, 502)
  const result = await requestWebhookTest('/webhooks/1/test', 'Lark')
  assert.deepEqual(result.result, rejected)
  assert.equal(result.error, '')
})

test('empty, legacy, malformed and HTML responses cannot become success', async () => {
  for (const body of [null, {}, { message: '测试通知发送成功' }, { ...accepted, text: '' }, { ...accepted, duration_ms: -1 }]) await rejectsResult(body)
  globalThis.fetch = async () => new Response('<html>frontend page</html>')
  const result = await requestWebhookTest('/webhooks/1/test', 'Lark')
  assert.equal(result.result, null)
  assert.match(result.error, /格式不匹配/)
})

test('success requires a 2xx delivery status and consistent integer zero business code', async () => {
  for (const body of [
    { ...accepted, http_status: undefined },
    { ...accepted, http_status: 500 },
    { ...accepted, http_status: 200.5 },
    { ...accepted, business_code: 9499 },
    { ...accepted, business_code: 0.5 },
    { ...accepted, business_code: '0' },
    { ...accepted, business_code: undefined },
    { ...accepted, format: 'wecom', business_code: undefined },
    { ...accepted, format: 'generic', business_code: 9499 },
  ]) await rejectsResult(body)
})

test('generic endpoints may accept delivery without a business code', async () => {
  const resultBody = { ...accepted, format: 'generic', business_code: undefined }
  respond(resultBody)
  const result = await requestWebhookTest('/webhooks/1/test', '自建服务')
  assert.equal(result.result?.success, true)
})

test('error HTTP response cannot claim success in the body', async () => {
  respond(accepted, 502)
  const result = await requestWebhookTest('/webhooks/1/test', 'Lark')
  assert.equal(result.result, null)
  assert.match(result.error, /格式不匹配/)
})

test('draft test sends the supplied current form without saving it', async () => {
  const draft = JSON.stringify({ name: '草稿', url: 'http://127.0.0.1/hook', format: 'feishu', enabled: false })
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify(accepted), { status: 200 })
  }
  await requestWebhookTest('/webhooks/test', '草稿', draft)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/webhooks/test')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.body, draft)
})

test('network errors and ordinary validation errors remain visible', async () => {
  globalThis.fetch = async () => { throw new Error('offline') }
  const network = await requestWebhookTest('/webhooks/test', '草稿')
  assert.equal(network.result, null)
  assert.match(network.error, /无法连接主控/)
  respond({ message: 'URL 无效' }, 400)
  const validation = await requestWebhookTest('/webhooks/test', '草稿')
  assert.equal(validation.result, null)
  assert.equal(validation.error, 'URL 无效')
})
