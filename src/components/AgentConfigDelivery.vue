<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { LoaderCircle, RefreshCw, Search, Send, Server, X } from 'lucide-vue-next'
import { api } from '../api'
import type { AgentConfigDelivery } from '../types'
import Pagination from './Pagination.vue'

const props = defineProps<{ yaml: string; disabled: boolean }>()
const emit = defineEmits<{ active: [value: boolean] }>()
const items = ref<AgentConfigDelivery[]>([])
const loading = ref(false)
const submitting = ref(false)
const opened = ref(false)
const selectedIPs = ref<string[]>([])
const search = ref('')
const page = ref(1)
const pageSize = ref(10)
const statusSearch = ref('')
const statusPage = ref(1)
const statusPageSize = ref(10)
const loadError = ref('')
const submitError = ref('')
const message = ref('')
const modal = ref<HTMLElement | null>(null)
const controller = new AbortController()
let timer: ReturnType<typeof setInterval> | undefined
let previousFocus: HTMLElement | null = null
let previousOverflow = ''
const selectedIPSet = computed(() => new Set(selectedIPs.value))
const selected = computed(() => items.value.filter(item => selectedIPSet.value.has(item.machine_ip)))
const selectedOffline = computed(() => selected.value.filter(item => !item.connected).length)
function filterMachines(searchValue: string) {
  const value = searchValue.trim().toLocaleLowerCase()
  return items.value.filter(item => [item.machine_ip, item.host, item.alias].some(field => field?.toLocaleLowerCase().includes(value)))
}
const filtered = computed(() => filterMachines(search.value))
const visible = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
const statusFiltered = computed(() => filterMachines(statusSearch.value))
const statusVisible = computed(() => statusFiltered.value.slice((statusPage.value - 1) * statusPageSize.value, statusPage.value * statusPageSize.value))
const allVisibleSelected = computed(() => visible.value.length > 0 && visible.value.every(item => selectedIPSet.value.has(item.machine_ip)))
const someVisibleSelected = computed(() => visible.value.some(item => selectedIPSet.value.has(item.machine_ip)))
watch([search, pageSize], () => { page.value = 1 })
watch([statusSearch, statusPageSize], () => { statusPage.value = 1 })
// A refresh can remove the last machine on a page. Keep the user on the nearest
// valid page while preserving the search and selections on other pages.
watch(() => filtered.value.length, total => { page.value = Math.min(page.value, Math.max(1, Math.ceil(total / pageSize.value))) })
watch(() => statusFiltered.value.length, total => { statusPage.value = Math.min(statusPage.value, Math.max(1, Math.ceil(total / statusPageSize.value))) })
const statusLabel = (item: AgentConfigDelivery) => ({ unassigned: '未下发', pending: '待应用', applied: '已应用', failed: '应用失败' }[item.status])
const statusClass = (item: AgentConfigDelivery) => ({ unassigned: 'neutral', pending: 'warning', applied: 'success', failed: 'offline' }[item.status])
function displayTime(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}
async function refresh() {
  if (loading.value || submitting.value || controller.signal.aborted) return
  loading.value = true
  try {
    const result = await api<{ items: AgentConfigDelivery[] }>('/settings/agent-config-deliveries', { signal: controller.signal })
    if (controller.signal.aborted) return
    if (!Array.isArray(result?.items)) throw new Error('机器状态响应无效，请重试。')
    items.value = result.items
    const available = new Set(items.value.map(item => item.machine_ip))
    selectedIPs.value = selectedIPs.value.filter(ip => available.has(ip))
    loadError.value = ''
  } catch (error) {
    if (!controller.signal.aborted) loadError.value = `读取配置下发状态失败：${error instanceof Error ? error.message : '请重试。'}`
  } finally { loading.value = false }
}
function toggle(ip: string) {
  if (submitting.value || loading.value) return
  selectedIPs.value = selectedIPs.value.includes(ip) ? selectedIPs.value.filter(value => value !== ip) : [...selectedIPs.value, ip]
  submitError.value = ''
}
function toggleVisible() {
  if (submitting.value || loading.value) return
  const visibleIPs = new Set(visible.value.map(item => item.machine_ip))
  selectedIPs.value = allVisibleSelected.value ? selectedIPs.value.filter(ip => !visibleIPs.has(ip)) : [...new Set([...selectedIPs.value, ...visibleIPs])]
  submitError.value = ''
}
async function open() {
  if (props.disabled || opened.value) return
  opened.value = true
  selectedIPs.value = []
  search.value = ''
  page.value = 1
  submitError.value = ''
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  emit('active', true)
  await nextTick()
  modal.value?.focus()
  void refresh()
}
function close() {
  if (submitting.value || !opened.value) return
  opened.value = false
  document.body.style.overflow = previousOverflow
  emit('active', false)
  const target = previousFocus
  void nextTick(() => target?.focus())
}
function keydown(event: KeyboardEvent) {
  if (!opened.value) return
  if (event.key === 'Escape') { event.preventDefault(); close(); return }
  if (event.key !== 'Tab') return
  const focusable = Array.from(modal.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) { event.preventDefault(); modal.value?.focus(); return }
  if (!modal.value?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === modal.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === modal.value)) { event.preventDefault(); first.focus() }
}
async function submit() {
  if (submitting.value || loading.value || props.disabled) return
  submitError.value = ''
  if (!selected.value.length) { submitError.value = '请至少选择一台机器。'; return }
  if (!props.yaml.trim() || new TextEncoder().encode(props.yaml).length > 4 * 1024 * 1024) { submitError.value = '请填写 YAML 配置，最大 4 MiB。'; return }
  const machineIPs = selected.value.map(item => item.machine_ip)
  const offline = selectedOffline.value
  submitting.value = true
  try {
    const result = await api<{ items: AgentConfigDelivery[] }>('/settings/agent-config-deliveries', {
      method: 'POST', body: JSON.stringify({ yaml: props.yaml, machine_ips: machineIPs }), signal: controller.signal,
    })
    if (controller.signal.aborted) return
    if (!Array.isArray(result?.items) || machineIPs.some(ip => !result.items.some(item => item.machine_ip === ip))) {
      throw new Error('服务器未确认全部目标机器，请刷新状态确认下发结果。')
    }
    const updated = new Map(result.items.map(item => [item.machine_ip, item]))
    items.value = items.value.map(item => updated.get(item.machine_ip) ?? item)
    message.value = `已提交 ${machineIPs.length} 台机器的配置，请查看 Agent 应用状态。${offline ? `其中 ${offline} 台长连接未在线，配置已保存，重连后自动投递。` : ''}`
    submitting.value = false
    close()
    void refresh()
  } catch (error) {
    if (!controller.signal.aborted) submitError.value = `${error instanceof Error ? error.message : '下发配置失败，请重试。'} 当前配置和机器选择已保留。`
  } finally { submitting.value = false }
}
onMounted(() => {
  document.addEventListener('keydown', keydown)
  void refresh()
  timer = setInterval(() => { if (!document.hidden) void refresh() }, 10_000)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', keydown)
  controller.abort()
  clearInterval(timer)
  if (opened.value) document.body.style.overflow = previousOverflow
  emit('active', false)
})
defineExpose({ open })
</script>

