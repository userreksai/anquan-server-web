<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowUpCircle, CheckCheck, HardDriveDownload, LoaderCircle, Package, RefreshCw, Search, Server, ShieldCheck } from 'lucide-vue-next'
import { api } from '../api'
import { agentUpdateReason, agentUpdateStatusClass, agentUpdateStatusLabel, parseAgentUpdateSettings, reconcileAgentUpdateSelection } from '../agent-updates'
import type { AgentUpdateMachine, AgentUpdateSettings } from '../agent-updates'
import Pagination from './Pagination.vue'

const props = defineProps<{ refreshToken?: string }>()
const settings = ref<AgentUpdateSettings | null>(null)
const selectedIPs = ref<string[]>([])
const search = ref('')
const page = ref(1)
const pageSize = ref(10)
const loading = ref(false)
const working = ref<'package' | 'submit' | ''>('')
const loadError = ref('')
const actionError = ref('')
const message = ref('')
const selectionNotice = ref('')
const review = ref<{ sha256: string; version: string; ips: string[] } | null>(null)
const controller = new AbortController()
let poll: ReturnType<typeof setInterval> | undefined
const release = computed(() => settings.value?.release ?? null)
const selectedSet = computed(() => new Set(selectedIPs.value))
const selected = computed(() => settings.value?.items.filter(item => selectedSet.value.has(item.machine_ip)) ?? [])
const busy = computed(() => loading.value || working.value !== '')
const filtered = computed(() => {
  const value = search.value.trim().toLocaleLowerCase()
  return settings.value?.items.filter(item => [item.machine_ip, item.host, item.alias].some(field => field?.toLocaleLowerCase().includes(value))) ?? []
})
const visible = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
const eligibleVisible = computed(() => visible.value.filter(item => !reason(item)))
const allVisibleSelected = computed(() => eligibleVisible.value.length > 0 && eligibleVisible.value.every(item => selectedSet.value.has(item.machine_ip)))
const someVisibleSelected = computed(() => eligibleVisible.value.some(item => selectedSet.value.has(item.machine_ip)))
const reviewMachines = computed(() => settings.value?.items.filter(item => review.value?.ips.includes(item.machine_ip)) ?? [])
const running = computed(() => settings.value?.items.filter(item => ['pending', 'downloading', 'restarting'].includes(item.status)).length ?? 0)
const reason = (item: AgentUpdateMachine) => agentUpdateReason(item, release.value)
const displayTime = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
function bytes(size: number) { return size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(2)} MiB` }
watch([search, pageSize], () => { page.value = 1 })
watch(() => filtered.value.length, total => { page.value = Math.min(page.value, Math.max(1, Math.ceil(total / pageSize.value))) })

function adopt(value: unknown) {
  const next = parseAgentUpdateSettings(value)
  const hadSettings = settings.value !== null
  const result = reconcileAgentUpdateSelection(selectedIPs.value, release.value?.sha256 ?? null, next)
  if (result.releaseChanged && hadSettings) {
    selectionNotice.value = '更新包已变更，已清空原来的机器选择。请核对新版本后重新选择。'
    review.value = null
  } else if (result.ips.length !== selectedIPs.value.length) {
    selectionNotice.value = '部分已选机器的连接、版本或任务状态已变更，已移除不可升级的机器，请重新确认。'
    review.value = null
  }
  selectedIPs.value = result.ips
  settings.value = next
}
async function refresh() {
  if (busy.value || controller.signal.aborted) return
  loading.value = true
  try {
    const result = await api<unknown>('/settings/agent-updates', { signal: controller.signal })
    if (controller.signal.aborted) return
    adopt(result)
    loadError.value = ''
  } catch (cause) {
    if (!controller.signal.aborted) loadError.value = cause instanceof Error ? cause.message : '读取 Agent 更新状态失败。'
  } finally { loading.value = false }
}
async function preparePackage() {
  if (busy.value || controller.signal.aborted) return
  working.value = 'package'; actionError.value = ''; message.value = ''; review.value = null
  try {
    const result = await api<unknown>('/settings/agent-updates/package', { method: 'POST', body: '{}', signal: controller.signal })
    if (controller.signal.aborted) return
    adopt(result)
    message.value = '已读取主控程序并生成更新包，请核对目标版本和架构，再选择机器。'
    loadError.value = ''
  } catch (cause) {
    if (!controller.signal.aborted) actionError.value = cause instanceof Error ? cause.message : '读取并打包失败。'
  } finally { working.value = '' }
}
function toggle(item: AgentUpdateMachine) {
  if (busy.value || reason(item)) return
  selectedIPs.value = selectedSet.value.has(item.machine_ip) ? selectedIPs.value.filter(ip => ip !== item.machine_ip) : [...selectedIPs.value, item.machine_ip]
  review.value = null; selectionNotice.value = ''
}
function toggleVisible() {
  if (busy.value) return
  const ips = new Set(eligibleVisible.value.map(item => item.machine_ip))
  selectedIPs.value = allVisibleSelected.value ? selectedIPs.value.filter(ip => !ips.has(ip)) : [...new Set([...selectedIPs.value, ...ips])]
  review.value = null; selectionNotice.value = ''
}
function clearSelection() { if (!busy.value) { selectedIPs.value = []; review.value = null; selectionNotice.value = '' } }
function openReview() {
  if (busy.value || !release.value || !selected.value.length || selected.value.some(item => reason(item))) return
  review.value = { sha256: release.value.sha256, version: release.value.version, ips: selected.value.map(item => item.machine_ip) }
  actionError.value = ''; message.value = ''
}
async function submit() {
  if (busy.value || !review.value || !settings.value || controller.signal.aborted) return
  const confirmed = review.value
  if (confirmed.sha256 !== release.value?.sha256 || !confirmed.ips.length || confirmed.ips.some(ip => !settings.value!.items.some(item => item.machine_ip === ip && !reason(item)))) {
    review.value = null; actionError.value = '更新包或机器状态已变化，请刷新并重新核对升级清单。'; return
  }
  working.value = 'submit'; actionError.value = ''; message.value = ''
  try {
    const result = parseAgentUpdateSettings(await api<unknown>('/settings/agent-updates', { method: 'POST', body: JSON.stringify({ machine_ips: confirmed.ips, release_sha256: confirmed.sha256 }), signal: controller.signal }))
    if (controller.signal.aborted) return
    if (confirmed.ips.some(ip => !result.items.some(item => item.machine_ip === ip && item.job_id && item.target_version === confirmed.version && item.status !== 'idle'))) throw new Error('主控未确认全部升级任务，请刷新状态核对结果。')
    adopt(result)
    selectedIPs.value = []; review.value = null; selectionNotice.value = ''
    message.value = `已提交 ${confirmed.ips.length} 台机器升级至 ${confirmed.version}。Agent 会短暂重启，最终结果以状态表回执为准。`
    loadError.value = ''
  } catch (cause) {
    if (!controller.signal.aborted) actionError.value = `${cause instanceof Error ? cause.message : '提交升级失败。'} 请先刷新状态确认结果，再决定是否重试。`
  } finally { working.value = '' }
}
onMounted(() => { void refresh(); poll = setInterval(() => { if (!document.hidden) void refresh() }, 10000) })
watch(() => props.refreshToken, () => { void refresh() })
onBeforeUnmount(() => { controller.abort(); clearInterval(poll) })
</script>

<template>
  <section class="panel update-panel" aria-labelledby="agent-update-heading" :aria-busy="busy">
    <header class="update-heading">
      <div><h2 id="agent-update-heading"><HardDriveDownload :size="21" />Agent 程序更新</h2><p>从主控读取编译好的程序，打包后分发至所选机器。复用 TCP 55556。</p></div>
      <span class="badge" :class="running ? 'warning' : 'neutral'">{{ running ? `${running} 台升级中` : '按需升级' }}</span>
    </header>
    <div class="update-notice"><ShieldCheck :size="20" /><div><p>Agent 0.7.2 及更早版本需先手工部署支持更新的 0.7.3 或更高版本，之后可通过此页面升级。只可选择在线、支持更新且操作系统与架构匹配的机器。</p><p>程序更新会短暂重启 Agent。固定本地更新包经内网发送，无需开启“Agent 安装下载”。</p></div></div>
    <div class="update-source"><span>主控程序目录</span><code>{{ settings?.source_dir || '/usr/local/anquan-agent/dist' }}</code><p>将同一次编译生成的 <code>anquan</code> 和 <code>anquan.update.json</code> 放入此目录，再读取并打包。</p></div>
    <div class="update-actions"><button type="button" class="button primary" :disabled="busy" @click="preparePackage"><LoaderCircle v-if="working === 'package'" :size="17" class="spin" /><Package v-else :size="17" />{{ working === 'package' ? '正在读取并打包…' : '读取并打包' }}</button><button type="button" class="button secondary" :disabled="busy" @click="refresh"><RefreshCw :size="16" :class="{ spin: loading }" />刷新状态</button><span class="update-hint">状态每 10 秒自动刷新</span></div>
    <p v-if="settings?.source_error" class="update-error" role="alert">主控程序读取错误：{{ settings.source_error }}</p>
    <div v-if="release" class="update-release">
      <div><span>目标版本</span><strong>{{ release.version }}</strong></div><div><span>目标平台</span><strong>{{ release.goos }} / {{ release.goarch }}</strong></div><div><span>更新包大小</span><strong>{{ bytes(release.size) }}</strong></div><div><span>打包时间</span><strong class="update-date">{{ displayTime(release.created_at) }}</strong></div>
      <p class="update-digest"><span>更新包 SHA-256</span><code>{{ release.sha256 }}</code></p>
    </div>
    <p v-else-if="settings" class="update-empty-package"><Package :size="18" />尚无可用更新包。先在主控编译程序，再点击“读取并打包”。</p>
    <p v-if="loadError" class="update-error" role="alert">{{ loadError }} <button type="button" class="text-button" :disabled="busy" @click="refresh">重试读取</button></p>
    <p v-if="actionError" class="update-error" role="alert">{{ actionError }}</p>
    <p v-if="message" class="update-success" role="status">{{ message }}</p>
    <p v-if="selectionNotice" class="update-warning" role="status">{{ selectionNotice }}</p>
    <div class="update-machine-heading"><h3>选择升级机器 <span class="count-tag">{{ settings?.items.length ?? 0 }}</span></h3><div class="update-search"><Search :size="16" /><input v-model="search" type="search" aria-label="搜索升级机器" placeholder="搜索 IP、主机名或别名…" /></div></div>
    <div class="update-selection"><label><input type="checkbox" :checked="allVisibleSelected" :indeterminate="someVisibleSelected && !allVisibleSelected" :disabled="busy || !eligibleVisible.length" @change="toggleVisible" />选择当前页可升级机器</label><span>已选 {{ selected.length }} 台</span><button type="button" class="text-button" :disabled="busy || !selected.length" @click="clearSelection">清空选择</button></div>
    <p class="update-hint update-selection-hint">搜索和翻页保留选择；更新包、连接或版本变化后，会清理已失效的选择。</p>
    <div v-if="visible.length" class="table-scroll"><table class="update-table"><thead><tr><th class="update-checkbox-col">选择</th><th>机器 / IP</th><th>Agent / 平台</th><th>升级状态</th><th>结果 / 可选条件</th></tr></thead><tbody><tr v-for="item in visible" :key="item.machine_ip" :class="{ 'update-selected': selectedSet.has(item.machine_ip) }"><td><input type="checkbox" :checked="selectedSet.has(item.machine_ip)" :aria-label="`选择升级 ${item.alias || item.host || item.machine_ip} ${item.machine_ip}`" :disabled="busy || Boolean(reason(item))" @change="toggle(item)" /></td><td><strong>{{ item.alias || item.host || item.machine_ip }}</strong><span class="update-meta mono">{{ item.machine_ip }}</span><span class="badge update-online" :class="item.connected ? 'success' : 'neutral'">{{ item.connected ? '在线' : '未连接' }}</span></td><td><strong>{{ item.agent_version || '未知版本' }}</strong><span class="update-meta">{{ item.goos && item.goarch ? `${item.goos} / ${item.goarch}` : '尚未报告平台' }}</span></td><td><span class="badge" :class="agentUpdateStatusClass[item.status]">{{ agentUpdateStatusLabel[item.status] }}</span><span v-if="item.target_version" class="update-meta">目标 {{ item.target_version }}</span><span v-if="item.updated_at" class="update-meta">{{ displayTime(item.updated_at) }}</span></td><td class="update-result"><span v-if="item.error" class="update-failure">{{ item.error }}</span><span v-if="reason(item)" class="update-condition">{{ reason(item) }}</span><span v-else class="update-eligible"><CheckCheck :size="14" />可升级</span><span v-if="item.completed_at" class="update-meta">完成：{{ displayTime(item.completed_at) }}</span></td></tr></tbody></table></div>
    <div v-else class="update-empty"><LoaderCircle v-if="loading" :size="25" class="spin" /><Server v-else :size="25" /><p>{{ loading ? '正在读取机器状态…' : loadError && !settings ? '暂时无法读取机器，请刷新重试。' : search.trim() ? '没有匹配的机器，请尝试其他关键词。' : '还没有机器接入。' }}</p></div>
    <Pagination v-if="settings?.items.length" :page="page" :page-size="pageSize" :total="filtered.length" :disabled="busy" @change="page = $event" @resize="pageSize = $event" />
    <div v-if="review" class="update-review" role="region" aria-labelledby="update-review-title"><h3 id="update-review-title">确认升级清单</h3><p>将以下 {{ review.ips.length }} 台机器升级至 <strong>{{ review.version }}</strong>。Agent 会下载、校验并替换程序，随后短暂重启。</p><ul><li v-for="item in reviewMachines" :key="item.machine_ip"><strong>{{ item.alias || item.host || item.machine_ip }}</strong><span class="mono">{{ item.machine_ip }}</span><span>{{ item.agent_version }} → {{ review.version }}</span></li></ul><div class="update-actions"><button type="button" class="button primary" :disabled="busy" @click="submit"><LoaderCircle v-if="working === 'submit'" :size="17" class="spin" /><ArrowUpCircle v-else :size="17" />{{ working === 'submit' ? '正在提交…' : `开始升级（${review.ips.length} 台）` }}</button><button type="button" class="button secondary" :disabled="busy" @click="review = null">返回选择</button></div></div>
    <div v-else class="update-footer"><span class="update-hint">只更新程序，沿用机器现有配置与数据。</span><button type="button" class="button primary" :disabled="busy || !release || !selected.length" @click="openReview"><ArrowUpCircle :size="17" />检查升级清单{{ selected.length ? `（${selected.length} 台）` : '' }}</button></div>
  </section>
</template>

<style scoped>
.update-panel { padding: 24px; border-top: 3px solid var(--blue); overflow: hidden; }
.update-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; }
h2 { display: flex; align-items: center; gap: 9px; margin: 0; font-size: 17px; }
h3 { margin: 0; font-size: 14px; }
.update-heading p, .update-hint, .update-source p { color: #718198; font-size: 12px; line-height: 1.8; }
.update-heading p { margin: 8px 0 0; }
.update-heading > .badge { white-space: nowrap; }
.update-notice { display: flex; align-items: flex-start; gap: 11px; padding: 15px; margin: 20px 0; border-radius: 8px; background: #f1f6ff; color: #315889; }
.update-notice svg { flex-shrink: 0; margin-top: 2px; }
.update-notice p { margin: 0; font-size: 12px; line-height: 1.9; }
.update-notice p + p { margin-top: 5px; }
.update-source > span { display: block; color: #718198; font-size: 12px; margin-bottom: 7px; }
.update-source > code { font-size: 13px; overflow-wrap: anywhere; }
.update-source p { margin: 8px 0 0; }
.update-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 17px; }
.update-release { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; padding: 19px; background: #f8faff; border: 1px solid var(--line); border-radius: 8px; margin-top: 20px; }
.update-release > div { min-width: 0; }
.update-release > div > span, .update-digest > span { display: block; font-size: 11px; color: #718198; margin-bottom: 8px; }
.update-release strong { display: block; font-size: 17px; overflow-wrap: anywhere; }
.update-release .update-date { font-size: 12px; line-height: 1.8; }
.update-digest { grid-column: 1 / -1; margin: 0; padding-top: 14px; border-top: 1px solid var(--line); }
.update-digest code { font-size: 11px; overflow-wrap: anywhere; }
.update-empty-package { display: flex; gap: 8px; align-items: flex-start; color: #718198; background: #f8faff; border-radius: 8px; padding: 15px; font-size: 12px; line-height: 1.8; margin-top: 18px; }
.update-empty-package svg { flex-shrink: 0; margin-top: 2px; }
.update-error, .update-success, .update-warning { margin: 16px 0 0; padding: 12px 14px; border-radius: 8px; font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.update-error { color: #b42318; background: #fff0ed; }
.update-success { color: #14734d; background: #edf9f2; }
.update-warning { color: #8c5b17; background: #fff8e8; }
.update-machine-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin: 28px 0 17px; }
.update-search { position: relative; display: flex; align-items: center; width: min(360px, 50%); }
.update-search svg { position: absolute; left: 12px; color: #91a0b7; }
.update-search input { padding-left: 36px; }
.update-selection { display: flex; align-items: center; flex-wrap: wrap; gap: 18px; color: #718198; font-size: 12px; }
.update-selection label { display: flex; flex-direction: row; align-items: center; gap: 8px; margin: 0; font-size: 12px; }
.update-selection input, .update-table input { width: 16px; height: 16px; padding: 0; margin: 0; accent-color: var(--blue); }
.update-selection-hint { margin: 10px 0 15px; }
.update-table { min-width: 780px; font-size: 12px; }
.update-table th { padding: 13px 14px; background: #f8faff; color: #8291a7; font-weight: 500; }
.update-table td { padding: 15px 14px; border-top: 1px solid var(--line); vertical-align: top; }
.update-table strong { font-size: 13px; overflow-wrap: anywhere; }
.update-checkbox-col { width: 55px; }
.update-selected td { background: #f6f9ff; }
.update-meta { display: block; color: #8390a5; margin-top: 6px; font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }
.update-online { margin-top: 8px; }
.update-result { max-width: 340px; line-height: 1.8; }
.update-failure { display: block; color: #b42318; overflow-wrap: anywhere; }
.update-condition { display: block; color: #718198; }
.update-eligible { display: inline-flex; gap: 5px; align-items: center; color: #14734d; }
.update-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 30px 18px; color: #8390a5; font-size: 13px; text-align: center; }
.update-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 23px; }
.update-review { background: #f1f6ff; border: 1px solid #d3e1fa; padding: 20px; border-radius: 8px; margin-top: 22px; }
.update-review > p { font-size: 12px; color: #536f9c; line-height: 1.9; margin: 10px 0 14px; }
.update-review ul { list-style: none; margin: 0; padding: 0; max-height: 240px; overflow: auto; }
.update-review li { display: flex; flex-wrap: wrap; gap: 8px 18px; padding: 10px 0; border-bottom: 1px solid #dce6f6; font-size: 12px; overflow-wrap: anywhere; }
.update-review li > span { color: #536f9c; }
@media (max-width: 1000px) { .update-release { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { .update-panel { padding: 18px; } .update-heading, .update-machine-heading, .update-footer { flex-direction: column; align-items: flex-start; } .update-search { width: 100%; } .update-source > code { font-size: 12px; } .update-release { gap: 15px 10px; padding: 14px; } .update-release strong { font-size: 15px; } .update-review { padding: 15px; } .update-footer > button { width: 100%; } }
</style>
