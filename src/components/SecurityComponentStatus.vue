<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown, Download, LoaderCircle, RefreshCw, Search, Server, ShieldCheck } from 'lucide-vue-next'
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
const statusFilter = ref<'all' | 'error' | 'stale' | 'missing'>('all')
const connectionFilter = ref<'all' | 'online' | 'offline'>('all')
const expandedIPs = ref(new Set<string>())
const now = ref(Date.now())
const loading = ref(false)
const error = ref('')
const sessionError = ref('')
const downloadError = ref('')
const downloading = ref('')
const controller = new AbortController()
let timer: ReturnType<typeof setInterval> | undefined
const reportMap = computed(() => new Map(reports.value.map(report => [report.machine_ip, report])))
const allRows = computed(() => {
  const all = new Map(machines.value.map(machine => [machine.machine_ip, { ...machine, report: reportMap.value.get(machine.machine_ip) }]))
  for (const report of reports.value) if (!all.has(report.machine_ip)) all.set(report.machine_ip, { machine_ip: report.machine_ip, host: report.host, alias: '', connected: false, revision: '', status: 'unassigned', error: '', updated_at: null, applied_at: null, report })
  return [...all.values()].filter(row => !props.machineIP || row.machine_ip === props.machineIP)
    .sort((a, b) => a.machine_ip.localeCompare(b.machine_ip, 'en', { numeric: true }))
    .map(row => ({ ...row, counts: componentCounts(row.report) }))
})
const summary = computed(() => ({
  all: allRows.value.length,
  error: allRows.value.filter(row => row.counts.error > 0).length,
  stale: allRows.value.filter(row => row.report && stale(row.report)).length,
  missing: allRows.value.filter(row => !row.report).length,
}))
const rows = computed(() => {
  const term = search.value.trim().toLocaleLowerCase()
  return allRows.value.filter(row =>
    (!term || [row.machine_ip, row.host, row.alias].some(value => value?.toLocaleLowerCase().includes(term))) &&
    (connectionFilter.value === 'all' || row.connected === (connectionFilter.value === 'online')) &&
    (statusFilter.value === 'all' ||
      (statusFilter.value === 'error' && row.counts.error > 0) ||
      (statusFilter.value === 'stale' && row.report && stale(row.report)) ||
      (statusFilter.value === 'missing' && !row.report)))
})
const visible = computed(() => rows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
watch([search, statusFilter, connectionFilter, pageSize], () => { page.value = 1 })
watch(() => rows.value.length, total => { page.value = Math.min(page.value, Math.max(1, Math.ceil(total / pageSize.value))) })
watch(allRows, items => {
  const present = new Set(items.map(row => row.machine_ip))
  expandedIPs.value = new Set([...expandedIPs.value].filter(ip => present.has(ip)))
})
watch([sessionPage, sessionPageSize], () => { void refreshSessions() })
watch(() => props.refreshToken, () => { void refresh() })
watch(() => props.machineIP, () => { page.value = 1; sessionPage.value = 1; expandedIPs.value = new Set(); void refresh() })
function toggleDetails(ip: string) {
  const next = new Set(expandedIPs.value)
  if (next.has(ip)) next.delete(ip)
  else next.add(ip)
  expandedIPs.value = next
}
function clearFilters() { search.value = ''; statusFilter.value = 'all'; connectionFilter.value = 'all' }
function componentCounts(report?: ComponentReport) {
  const enabled = (report?.data.components || []).filter(component => component.enabled && component.state !== 'disabled')
  return { enabled: enabled.length, running: enabled.filter(component => component.running).length, error: enabled.filter(component => tone(component) === 'offline').length }
}
function time(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}
function stale(report: ComponentReport) { return componentReportStale(report, now.value) }
function inventory(report: ComponentReport): string {
  const value = report.data.inventory
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const data = value as Record<string, unknown>
  return [data.distribution || data.os, data.architecture, data.kernel ? `内核 ${data.kernel}` : '', data.cpu_count ? `${data.cpu_count} CPU` : '', typeof data.btf_available === 'boolean' ? data.btf_available ? 'BTF 可用' : 'BTF 不可用（检查 Tetragon 环境）' : ''].filter(Boolean).join(' · ')
}
function tone(component: SecurityComponent) {
  if (!component.enabled || component.state === 'disabled') return 'neutral'
  if (component.error || ['failed', 'error', 'install_failed', 'config_failed', 'degraded', 'unsupported', 'drift', 'stopped', 'missing', 'not_installed'].includes(component.state)) return 'offline'
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
    now.value = Date.now()
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
  <section class="panel component-panel" aria-label="组件运行状态">
    <div class="component-heading">
      <div><h2><ShieldCheck :size="20" />组件运行状态 <span class="count-tag">{{ summary.all }}</span></h2><p>每 10 秒刷新，展示每台 Agent 最近上报的状态。默认收起明细，点击“展开详情”查看组件、系统信息和完整状态。</p></div>
      <button class="button secondary small" :disabled="loading" @click="refresh"><RefreshCw :size="15" :class="{ spin: loading }" />刷新状态</button>
    </div>
    <p v-if="error" class="component-error" role="alert">{{ error }} 已保留上次读取的数据。</p>
    <template v-if="!machineIP">
      <div class="component-summary" aria-label="按组件状态筛选">
        <button v-for="filter in ([{ value: 'all', label: '全部机器', count: summary.all }, { value: 'error', label: '组件异常', count: summary.error }, { value: 'stale', label: '历史状态', count: summary.stale }, { value: 'missing', label: '未上报', count: summary.missing }] as const)" :key="filter.value" type="button" :class="{ active: statusFilter === filter.value }" :aria-pressed="statusFilter === filter.value" @click="statusFilter = filter.value"><span>{{ filter.label }}</span><strong>{{ filter.count }}</strong></button>
      </div>
      <div class="component-filters">
        <div class="component-search"><Search :size="16" /><input v-model="search" type="search" aria-label="搜索组件状态机器" placeholder="搜索 IP、主机名或别名…" /></div>
        <select v-model="connectionFilter" aria-label="主控连接状态"><option value="all">全部主控连接</option><option value="online">主控已连接</option><option value="offline">主控未连接</option></select>
        <button v-if="search || statusFilter !== 'all' || connectionFilter !== 'all'" type="button" class="button secondary small" @click="clearFilters">清空筛选</button>
      </div>
    </template>
    <div class="component-list-info"><span>筛选结果 <strong>{{ rows.length }}</strong> 台<span v-if="rows.length"> · 当前 {{ (page - 1) * pageSize + 1 }}–{{ Math.min(page * pageSize, rows.length) }} 台</span></span><div class="component-page-tools"><span>按 IP 排序 · 刷新保留当前页</span><label v-if="rows.length > pageSize">跳至 <select v-model="page" aria-label="组件状态跳转页码"><option v-for="number in Math.ceil(rows.length / pageSize)" :key="number" :value="number">第 {{ number }} 页</option></select></label></div></div>
    <Pagination class="component-pagination-top" :page="page" :page-size="pageSize" :total="rows.length" @change="page = $event" @resize="pageSize = $event" />
    <div class="component-list" :aria-busy="loading">
      <article v-for="row in visible" :key="row.machine_ip" class="component-machine">
        <header>
          <div class="component-identity"><strong>{{ row.alias || row.host || row.machine_ip }}</strong><span class="mono">{{ row.machine_ip }}<template v-if="row.host && row.host !== row.alias && row.host !== row.machine_ip"> · {{ row.host }}</template></span></div>
          <div class="component-overview"><span class="badge" :class="row.connected ? 'success' : 'neutral'">{{ row.connected ? '主控已连接' : '主控未连接' }}</span><span v-if="!row.report" class="badge neutral">尚未上报组件状态</span><span v-else class="badge" :class="stale(row.report) ? 'warning' : 'success'">{{ stale(row.report) ? '历史状态' : '最近已上报' }}</span><span v-if="row.counts.error" class="badge offline">{{ row.counts.error }} 个组件异常</span></div>
          <div class="component-brief"><span v-if="row.report?.data.components?.length">启用 {{ row.counts.enabled }} · 运行 {{ row.counts.running }}</span><span v-else>{{ row.report ? '暂无组件明细' : '等待 Agent 上报' }}</span><span v-if="row.report" class="component-received">接收 {{ time(row.report.received_at) }}</span></div>
          <button type="button" class="button secondary small component-detail-toggle" :aria-expanded="expandedIPs.has(row.machine_ip)" :aria-controls="`component-details-${row.machine_ip}`" :aria-label="`${expandedIPs.has(row.machine_ip) ? '收起' : '展开'} ${row.alias || row.host || row.machine_ip} ${row.machine_ip} 组件详情`" @click="toggleDetails(row.machine_ip)">{{ expandedIPs.has(row.machine_ip) ? '收起详情' : '展开详情' }}<ChevronDown :size="14" :class="{ expanded: expandedIPs.has(row.machine_ip) }" /></button>
        </header>
        <div v-if="expandedIPs.has(row.machine_ip)" :id="`component-details-${row.machine_ip}`" class="component-details">
          <p v-if="!row.report" class="component-empty-text">可能尚未升级 Agent、未启用 security，或组件状态尚未到达。请先下发组件配置，不能据此判断运行正常。</p>
          <template v-else>
            <p v-if="stale(row.report)" class="status-truncation">这是历史快照，请检查 Agent 连接及上报情况，不能据此确认组件当前仍在运行。</p>
            <p v-if="row.report.data.details_truncated === true" class="status-truncation">部分状态明细已省略或截断，请结合主机日志排查。</p>
            <p v-if="inventory(row.report)" class="machine-inventory">{{ inventory(row.report) }}</p>
            <div v-if="row.report.data.components?.length" class="component-grid">
              <div v-for="component in row.report.data.components" :key="component.name" class="component-tile">
                <div><strong>{{ componentNames[component.name] || component.name }}</strong><span class="badge" :class="tone(component)">{{ componentState(component.state) }}</span></div>
                <p>启用 {{ component.enabled ? '是' : '否' }} · 已安装 {{ component.installed ? '是' : '否' }} · 运行 {{ component.running ? '是' : '否' }}</p>
                <p v-if="component.version" class="mono">版本 {{ component.version }}</p>
                <p v-if="component.config_hash" class="mono" :title="component.config_hash">配置 {{ component.config_hash.slice(0, 16) }}</p>
                <p v-if="component.applied_at">应用于 {{ time(component.applied_at) }}</p>
                <p v-if="componentTruncation(component)" class="status-truncation">{{ componentTruncation(component) }}</p>
                <p v-if="component.error || component.message" :class="{ 'component-failure': tone(component) === 'offline' }">{{ component.error || component.message }}</p>
              </div>
            </div>
            <p v-else class="component-empty-text">Agent 已上报，但没有组件明细。</p>
            <footer><span>上报 {{ time(row.report.time) }} · 接收 {{ time(row.report.received_at) }}</span><details><summary>队列与完整状态</summary><pre>{{ JSON.stringify(row.report.data, null, 2) }}</pre></details></footer>
          </template>
        </div>
      </article>
      <div v-if="!visible.length" class="component-empty"><LoaderCircle v-if="loading && !allRows.length" :size="25" class="spin" /><Server v-else :size="25" /><p>{{ loading && !allRows.length ? '正在读取组件状态…' : allRows.length ? '没有符合筛选条件的机器，请调整搜索或筛选条件。' : '没有可显示的机器。Agent 接入后会出现在这里。' }}</p><button v-if="allRows.length" type="button" class="button secondary small" @click="clearFilters">清空筛选</button></div>
    </div>
    <Pagination v-if="rows.length" :page="page" :page-size="pageSize" :total="rows.length" @change="page = $event" @resize="pageSize = $event" />
    <p class="component-footnote">正常稳定快照默认约每 5 分钟上报；超过两个快照周期（至少 2 分钟）标记为历史状态，旧版 Agent 按 2 分钟判断。异常与恢复仍保留事件记录。</p>
  </section>
  <section class="panel component-panel"><div class="component-heading"><div><h2>sudo 会话文件 <span class="count-tag">{{ sessionsTotal }}</span></h2><p>开启“上传 sudo 会话文件”后可下载已收齐的录制文件。请按原文件名放入同一会话目录，再使用 sudoreplay 回放；初版不提供内置播放器。</p></div></div><p v-if="sessionError || downloadError" class="component-error" role="alert">{{ sessionError || downloadError }}</p><div v-if="sessions.length" class="table-scroll"><table class="session-table"><thead><tr><th>机器 / 会话</th><th>时间</th><th>录制文件</th></tr></thead><tbody><tr v-for="session in sessions" :key="session.id"><td><strong class="mono">{{ session.machine_ip }}</strong><span class="session-id mono">{{ session.session_id }}</span></td><td>{{ time(session.time) }}</td><td><div class="session-files"><button v-for="file in session.files" :key="file.name" class="button secondary small" :disabled="!file.complete || !!downloading" :title="file.complete ? `下载后保存为 ${file.name}` : `已接收 ${size(file.received_bytes)} / ${size(file.size)}`" @click="downloadFile(session, file.name)"><LoaderCircle v-if="downloading === `${session.id}/${file.name}`" class="spin" :size="13" /><Download v-else :size="13" />{{ file.name }} · {{ size(file.size) }}{{ file.complete ? '' : ' · 接收中' }}</button><span v-if="!session.files?.length" class="muted">尚无文件</span></div></td></tr></tbody></table></div><p v-else class="component-empty-text">暂无上传会话。事件索引与文件上传分别配置；未开启文件上传时仍可查看 sudo 事件。</p><Pagination v-if="sessionsTotal" :page="sessionPage" :page-size="sessionPageSize" :total="sessionsTotal" @change="sessionPage = $event" @resize="sessionPageSize = $event; sessionPage = 1" /></section>
</template>

<style scoped>
.component-panel { margin-bottom: 24px; overflow: hidden; }
.component-heading { padding: 22px; display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; }
.component-heading h2 { display: flex; gap: 9px; align-items: center; font-size: 16px; }
.component-heading p { color: #718198; font-size: 12px; margin-top: 8px; line-height: 1.8; max-width: 850px; }
.component-summary { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 22px 16px; }
.component-summary button { display: flex; align-items: center; gap: 18px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 7px; background: #fff; color: #718198; font-size: 12px; cursor: pointer; }
.component-summary button strong { font-size: 17px; color: #425d82; }
.component-summary button.active { border-color: #87a9e5; background: #f1f6ff; color: #325eab; }
.component-summary button:focus-visible { outline: 2px solid #648fd9; outline-offset: 2px; }
.component-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 22px 16px; }
.component-filters > select { width: auto; min-width: 145px; font-size: 12px; }
.component-search { position: relative; flex: 1; min-width: 180px; }
.component-search svg { position: absolute; top: 50%; transform: translateY(-50%); left: 12px; color: #91a0b7; }
.component-search input { padding-left: 36px; }
.component-list-info { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 8px; padding: 0 22px 12px; font-size: 11px; color: #718198; }
.component-page-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.component-page-tools label { display: flex; flex-direction: row; align-items: center; gap: 6px; font-size: inherit; font-weight: 400; }
.component-page-tools select { width: auto; min-height: 29px; padding: 5px 25px 5px 8px; font-size: 11px; }
.component-pagination-top { background: #f8faff; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
.component-list { padding: 0 22px 18px; display: flex; flex-direction: column; gap: 10px; }
.component-machine { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.component-machine header { padding: 14px 16px; display: grid; grid-template-columns: minmax(150px, 1.1fr) minmax(160px, 1fr) minmax(165px, 1fr) auto; align-items: center; gap: 14px; }
.component-identity { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.component-identity strong { font-size: 13px; overflow-wrap: anywhere; }
.component-identity .mono { color: #8390a5; font-size: 11px; overflow-wrap: anywhere; }
.component-overview { display: flex; flex-wrap: wrap; gap: 6px; }
.component-brief { display: flex; flex-direction: column; gap: 6px; color: #536f9c; font-size: 12px; }
.component-received { font-size: 11px; color: #8390a5; }
.component-detail-toggle { white-space: nowrap; }
.component-detail-toggle svg { transition: transform 0.15s; }
.component-detail-toggle svg.expanded { transform: rotate(180deg); }
.component-details { border-top: 1px solid var(--line); }
.component-footnote { border-top: 1px solid var(--line); padding: 12px 22px; font-size: 11px; line-height: 1.8; color: #8390a5; }
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
@media(max-width: 1100px) {
  .component-machine header { grid-template-columns: minmax(0, 1fr) auto; }
  .component-identity { grid-column: 1; grid-row: 1; }
  .component-detail-toggle { grid-column: 2; grid-row: 1; }
  .component-overview { grid-column: 1; grid-row: 2; }
  .component-brief { grid-column: 2; grid-row: 2; text-align: right; }
}
@media(max-width: 700px) {
  .component-heading { flex-direction: column; padding: 18px; }
  .component-summary, .component-filters { margin-left: 18px; margin-right: 18px; }
  .component-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .component-summary button { justify-content: space-between; gap: 8px; }
  .component-search { flex-basis: 100%; }
  .component-list { padding: 0 18px 18px; }
  .component-list-info, .component-footnote { padding-left: 18px; padding-right: 18px; }
  .component-machine header { gap: 12px; padding: 12px; }
  .component-overview { grid-column: 1 / -1; }
  .component-brief { grid-column: 1 / -1; grid-row: 3; flex-direction: row; flex-wrap: wrap; text-align: left; gap: 8px; }
  .component-grid { grid-template-columns: 1fr; }
}
</style>