<template>
  <section class="panel delivery-panel">
    <div class="delivery-heading"><div><h2>配置下发状态 <span class="count-tag">{{ items.length }}</span></h2><p>Agent 主动连接主控 TCP 55556，主控通过长连接投递配置。状态每 10 秒自动刷新。</p></div><button type="button" class="button secondary small" :disabled="loading || submitting" @click="refresh"><LoaderCircle v-if="loading" :size="15" class="spin" /><RefreshCw v-else :size="15" />刷新状态</button></div>
    <p v-if="message" class="delivery-success" role="status">{{ message }}</p>
    <p v-if="loadError" class="delivery-error" role="alert">{{ loadError }}</p>
    <div class="delivery-search delivery-status-search"><Search :size="16" /><input v-model="statusSearch" type="search" aria-label="搜索配置下发状态" placeholder="搜索 IP、主机名或别名…" /></div>
    <div v-if="statusVisible.length" class="table-scroll" :aria-busy="loading"><table class="delivery-table"><thead><tr><th>机器 / IP</th><th>配置长连接</th><th>下发状态</th><th>最新下发</th><th>应用结果</th></tr></thead><tbody><tr v-for="item in statusVisible" :key="item.machine_ip"><td><strong>{{ item.alias || item.host || item.machine_ip }}</strong><span class="delivery-ip mono">{{ item.machine_ip }}</span></td><td><span class="badge" :class="item.connected ? 'success' : 'neutral'"><span class="status-dot"></span>{{ item.connected ? '在线' : '未连接' }}</span></td><td><span class="badge" :class="statusClass(item)">{{ statusLabel(item) }}</span><span v-if="item.revision" class="delivery-meta mono" :title="item.revision">版本 {{ item.revision.slice(0, 12) }}</span></td><td class="delivery-time">{{ displayTime(item.updated_at) }}</td><td><span v-if="item.error" class="delivery-failure">{{ item.error }}</span><span v-else-if="item.status === 'applied'" class="delivery-time">{{ displayTime(item.applied_at) }}</span><span v-else class="muted">{{ item.status === 'pending' ? item.connected ? '等待 Agent 回执' : '重连后自动投递' : '—' }}</span></td></tr></tbody></table></div>
    <div v-else class="delivery-empty"><LoaderCircle v-if="loading" :size="25" class="spin" /><Server v-else :size="25" /><p>{{ loading ? '正在加载机器…' : loadError ? '暂时无法读取机器，请刷新重试。' : statusSearch.trim() ? '没有匹配的机器，请尝试其他关键词。' : '还没有机器接入。Agent 首次上报后即可选择下发。' }}</p></div>
    <Pagination v-if="items.length" :page="statusPage" :page-size="statusPageSize" :total="statusFiltered.length" :disabled="loading || submitting" @change="statusPage = $event" @resize="statusPageSize = $event" />
  </section>
  <Teleport to="body">
    <div v-if="opened" class="modal-backdrop" @click.self="close">
      <section ref="modal" class="modal delivery-modal" role="dialog" aria-modal="true" aria-labelledby="delivery-title" aria-describedby="delivery-description" tabindex="-1">
        <div class="modal-header"><div><span class="eyebrow">AGENT CONFIGURATION</span><h2 id="delivery-title">下发配置</h2></div><button type="button" class="icon-button" aria-label="关闭下发配置" :disabled="submitting" @click="close"><X :size="20" /></button></div>
        <form @submit.prevent="submit">
          <div class="modal-body delivery-body">
            <p id="delivery-description" class="delivery-description">将编辑器中的当前 YAML 下发至所选机器，替换该机器之前下发的采集配置。主控地址和机器标识沿用本机启动配置。Agent 优先使用主控下发配置，未下发时使用可执行文件同目录的配置文件。</p>
            <p class="delivery-notice">Agent 主动连接主控 TCP 55556，无需开放 Agent 端口。长连接未在线的机器也可下发，配置会保存并在重连后自动投递。</p>
            <div class="delivery-search"><Search :size="16" /><input v-model="search" type="search" aria-label="搜索下发机器" placeholder="搜索 IP、主机名或别名…" :disabled="submitting" @keydown.enter.prevent /></div>
            <div class="delivery-selection-bar">
              <label class="delivery-check"><input type="checkbox" :checked="allVisibleSelected" :indeterminate="!allVisibleSelected && someVisibleSelected" :disabled="submitting || loading || !visible.length" @change="toggleVisible" />选择当前页</label>
              <span>已选 {{ selected.length }} 台<span v-if="selectedOffline"> · {{ selectedOffline }} 台未连接</span></span>
              <button type="button" class="text-button" :disabled="submitting || !selected.length" @click="selectedIPs = []; submitError = ''">清空选择</button>
            </div>
            <p class="delivery-selection-hint">翻页和搜索会保留已选机器，确认时下发至全部已选机器。</p>
            <div v-if="loadError" class="delivery-error" role="alert">{{ loadError }} <button type="button" class="text-button" :disabled="loading || submitting" @click="refresh">重试读取</button></div>
            <div v-if="loading && !items.length" class="delivery-empty"><LoaderCircle :size="24" class="spin" /><p>正在加载机器…</p></div>
            <div v-else-if="!filtered.length" class="delivery-empty"><Server :size="24" /><p>{{ search.trim() ? '没有匹配的机器，请尝试其他关键词。' : loadError ? '读取机器失败，请稍后重试。' : '还没有可下发的机器，Agent 首次上报后即可选择。' }}</p></div>
            <div v-else class="delivery-options" :aria-busy="loading">
              <label v-for="item in visible" :key="item.machine_ip" class="delivery-option" :class="{ selected: selectedIPSet.has(item.machine_ip) }"><input type="checkbox" :checked="selectedIPSet.has(item.machine_ip)" :aria-label="`选择 ${item.alias || item.host || item.machine_ip} ${item.machine_ip}`" :disabled="submitting || loading" @change="toggle(item.machine_ip)" /><span class="delivery-identity"><strong>{{ item.alias || item.host || item.machine_ip }}</strong><span class="mono delivery-ip">{{ item.machine_ip }}</span><span v-if="item.error" class="delivery-failure">{{ item.error }}</span></span><span class="delivery-option-status"><span class="badge" :class="item.connected ? 'success' : 'neutral'">{{ item.connected ? '长连接在线' : '长连接未连接' }}</span><span class="badge" :class="statusClass(item)">{{ statusLabel(item) }}</span></span></label>
            </div>
            <p v-if="submitError" class="delivery-error" role="alert">{{ submitError }}</p>
          </div>
          <Pagination class="delivery-pagination" :page="page" :page-size="pageSize" :total="filtered.length" :disabled="loading || submitting" @change="page = $event" @resize="pageSize = $event" />
          <div class="modal-footer"><button type="button" class="button secondary" :disabled="submitting" @click="close">取消</button><button type="submit" class="button primary" :disabled="submitting || loading || !selected.length || props.disabled"><LoaderCircle v-if="submitting" :size="16" class="spin" /><Send v-else :size="16" />{{ submitting ? '正在下发…' : `确认下发${selected.length ? `（${selected.length} 台）` : ''}` }}</button></div>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.delivery-panel { margin-top: 24px; overflow: hidden; }
