<script setup lang="ts">
import { computed } from 'vue'
import { componentNames, componentState, componentTruncation } from '../security-profile'
import { taskOutputText } from '../event-labels'
import type { SecurityComponent } from '../types'
const props = defineProps<{ data: Record<string, unknown>; type: string }>()
const fields = computed(() => [
  ['采集来源', 'source'], ['事件类型', 'kind'], ['级别', 'severity'], ['用户', 'user'], ['用户 UID', 'uid'], ['进程 PID', 'pid'], ['父进程 PPID', 'ppid'], ['来源 IP', 'source_ip'], ['来源端口', 'source_port'], ['认证方式', 'method'], ['会话 ID', 'session_id'], ['任务名称', 'task_name'], ['退出码', 'exit_code'], ['文件路径', 'path'], ['执行命令', 'command'], ['事件描述', 'message'],
].filter(([, key]) => props.data[key!] !== undefined && props.data[key!] !== null && props.data[key!] !== ''))
const components = computed(() => Array.isArray(props.data.components) ? props.data.components as SecurityComponent[] : [])
const details = computed(() => props.data.details && typeof props.data.details === 'object' && !Array.isArray(props.data.details) ? props.data.details as Record<string, unknown> : {})
const taskFields = computed(() => [['退出码', 'exit_code'], ['耗时 / 毫秒', 'elapsed_ms'], ['开始时间', 'started_at'], ['结束时间', 'finished_at'], ['执行错误', 'error']].filter(([, key]) => details.value[key!] !== undefined && details.value[key!] !== null))
const outputs = computed(() => ['stdout', 'stderr'].filter(stream => details.value[`${stream}_base64`] !== undefined).map(stream => ({ name: stream === 'stdout' ? '标准输出' : '标准错误', text: taskOutputText(details.value[`${stream}_base64`]), truncated: details.value[`${stream}_truncated`] === true })))
function text(key: string) { const value = props.data[key]; return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value) }
</script>
<template>
  <section class="security-event-detail"><dl v-if="fields.length" class="detail-grid"><div v-for="[label, key] in fields" :key="key" :class="{ full: ['path', 'command', 'message'].includes(key!) }"><dt>{{ label }}</dt><dd :class="{ mono: ['command', 'path', 'session_id'].includes(key!) }">{{ text(key!) }}</dd></div></dl><p v-if="type === 'component_status'" class="status-note">这是组件健康与配置执行状态记录；正常上报不表示产生安全告警。</p><p v-if="data.details_truncated === true" class="truncation-note">部分状态明细已省略或截断，请结合主机日志排查。</p><div v-for="component in components" :key="component.name" class="status-row"><strong>{{ componentNames[component.name] || component.name }}</strong><span>{{ componentState(component.state) }}</span><span v-if="component.version" class="mono">{{ component.version }}</span><p v-if="componentTruncation(component)" class="truncation-note">{{ componentTruncation(component) }}</p><p v-if="component.error || component.message">{{ component.error || component.message }}</p></div><section v-if="data.source === 'task'" class="task-result"><dl v-if="taskFields.length" class="detail-grid"><div v-for="[label,key] in taskFields" :key="key"><dt>{{ label }}</dt><dd>{{ details[key!] }}</dd></div></dl><div v-for="output in outputs" :key="output.name"><h4>{{ output.name }}<span v-if="output.truncated"> · 已截断，仅预览已采集部分</span></h4><pre>{{ output.text }}</pre></div><p v-if="details.cancelled" class="status-note">任务已取消。</p></section><details v-if="data.details"><summary>关联字段与事件明细</summary><pre>{{ JSON.stringify(data.details, null, 2) }}</pre></details></section>
</template>
<style scoped>
.security-event-detail { margin: 20px 0; }
dd { overflow-wrap: anywhere; white-space: pre-wrap; }
.status-note { color: #718198; font-size: 12px; line-height: 1.8; margin: 14px 0; }
.status-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 6px; margin-top: 8px; font-size: 12px; }
.status-row p { flex-basis: 100%; color: #b42318; overflow-wrap: anywhere; }
.truncation-note, .status-row .truncation-note { color: #93621b; font-size: 12px; line-height: 1.8; margin-top: 12px; }
.task-result { margin-top: 18px; }
.task-result h4 { font-size: 12px; margin-top: 18px; }
.task-result h4 span { color: #b07b22; font-weight: 400; }
details { margin-top: 16px; }
summary { cursor: pointer; font-size: 12px; color: #536f9c; }
pre { background: #f8faff; padding: 14px; max-height: 350px; overflow: auto; font-size: 12px; }
</style>
