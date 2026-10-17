<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Download, LoaderCircle, RefreshCw, Search, Server, ShieldCheck } from 'lucide-vue-next'
import { api, ApiError, query } from '../api'
import { componentNames, componentReportStale, componentState, componentTruncation } from '../security-profile'
import type { AgentConfigDelivery, ComponentReport, PageResult, SecurityComponent, SudoSession } from '../types'
import Pagination from './Pagination.vue'

const props = defineProps<{ machineIP?: string; refreshToken?: number }>()
const machines = ref<AgentConfigDelivery[]>([])
const reports = ref<ComponentReport[]>([])
const sessions = ref<SudoSession[]>([])
const sessionsTotal = ref(0)
const page = ref(1)
const pageSize = ref(10)
const sessionPage = ref(1)
const sessionPageSize = ref(10)
const search = ref('')
const loading = ref(false)
const error = ref('')
const sessionError = ref('')
const downloadError = ref('')
const downloading = ref('')
const controller = new AbortController()
let timer: ReturnType<typeof setInterval> | undefined
const reportMap = computed(() => new Map(reports.value.map(report => [report.machine_ip, report])))
const rows = computed(() => {
  const all = new Map(machines.value.map(machine => [machine.machine_ip, { ...machine, report: reportMap.value.get(machine.machine_ip) }]))
  for (const report of reports.value) if (!all.has(report.machine_ip)) all.set(report.machine_ip, { machine_ip: report.machine_ip, host: report.host, alias: '', connected: false, revision: '', status: 'unassigned', error: '', updated_at: null, applied_at: null, report })
  const term = search.value.trim().toLocaleLowerCase()
  return [...all.values()].filter(row => (!props.machineIP || row.machine_ip === props.machineIP) && (!term || [row.machine_ip, row.host, row.alias].some(value => value?.toLocaleLowerCase().includes(term))))
})
const visible = computed(() => rows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
watch([search, pageSize], () => { page.value = 1 })
watch(() => rows.value.length, total => { page.value = Math.min(page.value, Math.max(1, Math.ceil(total / pageSize.value))) })
watch([sessionPage, sessionPageSize], () => { void refreshSessions() })
watch(() => props.refreshToken, () => { void refresh() })
watch(() => props.machineIP, () => { page.value = 1; sessionPage.value = 1; void refresh() })
function time(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}
function stale(report: ComponentReport) { return componentReportStale(report) }
function inventory(report: ComponentReport): string {
  const value = report.data.inventory
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const data = value as Record<string, unknown>
  return [data.distribution || data.os, data.architecture, data.kernel ? `内核 ${data.kernel}` : '', data.cpu_count ? `${data.cpu_count} CPU` : '', typeof data.btf_available === 'boolean' ? data.btf_available ? 'BTF 可用' : 'BTF 不可用（检查 Tetragon 环境）' : ''].filter(Boolean).join(' · ')
}
function tone(component: SecurityComponent) {
  if (!component.enabled || component.state === 'disabled') return 'neutral'
  if (component.error || ['failed', 'error', 'install_failed', 'config_failed', 'degraded', 'unsupported', 'drift'].includes(component.state)) return 'offline'
  if (component.running || ['applied', 'configured', 'ready', 'healthy', 'audit', 'audit_only'].includes(component.state)) return 'success'
  return 'warning'
}
async function refreshSessions() {
  if (controller.signal.aborted) return
  try {
    const value = await api<PageResult<SudoSession>>('/security/sudo-sessions' + query({ machine_ip: props.machineIP, page: sessionPage.value, page_size: sessionPageSize.value }), { signal: controller.signal })
    if (controller.signal.aborted) return
    sessions.value = value.items || []; sessionsTotal.value = value.total; sessionError.value = ''
  } catch (cause) { if (!controller.signal.aborted) sessionError.value = `读取 sudo 会话失败：${cause instanceof Error ? cause.message : '请重试。'}` }
}
async function refresh() {
  if (loading.value || controller.signal.aborted) return
  loading.value = true
  const results = await Promise.allSettled([
    api<{ items: AgentConfigDelivery[] }>('/settings/agent-config-deliveries', { signal: controller.signal }),
    api<{ items: ComponentReport[] }>('/security/status' + query({ machine_ip: props.machineIP }), { signal: controller.signal }),
    refreshSessions(),
  ])
  if (!controller.signal.aborted) {
    const [inventory, statuses] = results
    if (inventory.status === 'fulfilled') machines.value = inventory.value.items || []
    if (statuses.status === 'fulfilled') reports.value = statuses.value.items || []
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    error.value = failed.map(result => result.reason instanceof Error ? result.reason.message : '读取组件状态失败。').join('；')
  }
  loading.value = false
}
async function downloadFile(session: SudoSession, name: string) {
  if (downloading.value) return
  downloading.value = `${session.id}/${name}`; downloadError.value = ''
  try {
    const response = await fetch(`/api/security/sudo-sessions/${session.id}/files/${encodeURIComponent(name)}`, { credentials: 'same-origin', signal: controller.signal })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      if (response.status === 401) window.dispatchEvent(new Event('auth-expired'))
      throw new ApiError(body?.error || body?.message || `下载失败（${response.status}）`, response.status)
    }
    const blob = await response.blob()
    if (controller.signal.aborted) return
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${session.machine_ip}-${session.session_id.replace(/[^\w.-]/g, '_')}-${name}`; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (cause) { if (!controller.signal.aborted) downloadError.value = cause instanceof Error ? cause.message : '下载失败，请重试。' }
  finally { downloading.value = '' }
}
function size(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB` }
onMounted(() => { void refresh(); timer = setInterval(() => { if (!document.hidden) void refresh() }, 10_000) })
onBeforeUnmount(() => { controller.abort(); clearInterval(timer) })
</script>

<template>
  <section class="panel component-panel">
    <div class="component-heading"><div><h2><ShieldCheck :size="20" />组件运行状态 <span class="count-tag">{{ rows.length }}</span></h2><p>展示每台 Agent 最近实际上报的组件状态，每 10 秒刷新页面。正常稳定只更新最新快照，异常、状态变化和恢复保留事件记录。新版 Agent 默认正常稳定约每 5 分钟发送快照，长检查周期按实际周期刷新，超过两个快照周期（至少 2 分钟）未收到会标记为历史状态；旧版 Agent 仍按 2 分钟判断。</p></div><button class="button secondary small" :disabled="loading" @click="refresh"><RefreshCw :size="15" :class="{ spin: loading }" />刷新状态</button></div>
    <p v-if="error" class="component-error" role="alert">{{ error }} 已保留上次读取的数据。</p>
    <div v-if="!machineIP" class="component-search"><Search :size="16" /><input v-model="search" type="search" aria-label="搜索组件状态机器" placeholder="搜索 IP、主机名或别名…" /></div>
    <div class="component-list" :aria-busy="loading">
      <article v-for="row in visible" :key="row.machine_ip" class="component-machine"><header><div><strong>{{ row.alias || row.host || row.machine_ip }}</strong><span class="mono">{{ row.machine_ip }}</span></div><span v-if="!row.report" class="badge neutral">尚未上报组件状态</span><span v-else class="badge" :class="stale(row.report) ? 'warning' : 'success'">{{ stale(row.report) ? '历史状态 · 请检查连接' : '最近已上报' }}</span></header><p v-if="!row.report" class="component-empty-text">可能尚未升级 Agent、未启用 security，或组件状态尚未到达。请先下发组件配置，不能据此判断运行正常。</p><template v-else><p v-if="row.report.data.details_truncated === true" class="status-truncation">部分状态明细已省略或截断，请结合主机日志排查。</p><p v-if="inventory(row.report)" class="machine-inventory">{{ inventory(row.report) }}</p><div v-if="row.report.data.components?.length" class="component-grid"><div v-for="component in row.report.data.components" :key="component.name" class="component-tile"><div><strong>{{ componentNames[component.name] || component.name }}</strong><span class="badge" :class="tone(component)">{{ componentState(component.state) }}</span></div><p>启用 {{ component.enabled ? '是' : '否' }} · 已安装 {{ component.installed ? '是' : '否' }} · 运行 {{ component.running ? '是' : '否' }}</p><p v-if="component.version" class="mono">版本 {{ component.version }}</p><p v-if="component.config_hash" class="mono" :title="component.config_hash">配置 {{ component.config_hash.slice(0, 16) }}</p><p v-if="component.applied_at">应用于 {{ time(component.applied_at) }}</p><p v-if="componentTruncation(component)" class="status-truncation">{{ componentTruncation(component) }}</p><p v-if="component.error || component.message" :class="{ 'component-failure': tone(component) === 'offline' }">{{ component.error || component.message }}</p></div></div><p v-else class="component-empty-text">Agent 已上报，但没有组件明细。</p><footer><span>上报 {{ time(row.report.time) }} · 接收 {{ time(row.report.received_at) }}</span><details><summary>队列与完整状态</summary><pre>{{ JSON.stringify(row.report.data, null, 2) }}</pre></details></footer></template></article>
      <div v-if="!visible.length" class="component-empty"><LoaderCircle v-if="loading" :size="25" class="spin" /><Server v-else :size="25" /><p>{{ loading ? '正在读取组件状态…' : '没有可显示的机器。Agent 接入后会出现在这里。' }}</p></div>
    </div><Pagination v-if="rows.length > pageSize" :page="page" :page-size="pageSize" :total="rows.length" :disabled="loading" @change="page = $event" @resize="pageSize = $event" />
  </section>
  <section class="panel component-panel"><div class="component-heading"><div><h2>sudo 会话文件 <span class="count-tag">{{ sessionsTotal }}</span></h2><p>开启“上传 sudo 会话文件”后可下载已收齐的录制文件。请按原文件名放入同一会话目录，再使用 sudoreplay 回放；初版不提供内置播放器。</p></div></div><p v-if="sessionError || downloadError" class="component-error" role="alert">{{ sessionError || downloadError }}</p><div v-if="sessions.length" class="table-scroll"><table class="session-table"><thead><tr><th>机器 / 会话</th><th>时间</th><th>录制文件</th></tr></thead><tbody><tr v-for="session in sessions" :key="session.id"><td><strong class="mono">{{ session.machine_ip }}</strong><span class="session-id mono">{{ session.session_id }}</span></td><td>{{ time(session.time) }}</td><td><div class="session-files"><button v-for="file in session.files" :key="file.name" class="button secondary small" :disabled="!file.complete || !!downloading" :title="file.complete ? `下载后保存为 ${file.name}` : `已接收 ${size(file.received_bytes)} / ${size(file.size)}`" @click="downloadFile(session, file.name)"><LoaderCircle v-if="downloading === `${session.id}/${file.name}`" class="spin" :size="13" /><Download v-else :size="13" />{{ file.name }} · {{ size(file.size) }}{{ file.complete ? '' : ' · 接收中' }}</button><span v-if="!session.files?.length" class="muted">尚无文件</span></div></td></tr></tbody></table></div><p v-else class="component-empty-text">暂无上传会话。事件索引与文件上传分别配置；未开启文件上传时仍可查看 sudo 事件。</p><Pagination v-if="sessionsTotal" :page="sessionPage" :page-size="sessionPageSize" :total="sessionsTotal" @change="sessionPage = $event" @resize="sessionPageSize = $event; sessionPage = 1" /></section>
</template>

<style scoped>
.component-panel { margin-bottom: 24px; overflow: hidden; }
.component-heading { padding: 22px; display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; }
.component-heading h2 { display: flex; gap: 9px; align-items: center; font-size: 16px; }
.component-heading p { color: #718198; font-size: 12px; margin-top: 8px; line-height: 1.8; max-width: 850px; }
.component-search { position: relative; margin: 0 22px 16px; }
.component-search svg { position: absolute; top: 13px; left: 12px; color: #91a0b7; }
.component-search input { padding-left: 36px; }
.component-list { padding: 0 22px 22px; display: flex; flex-direction: column; gap: 16px; }
.component-machine { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.component-machine header { padding: 14px 16px; background: #f8faff; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
.component-machine header div { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.component-machine header span.mono { color: #8390a5; font-size: 12px; }
.machine-inventory { margin: 14px 16px 0; font-size: 12px; line-height: 1.8; color: #536f9c; overflow-wrap: anywhere; }
.component-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; padding: 16px; }
.component-tile { padding: 13px; border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.component-tile > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.component-tile strong { font-size: 12px; }
.component-tile p { font-size: 11px; color: #718198; margin-top: 8px; line-height: 1.7; overflow-wrap: anywhere; }
.status-truncation { margin: 12px 16px 0; font-size: 12px; line-height: 1.8; color: #93621b; }
.component-tile .status-truncation { color: #93621b; margin-left: 0; margin-right: 0; }
.component-tile .component-failure { color: #b42318; }
.component-machine footer { border-top: 1px solid var(--line); padding: 12px 16px; color: #8390a5; font-size: 11px; line-height: 1.8; }
.component-machine summary { cursor: pointer; color: #536f9c; margin-top: 6px; }
.component-machine pre { overflow: auto; max-height: 300px; background: #f8faff; padding: 12px; }
.component-empty, .component-empty-text { color: #8390a5; font-size: 12px; padding: 18px; line-height: 1.8; }
.component-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.component-error { color: #b42318; background: #fff0ed; font-size: 12px; line-height: 1.8; border-radius: 7px; padding: 12px; margin: 0 22px 18px; }
.session-table { min-width: 650px; font-size: 12px; }
.session-table th, .session-table td { padding: 15px 22px; border-bottom: 1px solid var(--line); }
.session-table th { background: #f8faff; font-weight: 500; color: #8291a7; }
.session-id { display: block; color: #8390a5; font-size: 11px; margin-top: 6px; }
.session-files { display: flex; flex-wrap: wrap; gap: 8px; }
@media(max-width: 700px) { .component-heading { flex-direction: column; padding: 18px; } .component-list { padding: 0 18px 18px; } .component-grid { grid-template-columns: 1fr; } }
</style>
