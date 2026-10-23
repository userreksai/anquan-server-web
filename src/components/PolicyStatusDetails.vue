<script setup lang="ts">
import { computed } from 'vue'
import { policyCheckName, policyMode } from '../security-profile'
import type { SecurityComponent } from '../types'

const props = defineProps<{ component: SecurityComponent }>()
const checks = computed(() => (props.component.checks || []).filter(check => check && typeof check === 'object'))
const failed = computed(() => checks.value.filter(check => check.compliant === false).length)
const unknown = computed(() => checks.value.filter(check => typeof check.compliant !== 'boolean').length)
const errors = computed(() => checks.value.filter(check => typeof check.error === 'string' && check.error).length)
function time(value?: string) { return value && !Number.isNaN(new Date(value).valueOf()) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未上报' }
function value(raw: unknown) { return raw === '' || raw === undefined || raw === null ? '未取得值' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw) }
</script>

<template>
  <div class="policy-status-details">
    <p>策略模式：{{ policyMode(component) === 'audit' ? '仅检查（audit），未执行新的加固' : policyMode(component) === 'enforce' ? '执行加固（enforce），定期核验并修复所选策略' : '旧版或未知模式未提供可识别状态，请核对已下发 YAML' }}</p>
    <p>检查时间：{{ time(component.checked_at) }} · 已上报 {{ checks.length }} 项 · 未达标 {{ failed }} 项<template v-if="errors"> · 检查失败 {{ errors }} 项</template><template v-if="unknown"> · 结果未知 {{ unknown }} 项</template></p>
    <p v-if="!checks.length" class="muted">{{ component.state === 'no_policies' ? '当前没有选择具体策略。' : '此快照未包含检查明细，请结合完整状态和 Agent 日志确认。' }}</p>
    <details v-if="checks.length" :open="failed > 0"><summary>逐项策略检查</summary>
      <article v-for="(check, index) in checks" :key="`${String(check.setting)}-${index}`" class="policy-check" :class="{ failed: check.compliant === false }">
        <strong>{{ policyCheckName(check.setting) }} · {{ check.error ? '检查失败' : check.compliant === true ? '达标' : check.compliant === false ? '未达标' : '未知' }}</strong>
        <code>{{ check.setting }}</code>
        <dl><div><dt>目标</dt><dd>{{ value(check.expected) }}</dd></div><div><dt>实际</dt><dd>{{ value(check.actual) }}</dd></div><div v-if="check.message"><dt>说明</dt><dd>{{ value(check.message) }}</dd></div><div v-if="check.error"><dt>检查错误</dt><dd>{{ value(check.error) }}</dd></div></dl>
        <p v-if="check.truncated" class="muted">本项长文本已截断。</p>
      </article>
    </details>
  </div>
</template>

<style scoped>
.policy-status-details { font-size: 12px; line-height: 1.7; width: 100%; }
p { margin: 7px 0; overflow-wrap: anywhere; }
summary { cursor: pointer; margin-top: 10px; }
.policy-check { padding: 11px; margin-top: 9px; border: 1px solid var(--line); border-radius: 6px; }
.policy-check.failed { border-color: #e7cbb2; background: #fffbf4; }
code { display: block; color: #718198; overflow-wrap: anywhere; margin-top: 3px; }
dl { margin: 8px 0 0; }
dl > div { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 8px; margin-top: 4px; }
dt { color: #718198; }
dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.muted { color: #718198; }
</style>