.delivery-heading { padding: 22px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.delivery-heading h2 { font-size: 16px; }
.delivery-heading p, .delivery-description, .delivery-notice { color: #718198; font-size: 13px; line-height: 1.7; margin-top: 8px; }
.delivery-table { min-width: 680px; font-size: 12px; }
.delivery-table th { padding: 13px 22px; background: #f8faff; color: #8291a7; font-weight: 500; }
.delivery-table td { padding: 15px 22px; border-top: 1px solid var(--line); }
.delivery-table strong { font-size: 13px; font-weight: 600; }
.delivery-ip, .delivery-meta { display: block; color: #8390a5; font-size: 11px; margin-top: 6px; overflow-wrap: anywhere; }
.delivery-time { color: #718198; white-space: nowrap; font-size: 11px; }
.delivery-failure { display: block; color: #b42318; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; max-width: 300px; margin-top: 4px; }
.delivery-empty { display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; padding: 28px 18px; color: #8390a5; text-align: center; line-height: 1.7; }
.delivery-error, .delivery-success { font-size: 13px; line-height: 1.7; padding: 12px 14px; border-radius: 8px; margin-top: 14px; overflow-wrap: anywhere; }
.delivery-error { color: #b42318; background: #fff0ed; }
.delivery-success { color: #14734d; background: #edf9f2; }
.delivery-panel > .delivery-error, .delivery-panel > .delivery-success { margin: 0 22px 18px; }
.delivery-modal { width: 720px; }
.delivery-description { margin-top: 0; }
.delivery-notice { padding: 12px 14px; background: #f1f6ff; color: #536f9c; border-radius: 8px; margin-top: 12px; }
.delivery-search { display: flex; align-items: center; position: relative; margin-top: 20px; }
.delivery-search svg { position: absolute; left: 12px; color: #91a0b7; }
.delivery-search input { padding-left: 36px; }
.delivery-status-search { margin: 0 22px 20px; }
.delivery-pagination { flex-shrink: 0; }
.delivery-selection-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin: 17px 0 10px; font-size: 12px; color: #718198; }
.delivery-selection-hint { font-size: 12px; line-height: 1.6; color: #718198; margin: 0 0 12px; }
.delivery-check { display: flex; flex-direction: row; align-items: center; gap: 8px; font-size: 12px; }
.delivery-check input, .delivery-option input { width: 16px; height: 16px; flex-shrink: 0; padding: 0; accent-color: var(--blue); }
.delivery-options { display: flex; flex-direction: column; gap: 8px; }
.delivery-option { display: flex; flex-direction: row; align-items: center; gap: 12px; padding: 14px; border: 1px solid #e2e8f1; border-radius: 8px; font-weight: 400; cursor: pointer; }
.delivery-option.selected { border-color: #91b0f4; background: #f6f9ff; }
.delivery-identity { min-width: 0; flex: 1; }
.delivery-identity strong { font-weight: 600; overflow-wrap: anywhere; }
.delivery-option-status { display: flex; align-items: flex-end; flex-direction: column; gap: 7px; }
@media (max-width: 600px) {
  .delivery-heading { align-items: flex-start; flex-direction: column; padding: 18px; }
  .delivery-body { padding: 18px; }
  .delivery-option { gap: 9px; padding: 12px 10px; }
  .delivery-option-status { max-width: 105px; }
  .delivery-selection-bar { align-items: flex-start; }
  .delivery-status-search { margin: 0 18px 18px; }
}
</style>
