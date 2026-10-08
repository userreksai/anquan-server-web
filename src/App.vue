<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Activity, ArrowLeft, ArrowRight, BellRing, Check, CheckCheck, ChevronRight, Clock3, Copy, FileSearch, Fingerprint, Globe, KeyRound, LayoutDashboard, LoaderCircle, LogIn, LogOut, Menu, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Send, Server, Settings2, ShieldCheck, ShieldAlert, SlidersHorizontal, Trash2, Webhook as WebhookIcon, X } from 'lucide-vue-next'
import { api, ApiError, query } from './api'
import { alertTitle, alertKindLabel, moduleLabel } from './event-labels'
import Pagination from './components/Pagination.vue'
import AgentEncryption from './components/AgentEncryption.vue'
import WebhookTestFeedback from './components/WebhookTestFeedback.vue'
import { requestWebhookTest } from './webhook-test'
import type { Machine, Overview, PageResult, SecurityEvent, Webhook, WebhookTestFeedback as TestFeedback } from './types'

type View = 'overview' | 'machines' | 'events' | 'webhooks' | 'encryption'
type Dialog = 'event' | 'machine' | 'webhook' | 'password' | 'delete' | null
const view = ref<View>('overview')
const mobileMenu = ref(false)
const booting = ref(true)
const authenticated = ref(false)
const username = ref('admin')
const password = ref('')
const user = ref('admin')
const loginError = ref('')
const loginBusy = ref(false)
const notice = ref<{ message: string; kind: 'success' | 'error' } | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let refreshTimer: ReturnType<typeof setInterval> | undefined
const pageVisible = ref(!document.hidden)
const overview = ref<Overview | null>(null)
const machines = ref<Machine[]>([])
const machineTotal = ref(0)
const machinePage = ref(1)
const machineSize = ref(10)
const machineSearch = ref('')
const appliedMachineSearch = ref('')
const selectedMachine = ref<Machine | null>(null)
const events = ref<SecurityEvent[]>([])
const eventTotal = ref(0)
const eventPage = ref(1)
const eventSize = ref(10)
const eventType = ref('')
const eventStatusFilter = ref('')
const eventSearch = ref('')
const eventFrom = ref('')
const eventTo = ref('')
const appliedEvents = ref({ q: '', from: '', to: '', status: '' })
const hooks = ref<Webhook[]>([])
const loading = ref(false)
const pageError = ref('')
const updatedAt = ref('')
const dialog = ref<Dialog>(null)
const modalRef = ref<HTMLElement | null>(null)
const dialogBusy = ref(false)
const dialogError = ref('')
const activeEvent = ref<SecurityEvent | null>(null)
const eventNotes = ref('')
const eventStatus = ref<'open' | 'resolved'>('open')
const machineForm = ref({ alias: '', notes: '' })
const editingHookId = ref<number | null>(null)
const hookForm = ref({ name: '', url: '', format: 'feishu' as const, enabled: true })
const testingHook = ref<number | null>(null)
const testingHookForm = ref(false)
const hookTestResults = ref<Record<number, TestFeedback>>({})
const hookFormTestResult = ref<TestFeedback | null>(null)
const testedHookForm = ref('')
const hookFormTestStale = computed(() => Boolean(hookFormTestResult.value) && testedHookForm.value !== JSON.stringify(hookForm.value))
const savingHook = ref(false)
const passwordForm = ref({ current: '', next: '', confirm: '' })
const deleteTarget = ref<{ kind: 'event' | 'machine' | 'webhook'; id: string | number; label: string } | null>(null)
let lastFocused: HTMLElement | null = null
let loadId = 0
const title = computed(() => selectedMachine.value ? (selectedMachine.value.alias || selectedMachine.value.ip) : ({ overview: '安全概览', machines: '机器管理', events: '安全事件', webhooks: '通知配置', encryption: 'Age 配置加密' }[view.value]))
const offlineMachines = computed(() => overview.value ? Math.max(0, overview.value.machines - overview.value.online_machines) : 0)
const refreshStatus = computed(() => loading.value ? '正在刷新数据' : pageError.value ? '刷新失败，将自动重试' : !pageVisible.value || dialog.value || dialogBusy.value || savingHook.value || testingHook.value !== null ? '自动刷新已暂停' : '每 15 秒自动刷新')
const isOnline = (machine: Machine) => machine.status ? machine.status === 'online' : machine.online
const offlineAfter = (machine: Machine) => machine.offline_after_seconds ?? Math.max((machine.interval_seconds || 300) * 3, 120)
const tabs = [{ value: '', label: '全部记录' }, { value: 'alert', label: '安全告警' }, { value: 'ssh_login', label: 'SSH 登录' }, { value: 'scan_summary', label: '巡检记录' }]
const formatNames = { feishu: 'Lark 机器人', wecom: '企业微信机器人', generic: '通用 Webhook' }
const displayTime = (value: string | undefined) => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}
const shortTime = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
const typeLabel = (type: string) => ({ alert: '安全告警', ssh_login: 'SSH 登录', scan_summary: '巡检记录' }[type] || type)
const textField = (data: Record<string, unknown>, key: string) => {
  const value = data?.[key]
  return value === undefined || value === null || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)
}
const eventTitle = (event: SecurityEvent) => {
  if (event.type === 'ssh_login') return `${textField(event.data, 'user')} 登录系统`
  if (event.type === 'scan_summary') return event.data.collection_success === false ? '巡检采集异常' : '机器安全巡检'
  return alertTitle(event.data)
}
const eventSubtitle = (event: SecurityEvent) => event.type === 'ssh_login' ? `来源 ${textField(event.data, 'source_ip')} · 终端 ${textField(event.data, 'terminal')}` : event.type === 'alert' ? textField(event.data, 'target') : `文件 ${textField(event.data, 'files')} · 进程 ${textField(event.data, 'processes')}`
const jsonEvent = computed(() => JSON.stringify(activeEvent.value, null, 2))
const webhookHostname = (url: string) => { try { return new URL(url).hostname } catch { return '地址无效' } }
const stats = computed(() => [
  { label: '受保护机器', value: overview.value?.machines, note: `${overview.value?.online_machines ?? '—'} 台当前在线`, icon: Server, color: 'blue', action: 'machines' as View },
  { label: '待处理告警', value: overview.value?.open_alerts, note: '关注文件变更与安全异常', icon: ShieldAlert, color: 'amber', action: 'events' as View },
  { label: 'SSH 登录', value: overview.value?.ssh_logins, note: '已记录的远程登录事件', icon: LogIn, color: 'violet', action: 'events' as View },
  { label: '累计安全事件', value: overview.value?.events, note: '告警、登录与巡检记录', icon: Activity, color: 'teal', action: 'events' as View },
])

function toast(message: string, kind: 'success' | 'error' = 'success') {
  notice.value = { message, kind }
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => notice.value = null, 6500)
}
function errorText(error: unknown) { return error instanceof Error ? error.message : '操作失败，请稍后重试。' }
function expired() {
  authenticated.value = false
  password.value = ''
  loginError.value = '登录已过期，请重新登录。'
  dialog.value = null
  loadId++
}
async function login() {
  loginBusy.value = true
  loginError.value = ''
  try {
    await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: username.value, password: password.value }) })
    user.value = username.value
    authenticated.value = true
    password.value = ''
    await loadPage()
  } catch (error) { loginError.value = errorText(error) }
  finally { loginBusy.value = false }
}
async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' })
    authenticated.value = false
    password.value = ''
    loginError.value = ''
    selectedMachine.value = null
    view.value = 'overview'
    loadId++
  } catch (error) { toast(errorText(error), 'error') }
}
async function loadPage() {
  const requestId = ++loadId
  loading.value = true
  pageError.value = ''
  try {
    const tasks: Promise<void>[] = []
    tasks.push(api<Overview>('/overview').then(value => { if (requestId === loadId) overview.value = value }))
    if (view.value === 'machines' && !selectedMachine.value) {
      tasks.push(api<PageResult<Machine>>('/machines' + query({ q: appliedMachineSearch.value, page: machinePage.value, page_size: machineSize.value })).then(value => {
        if (requestId !== loadId) return
        machines.value = value.items || []
        machineTotal.value = value.total
      }))
    }
    if (view.value === 'overview' || view.value === 'events' || selectedMachine.value) {
      tasks.push(api<PageResult<SecurityEvent>>('/events' + query({ machine_ip: selectedMachine.value?.ip, type: view.value === 'overview' ? '' : eventType.value, status: view.value === 'overview' ? '' : appliedEvents.value.status, q: view.value === 'overview' ? '' : appliedEvents.value.q, from: view.value === 'overview' ? '' : appliedEvents.value.from, to: view.value === 'overview' ? '' : appliedEvents.value.to, page: view.value === 'overview' ? 1 : eventPage.value, page_size: view.value === 'overview' ? 7 : eventSize.value })).then(value => {
        if (requestId !== loadId) return
        events.value = value.items || []
        eventTotal.value = value.total
      }))
    }
    if (selectedMachine.value) {
      tasks.push(api<Machine>(`/machines/${encodeURIComponent(selectedMachine.value.ip)}`).then(value => { if (requestId === loadId) selectedMachine.value = value }))
    }
    if (view.value === 'webhooks') {
      tasks.push(api<Webhook[] | PageResult<Webhook>>('/webhooks').then(value => { if (requestId === loadId) hooks.value = Array.isArray(value) ? value : value.items || [] }))
    }
    await Promise.all(tasks)
    if (requestId === loadId) updatedAt.value = new Date().toISOString()
  } catch (error) {
    if (requestId === loadId && !(error instanceof ApiError && error.status === 401)) pageError.value = errorText(error)
  } finally { if (requestId === loadId) loading.value = false }
}
function navigate(next: View, type = '', status = '') {
  view.value = next
  selectedMachine.value = null
  mobileMenu.value = false
  eventPage.value = 1
  eventType.value = type
  eventStatusFilter.value = status
  eventSearch.value = ''
  eventFrom.value = ''
  eventTo.value = ''
  appliedEvents.value = { q: '', from: '', to: '', status }
  void loadPage()
}
function statNavigate(index: number) {
  navigate(stats.value[index]!.action, index === 1 ? 'alert' : index === 2 ? 'ssh_login' : '', index === 1 ? 'open' : '')
}
async function openMachine(machine: Machine | string) {
  try {
    const value = typeof machine === 'string' ? await api<Machine>(`/machines/${encodeURIComponent(machine)}`) : machine
    selectedMachine.value = value
    view.value = 'machines'
    eventType.value = ''
    eventStatusFilter.value = ''
    eventSearch.value = ''
    eventFrom.value = ''
    eventTo.value = ''
    appliedEvents.value = { q: '', from: '', to: '', status: '' }
    eventPage.value = 1
    await loadPage()
  } catch (error) { toast(errorText(error), 'error') }
}
function applyMachineSearch() { machinePage.value = 1; appliedMachineSearch.value = machineSearch.value; void loadPage() }
function applyEventSearch() {
  if (eventFrom.value && eventTo.value && new Date(eventFrom.value) > new Date(eventTo.value)) { toast('开始时间不能晚于结束时间。', 'error'); return }
  appliedEvents.value = { q: eventSearch.value, from: eventFrom.value ? new Date(eventFrom.value).toISOString() : '', to: eventTo.value ? new Date(eventTo.value).toISOString() : '', status: eventStatusFilter.value }
  eventPage.value = 1
  void loadPage()
}
function clearFilters() { eventSearch.value = ''; eventFrom.value = ''; eventTo.value = ''; eventStatusFilter.value = ''; applyEventSearch() }
function setEventType(type: string) { eventType.value = type; eventPage.value = 1; void loadPage() }
async function openDialog(value: Dialog) {
  lastFocused = document.activeElement as HTMLElement
  dialog.value = value
  dialogError.value = ''
  await nextTick()
  modalRef.value?.focus()
}
function closeDialog() {
  if (dialogBusy.value) return
  dialog.value = null
  lastFocused?.focus()
}
function dialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeDialog()
  if (event.key !== 'Tab') return
  const nodes = modalRef.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')
  if (!nodes?.length) return
  const first = nodes[0]!
  const last = nodes[nodes.length - 1]!
  if (event.shiftKey && (document.activeElement === first || document.activeElement === modalRef.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
async function openEvent(event: SecurityEvent) {
  try {
    activeEvent.value = await api<SecurityEvent>(`/events/${event.id}`)
    eventNotes.value = activeEvent.value.notes
    eventStatus.value = activeEvent.value.status
    await openDialog('event')
  } catch (error) { toast(errorText(error), 'error') }
}
function editMachine() {
  if (!selectedMachine.value) return
  machineForm.value = { alias: selectedMachine.value.alias || '', notes: selectedMachine.value.notes || '' }
  void openDialog('machine')
}
function editWebhook(hook?: Webhook) {
  editingHookId.value = hook?.id ?? null
  hookForm.value = { name: hook?.name || '', url: hook?.url || '', format: 'feishu', enabled: hook?.enabled ?? true }
  hookFormTestResult.value = null
  testedHookForm.value = ''
  void openDialog('webhook')
}
function validateWebhookForm() {
  if (!hookForm.value.name.trim()) { dialogError.value = '请输入通知名称。'; return false }
  try { const url = new URL(hookForm.value.url.trim()); if (!['http:', 'https:'].includes(url.protocol)) throw new Error() } catch { dialogError.value = '请输入完整的 HTTP 或 HTTPS 通知地址。'; return false }
  return true
}
function openPassword() { passwordForm.value = { current: '', next: '', confirm: '' }; void openDialog('password') }
function confirmDelete(kind: 'event' | 'machine' | 'webhook', id: string | number, label: string) {
  deleteTarget.value = { kind, id, label }
  void openDialog('delete')
}
async function saveDialog() {
  if (dialogBusy.value) return
  dialogError.value = ''
  if (dialog.value === 'password') {
    if (passwordForm.value.next !== passwordForm.value.confirm) { dialogError.value = '两次输入的新密码不一致。'; return }
    const bytes = new TextEncoder().encode(passwordForm.value.next).length
    if (bytes < 8 || bytes > 72) { dialogError.value = '新密码需要 8–72 字节（中文等字符会占用多个字节）。'; return }
  }
  if (dialog.value === 'webhook' && !validateWebhookForm()) return
  dialogBusy.value = true
  try {
    if (dialog.value === 'event' && activeEvent.value) await api(`/events/${activeEvent.value.id}`, { method: 'PATCH', body: JSON.stringify({ status: eventStatus.value, notes: eventNotes.value }) })
    if (dialog.value === 'machine' && selectedMachine.value) await api(`/machines/${encodeURIComponent(selectedMachine.value.ip)}`, { method: 'PATCH', body: JSON.stringify(machineForm.value) })
    if (dialog.value === 'webhook') {
      await api(`/webhooks${editingHookId.value === null ? '' : `/${editingHookId.value}`}`, { method: editingHookId.value === null ? 'POST' : 'PUT', body: JSON.stringify(hookForm.value) })
      if (editingHookId.value !== null) delete hookTestResults.value[editingHookId.value]
    }
    if (dialog.value === 'password') {
      await api('/auth/password', { method: 'PUT', body: JSON.stringify({ current_password: passwordForm.value.current, new_password: passwordForm.value.next }) })
      passwordForm.value = { current: '', next: '', confirm: '' }
    }
    if (dialog.value === 'delete' && deleteTarget.value) {
      const target = deleteTarget.value
      const base = { event: 'events', machine: 'machines', webhook: 'webhooks' }[target.kind]
      await api(`/${base}/${encodeURIComponent(String(target.id))}`, { method: 'DELETE' })
      if (target.kind === 'machine') selectedMachine.value = null
      if (target.kind === 'event' && events.value.length === 1 && eventPage.value > 1) eventPage.value--
      if (target.kind === 'webhook') delete hookTestResults.value[Number(target.id)]
    }
    const wasPassword = dialog.value === 'password'
    toast(dialog.value === 'delete' ? '已删除。' : wasPassword ? '密码已更新，请重新登录。' : '已保存。')
    dialogBusy.value = false
    closeDialog()
    if (wasPassword) { authenticated.value = false; loginError.value = ''; password.value = ''; loadId++ }
    else await loadPage()
  } catch (error) { dialogError.value = errorText(error) }
  finally { dialogBusy.value = false }
}
async function testWebhook(hook: Webhook) {
  if (testingHook.value !== null || testingHookForm.value) return
  testingHook.value = hook.id
  try {
    const feedback = await requestWebhookTest(`/webhooks/${hook.id}/test`, hook.name)
    hookTestResults.value[hook.id] = feedback
    toast(feedback.result?.message || feedback.error, feedback.result?.success ? 'success' : 'error')
    try {
      const value = await api<Webhook[] | PageResult<Webhook>>('/webhooks')
      hooks.value = Array.isArray(value) ? value : value.items || []
    } catch (error) {
      hookTestResults.value[hook.id]!.refresh_error = errorText(error)
    }
  }
  finally { testingHook.value = null }
}
async function testWebhookForm() {
  if (dialogBusy.value || testingHook.value !== null) return
  dialogError.value = ''
  if (!validateWebhookForm()) return
  dialogBusy.value = true
  testingHookForm.value = true
  testedHookForm.value = JSON.stringify(hookForm.value)
  try {
    hookFormTestResult.value = await requestWebhookTest('/webhooks/test', hookForm.value.name, testedHookForm.value)
  } finally {
    dialogBusy.value = false
    testingHookForm.value = false
  }
}
async function toggleWebhook(hook: Webhook) {
  if (savingHook.value) return
  savingHook.value = true
  try {
    await api(`/webhooks/${hook.id}`, { method: 'PUT', body: JSON.stringify({ name: hook.name, url: hook.url, format: hook.format, enabled: !hook.enabled }) })
    toast(hook.enabled ? '已暂停此通知地址。' : '已启用此通知地址。')
    await loadPage()
  } catch (error) { toast(errorText(error), 'error') }
  finally { savingHook.value = false }
}
async function copyDetails() {
  try { await navigator.clipboard.writeText(jsonEvent.value); toast('原始事件已复制。') }
  catch { toast('浏览器不允许复制，请在原始详情中手动选择文本。', 'error') }
}
function refreshAutomatically() {
  if (!authenticated.value || loading.value || dialog.value || dialogBusy.value || savingHook.value || testingHook.value !== null || document.hidden) return
  void loadPage()
}
function visibilityChanged() {
  pageVisible.value = !document.hidden
  if (pageVisible.value) refreshAutomatically()
}
watch(authenticated, (loggedIn) => {
  clearInterval(refreshTimer)
  refreshTimer = loggedIn ? setInterval(refreshAutomatically, 15_000) : undefined
})
onMounted(async () => {
  window.addEventListener('auth-expired', expired)
  document.addEventListener('visibilitychange', visibilityChanged)
  try {
    const result = await api<{ username: string }>('/auth/me')
    user.value = result.username
    authenticated.value = true
    await loadPage()
  } catch (error) { loginError.value = error instanceof ApiError && error.status === 401 ? '' : errorText(error) }
  finally { booting.value = false }
})
onBeforeUnmount(() => {
  window.removeEventListener('auth-expired', expired)
  document.removeEventListener('visibilitychange', visibilityChanged)
  clearTimeout(noticeTimer)
  clearInterval(refreshTimer)
  loadId++
})
</script>

<template>
  <div v-if="booting" class="boot-screen"><span class="brand-symbol"><ShieldCheck :size="28" /></span><LoaderCircle class="spin" :size="24" /><span>正在连接安全中心…</span></div>

  <div v-else-if="!authenticated" class="login-page">
    <section class="login-story">
      <a class="brand login-brand" href="#"><span class="brand-symbol"><ShieldCheck :size="25" /></span><span>安全中心<small>SECURITY CENTER</small></span></a>
      <div class="login-story-content"><span class="eyebrow light">VISIBILITY. INTEGRITY. SECURITY.</span><h1>每一次变化，<br>都有迹可循。</h1><p>汇集机器告警、文件完整性与远程登录记录，<br>在一个地方掌握你的安全状态。</p><div class="login-feature"><Fingerprint :size="20" /><span>文件完整性监测</span><span class="feature-line"></span><LogIn :size="20" /><span>登录行为追溯</span></div></div>
      <div class="login-grid" aria-hidden="true"><div class="login-orbit orbit-one"></div><div class="login-orbit orbit-two"></div><div class="login-shield"><ShieldCheck :size="76" :stroke-width="1.2" /></div><span class="orbit-node node-one"></span><span class="orbit-node node-two"></span><span class="orbit-node node-three"></span></div>
      <div class="login-footer">统一安全管理 · 持续关注每一台机器</div>
    </section>
    <section class="login-form-section">
      <form class="login-form" @submit.prevent="login">
        <span class="eyebrow">WELCOME BACK</span><h2>登录安全中心</h2><p class="muted">使用管理员账号访问控制台。</p>
        <div v-if="loginError" class="error-banner" role="alert"><ShieldAlert :size="18" />{{ loginError }}</div>
        <label>账号<input v-model="username" name="username" autocomplete="username" required placeholder="admin" :disabled="loginBusy" /></label>
        <label>密码<input v-model="password" name="password" type="password" autocomplete="current-password" required placeholder="请输入密码" :disabled="loginBusy" /></label>
        <button type="submit" class="button primary login-submit" :disabled="loginBusy"><LoaderCircle v-if="loginBusy" class="spin" :size="18" /><span>{{ loginBusy ? '正在登录' : '登录控制台' }}</span><ArrowRight v-if="!loginBusy" :size="18" /></button>
        <p class="login-help"><KeyRound :size="15" />忘记密码？可在主控服务器使用管理员密码重置脚本。</p>
      </form>
      <span class="login-copyright">安全中心 · 主控管理平台</span>
    </section>
  </div>

  <div v-else class="app-shell">
    <div v-if="mobileMenu" class="sidebar-backdrop" @click="mobileMenu = false"></div>
    <aside class="sidebar" :class="{ 'is-open': mobileMenu }">
      <button class="brand brand-button" @click="navigate('overview')"><span class="brand-symbol"><ShieldCheck :size="25" /></span><span>安全中心<small>SECURITY CENTER</small></span></button>
      <span class="nav-label">工作空间</span>
      <nav aria-label="主导航">
        <button :class="{ active: view === 'overview' }" @click="navigate('overview')"><LayoutDashboard :size="19" /><span>安全概览</span></button>
        <button :class="{ active: view === 'machines' }" @click="navigate('machines')"><Server :size="19" /><span>机器管理</span><span v-if="overview" class="nav-count">{{ overview.machines }}</span></button>
        <button :class="{ active: view === 'events' }" @click="navigate('events')"><Activity :size="19" /><span>安全事件</span></button>
      </nav>
      <span class="nav-label settings-label">管理设置</span>
      <nav aria-label="管理设置"><button :class="{ active: view === 'webhooks' }" @click="navigate('webhooks')"><WebhookIcon :size="19" /><span>通知配置</span></button><button :class="{ active: view === 'encryption' }" @click="navigate('encryption')"><KeyRound :size="19" /><span>Age 配置加密</span></button><button @click="openPassword"><KeyRound :size="19" /><span>修改密码</span></button></nav>
      <div class="sidebar-bottom"><div class="sidebar-caption"><ShieldCheck :size="17" /><span>让每一次异常可被发现</span></div><div class="user-row"><span class="avatar">{{ user.slice(0, 1).toUpperCase() }}</span><div><strong>{{ user }}</strong><span>管理员</span></div><button class="logout-button" aria-label="退出登录" title="退出登录" @click="logout"><LogOut :size="18" /></button></div></div>
    </aside>

    <div class="workspace">
      <header class="topbar"><div class="breadcrumb"><button class="icon-button mobile-menu" aria-label="打开导航" @click="mobileMenu = true"><Menu :size="22" /></button><ShieldCheck :size="17" class="muted" /><span>安全中心</span><ChevronRight :size="14" /><strong>{{ selectedMachine ? '机器详情' : title }}</strong></div><div class="topbar-right"><span class="timezone-label"><Clock3 :size="14" />本地时间</span><span class="small-avatar">{{ user.slice(0, 1).toUpperCase() }}</span></div></header>
      <main>
        <div class="page-heading">
          <div><button v-if="selectedMachine" class="back-link" @click="navigate('machines')"><ArrowLeft :size="15" />返回机器列表</button><span v-else class="eyebrow">{{ view === 'overview' ? 'SECURITY OVERVIEW' : view === 'machines' ? 'MACHINE INVENTORY' : view === 'events' ? 'SECURITY EVENTS' : view === 'encryption' ? 'AGENT CONFIGURATION' : 'NOTIFICATION SETTINGS' }}</span><h1>{{ title }}<span v-if="selectedMachine" class="badge" :class="isOnline(selectedMachine) ? 'success' : 'offline'"><span class="status-dot"></span>{{ isOnline(selectedMachine) ? '在线' : '异常离线' }}</span></h1><p>{{ selectedMachine ? '查看这台机器的完整安全记录，定位异常并记录处理结果。' : view === 'overview' ? '集中查看机器状态，及时发现并追踪安全异常。' : view === 'machines' ? '以机器 IP 为索引，掌握每台机器的安全状态。' : view === 'events' ? '追踪文件变化、远程登录与安全巡检的每一次记录。' : view === 'encryption' ? '编辑 YAML，生成 Agent 可直接读取的加密配置。' : '管理告警通知地址，让重要的安全事件及时送达。' }}</p></div>
          <div class="heading-actions"><button v-if="selectedMachine" class="button secondary" @click="editMachine"><Pencil :size="16" />编辑机器</button><button v-if="view === 'webhooks'" class="button primary" @click="editWebhook()"><Plus :size="17" />添加通知地址</button><button class="button secondary" :disabled="loading" @click="loadPage"><RefreshCw :size="16" :class="{ spin: loading }" />刷新</button></div>
        </div>

        <div class="refresh-strip" aria-live="polite"><span :class="{ 'refresh-error': pageError }"><RefreshCw :size="12" :class="{ spin: loading }" />{{ refreshStatus }}</span><span v-if="updatedAt">最近更新 {{ shortTime(updatedAt) }}</span></div>
        <div v-if="pageError" class="error-banner" role="alert"><ShieldAlert :size="18" /><span>{{ pageError }}</span><button @click="loadPage">重试</button></div>

        <template v-if="view === 'overview'">
          <section class="stats-grid" aria-label="安全指标"><button v-for="(stat, index) in stats" :key="stat.label" class="stat-card" @click="statNavigate(index)"><div class="stat-top"><span>{{ stat.label }}</span><span class="stat-icon" :class="stat.color"><component :is="stat.icon" :size="20" /></span></div><strong class="stat-value">{{ stat.value?.toLocaleString() ?? '—' }}</strong><div class="stat-note"><span v-if="index === 0" class="status-dot online-dot"></span>{{ stat.note }}<ArrowRight :size="14" /></div></button></section>
          <section class="connection-summary" :class="{ 'has-offline': offlineMachines > 0 }"><ShieldAlert v-if="offlineMachines > 0" :size="20" /><CheckCheck v-else :size="20" /><div><strong>{{ overview ? `当前在线 ${overview.online_machines} 台 · 异常离线 ${offlineMachines} 台` : '正在获取机器连接状态' }}</strong><p>{{ offlineMachines > 0 ? '部分机器已超过心跳上报阈值，请查看最后上报时间。恢复上报后会自动显示在线。' : '机器首次上报后自动接入，连接状态随心跳上报持续更新。' }}</p></div><button class="text-button" @click="navigate('machines')">查看机器<ArrowRight :size="15" /></button></section>
          <section class="overview-banner"><span class="banner-icon"><ShieldCheck :size="28" /></span><div><h2>{{ overview ? overview.open_alerts > 0 ? `有 ${overview.open_alerts} 条告警等待处理` : '关注变化，守护每一台机器' : '连接你的机器，建立安全视野' }}</h2><p>{{ overview && overview.open_alerts > 0 ? '查看告警中的文件路径与变更详情，确认异常原因并标记处理状态。' : 'Agent 上报的数据将在这里集中展示，持续积累可追溯的安全记录。' }}</p></div><button class="button banner-button" @click="navigate('events', 'alert')">查看安全告警<ArrowRight :size="16" /></button></section>
        </template>

        <template v-if="view === 'machines' && !selectedMachine">
          <section class="inventory-summary"><div><span class="summary-dot blue-dot"></span>全部机器 <strong>{{ overview?.machines ?? '—' }}</strong></div><div><span class="summary-dot green-dot"></span>当前在线 <strong>{{ overview?.online_machines ?? '—' }}</strong></div><div><span class="summary-dot red-dot"></span>异常离线 <strong class="offline-text">{{ overview ? offlineMachines : '—' }}</strong></div></section>
          <section class="panel"><div class="panel-toolbar"><div><h2>机器列表 <span class="count-tag">{{ machineTotal }}</span></h2><p>点击机器，查看全部告警与登录记录。</p></div><form class="search-form" @submit.prevent="applyMachineSearch"><div class="search-input"><Search :size="17" /><input v-model="machineSearch" aria-label="搜索机器" placeholder="搜索 IP、主机名或备注…" /></div><button class="button secondary" :disabled="loading">搜索</button></form></div>
            <div class="table-scroll" :aria-busy="loading"><table class="machine-table"><thead><tr><th>机器 / IP</th><th>连接状态</th><th>待处理告警</th><th>登录记录</th><th>最后上报</th><th class="right">操作</th></tr></thead><tbody><tr v-for="machine in machines" :key="machine.ip"><td><button class="machine-name" @click="openMachine(machine)"><span class="machine-icon"><Server :size="19" /></span><span><strong>{{ machine.alias || machine.host || machine.ip }}</strong><span class="mono">{{ machine.ip }}</span></span></button></td><td><span class="badge" :class="isOnline(machine) ? 'success' : 'offline'"><span class="status-dot"></span>{{ isOnline(machine) ? '在线' : '异常离线' }}</span></td><td><span :class="machine.open_alert_count > 0 ? 'alert-number' : 'muted'">{{ machine.open_alert_count }}</span><span class="cell-suffix"> / {{ machine.alert_count }} 条告警</span></td><td><span class="number">{{ machine.login_count }}</span><span class="cell-suffix"> 次</span></td><td class="time-cell">{{ displayTime(machine.last_seen) }}</td><td class="right"><button class="text-button" @click="openMachine(machine)">查看记录<ChevronRight :size="15" /></button></td></tr></tbody></table></div>
            <div v-if="!machines.length" class="empty-state"><LoaderCircle v-if="loading" :size="30" class="spin" /><Server v-else :size="35" /><h3>{{ loading ? '正在加载机器' : appliedMachineSearch ? '未找到匹配的机器' : '还没有机器接入' }}</h3><p>{{ loading ? '请稍候…' : appliedMachineSearch ? '尝试其他 IP、主机名或备注关键词。' : 'Agent 首次向主控上报后，机器将自动显示在这里。' }}</p></div>
            <Pagination :page="machinePage" :page-size="machineSize" :total="machineTotal" :disabled="loading" @change="machinePage = $event; loadPage()" @resize="machineSize = $event; machinePage = 1; loadPage()" />
          </section>
        </template>

        <template v-if="selectedMachine">
          <section class="machine-detail-card"><span class="detail-machine-icon"><Server :size="29" /></span><div class="machine-identity"><span class="eyebrow">MACHINE IDENTITY</span><h2 class="mono">{{ selectedMachine.ip }}</h2><p>{{ selectedMachine.host || '未提供主机名' }}<span v-if="selectedMachine.alias"> · {{ selectedMachine.alias }}</span></p></div><dl class="machine-meta"><div><dt>首次接入</dt><dd>{{ displayTime(selectedMachine.first_seen) }}</dd></div><div><dt>最后上报</dt><dd>{{ displayTime(selectedMachine.last_seen) }}</dd></div><div><dt>待处理 / 全部告警</dt><dd><strong :class="{ 'alert-number': selectedMachine.open_alert_count > 0 }">{{ selectedMachine.open_alert_count }}</strong> / {{ selectedMachine.alert_count }}</dd></div><div><dt>登录 / 全部记录</dt><dd>{{ selectedMachine.login_count }} / {{ selectedMachine.event_count }}</dd></div></dl><button class="icon-button danger-text machine-delete" aria-label="删除机器及记录" title="删除机器及全部记录" @click="confirmDelete('machine', selectedMachine.ip, selectedMachine.ip)"><Trash2 :size="17" /></button><div class="heartbeat-note" :class="{ 'offline-text': !isOnline(selectedMachine) }"><Clock3 :size="15" /><span>超过 {{ offlineAfter(selectedMachine) }} 秒未上报则异常离线；恢复上报后自动上线。</span></div><div v-if="selectedMachine.notes" class="machine-notes"><FileSearch :size="15" /><span>{{ selectedMachine.notes }}</span></div></section>
        </template>

        <section v-if="view === 'overview' || view === 'events' || selectedMachine" class="panel event-panel">
          <div class="panel-toolbar event-toolbar"><div><h2>{{ view === 'overview' ? '最近安全动态' : selectedMachine ? '机器事件记录' : '事件记录' }}<span class="count-tag">{{ eventTotal.toLocaleString() }}</span></h2><p>{{ view === 'overview' ? '按发生时间排列的最新告警、登录与巡检。' : '记录时间按浏览器本地时区显示，支持时间范围筛选。' }}</p></div><button v-if="view === 'overview'" class="text-button" @click="navigate('events')">全部事件<ArrowRight :size="16" /></button><span v-else class="subtle-label"><SlidersHorizontal :size="15" />筛选与追溯</span></div>
          <template v-if="view !== 'overview'"><div class="tabs" role="tablist" aria-label="事件类型"><button v-for="tab in tabs" :key="tab.value" :class="{ active: eventType === tab.value }" role="tab" :aria-selected="eventType === tab.value" @click="setEventType(tab.value)">{{ tab.label }}</button></div><form class="filters" @submit.prevent="applyEventSearch"><div class="search-input"><Search :size="17" /><input v-model="eventSearch" aria-label="搜索事件" placeholder="搜索 IP、文件路径、登录用户…" /></div><select v-model="eventStatusFilter" class="status-filter" aria-label="处理状态"><option value="">全部状态</option><option value="open">待处理</option><option value="resolved">已处理</option></select><label class="date-filter"><span>开始</span><input v-model="eventFrom" type="datetime-local" aria-label="开始时间" /></label><span class="date-separator">—</span><label class="date-filter"><span>结束</span><input v-model="eventTo" type="datetime-local" aria-label="结束时间" /></label><button class="button primary filter-button" :disabled="loading"><Search :size="15" />查询</button><button type="button" class="button ghost" :disabled="loading" @click="clearFilters">重置</button></form></template>
          <div class="table-scroll" :aria-busy="loading"><table class="events-table"><thead><tr><th>类型</th><th>事件内容</th><th v-if="!selectedMachine">所属机器</th><th>发生时间</th><th>处理状态</th><th class="right">操作</th></tr></thead><tbody><tr v-for="event in events" :key="event.id"><td><span class="event-type" :class="event.type"><ShieldAlert v-if="event.type === 'alert'" :size="16" /><LogIn v-else-if="event.type === 'ssh_login'" :size="16" /><Activity v-else :size="16" />{{ typeLabel(event.type) }}</span></td><td class="event-content"><button class="event-title" @click="openEvent(event)">{{ eventTitle(event) }}</button><span class="event-subtitle mono">{{ eventSubtitle(event) }}</span><div v-if="event.type === 'alert' && (event.data.before || event.data.after)" class="hash-preview"><span v-if="event.data.before"><span class="hash-label">变更前</span><code>{{ textField(event.data, 'before') }}</code></span><span v-if="event.data.after"><span class="hash-label">变更后</span><code>{{ textField(event.data, 'after') }}</code></span></div></td><td v-if="!selectedMachine"><button class="machine-ip-link mono" @click="openMachine(event.machine_ip)">{{ event.machine_ip }}</button><span v-if="event.host" class="event-host">{{ event.host }}</span></td><td class="time-cell">{{ displayTime(event.time) }}</td><td><span class="badge" :class="event.status === 'resolved' ? 'success' : event.type === 'alert' ? 'warning' : 'neutral'"><Check v-if="event.status === 'resolved'" :size="12" /><span v-else class="status-dot"></span>{{ event.status === 'resolved' ? '已处理' : '待处理' }}</span></td><td class="right"><button class="icon-button" aria-label="查看事件详情" title="查看事件详情" @click="openEvent(event)"><MoreHorizontal :size="20" /></button></td></tr></tbody></table></div>
          <div v-if="!events.length" class="empty-state"><LoaderCircle v-if="loading" :size="30" class="spin" /><FileSearch v-else :size="35" /><h3>{{ loading ? '正在加载事件' : '暂无事件记录' }}</h3><p>{{ loading ? '请稍候…' : view === 'overview' ? '机器上报后，这里会显示最新的安全动态。' : '当前筛选条件下没有记录，可调整时间或搜索关键词。' }}</p></div>
          <Pagination v-if="view !== 'overview'" :page="eventPage" :page-size="eventSize" :total="eventTotal" :disabled="loading" @change="eventPage = $event; loadPage()" @resize="eventSize = $event; eventPage = 1; loadPage()" /><div v-else class="panel-footnote"><span><Clock3 :size="13" />{{ updatedAt ? `更新于 ${shortTime(updatedAt)}` : '等待同步数据' }}</span><span>最新 {{ events.length }} 条记录</span></div>
        </section>

        <AgentEncryption v-if="view === 'encryption'" />
        <template v-if="view === 'webhooks'">
          <div class="info-banner"><BellRing :size="21" /><div><strong>一条告警，多处送达</strong><p>主控将新告警发送到所有已启用的通知地址，正文包含机器 IP、主机名、时间、告警类型、检测目标、描述、变更前后值与事件 ID。暂停后停止自动告警投递，仍可手动发送测试。</p><p>消息格式固定为 Lark 机器人，请填写 Lark 机器人的 Webhook 地址。测试后可在下方查看接收端响应与本次正文。</p></div></div>
          <div class="webhook-grid">
            <article v-for="hook in hooks" :key="hook.id" class="webhook-card">
              <div class="webhook-card-top"><span class="webhook-icon"><WebhookIcon :size="24" /></span><span class="badge" :class="hook.enabled ? 'success' : 'neutral'"><span class="status-dot"></span>{{ hook.enabled ? '已启用' : '已暂停' }}</span><div class="card-actions"><button class="icon-button" :aria-label="`编辑 ${hook.name}`" :disabled="testingHook === hook.id" @click="editWebhook(hook)"><Pencil :size="16" /></button><button class="icon-button danger-text" :aria-label="`删除 ${hook.name}`" :disabled="testingHook === hook.id" @click="confirmDelete('webhook', hook.id, hook.name)"><Trash2 :size="16" /></button></div></div>
              <h2>{{ hook.name }}</h2><span class="webhook-format">{{ formatNames[hook.format] || hook.format }}</span>
              <div class="endpoint-display"><Globe :size="16" /><span>{{ webhookHostname(hook.url) }}</span><span class="muted">/ ···</span></div><p class="endpoint-hint">完整地址可在编辑中查看</p>
              <dl class="webhook-delivery"><div><dt>最近成功</dt><dd>{{ displayTime(hook.last_success_at) }}</dd></div><div><dt>等待投递</dt><dd>{{ hook.pending_count ?? 0 }} 条</dd></div></dl>
              <div v-if="hook.last_error" class="delivery-error"><ShieldAlert :size="15" /><span>{{ hook.last_error }}</span></div>
              <WebhookTestFeedback v-if="hookTestResults[hook.id]" :feedback="hookTestResults[hook.id]!" />
              <div class="webhook-card-footer"><button class="toggle-control" :aria-pressed="hook.enabled" :aria-label="hook.enabled ? '暂停通知' : '启用通知'" :disabled="loading || savingHook || testingHook !== null" @click="toggleWebhook(hook)"><span class="toggle" :class="{ enabled: hook.enabled }"><span></span></span>{{ hook.enabled ? '通知已开启' : '通知已暂停' }}</button><button class="button secondary small" :disabled="testingHook !== null || testingHookForm || savingHook" @click="testWebhook(hook)"><LoaderCircle v-if="testingHook === hook.id" class="spin" :size="15" /><Send v-else :size="15" />发送测试</button></div>
            </article>
            <button v-if="hooks.length" class="add-webhook-card" @click="editWebhook()"><span><Plus :size="25" /></span><strong>添加通知地址</strong><p>连接更多通知渠道</p></button>
          </div>
          <section v-if="!hooks.length" class="panel empty-state webhook-empty"><LoaderCircle v-if="loading" :size="32" class="spin" /><WebhookIcon v-else :size="39" /><h3>{{ loading ? '正在加载通知配置' : '配置你的第一个通知地址' }}</h3><p>将文件变化与安全异常送达团队常用的通知渠道。</p><button v-if="!loading" class="button primary" @click="editWebhook()"><Plus :size="17" />添加通知地址</button></section>
        </template>
        <footer class="workspace-footer"><span><ShieldCheck :size="14" />安全中心</span><span>所有记录来自 Agent 实际上报</span></footer>
      </main>
    </div>
  </div>

  <Transition name="toast"><div v-if="notice" class="toast-notice" :class="notice.kind" role="status"><CheckCheck v-if="notice.kind === 'success'" :size="19" /><ShieldAlert v-else :size="19" /><span>{{ notice.message }}</span><button class="icon-button" aria-label="关闭提示" @click="notice = null"><X :size="15" /></button></div></Transition>

  <Teleport to="body"><div v-if="dialog && authenticated" class="modal-backdrop" @click.self="closeDialog"><section ref="modalRef" class="modal" :class="{ 'event-modal': dialog === 'event', 'confirm-modal': dialog === 'delete' }" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1" @keydown="dialogKeydown"><div class="modal-header"><div><span class="eyebrow">{{ dialog === 'event' ? 'EVENT DETAILS' : dialog === 'delete' ? 'CONFIRM DELETION' : 'SETTINGS' }}</span><h2 id="dialog-title">{{ dialog === 'event' ? '事件详情' : dialog === 'machine' ? '编辑机器信息' : dialog === 'webhook' ? editingHookId === null ? '添加通知地址' : '编辑通知地址' : dialog === 'password' ? '修改登录密码' : '确认删除' }}</h2></div><button class="icon-button" aria-label="关闭对话框" :disabled="dialogBusy" @click="closeDialog"><X :size="20" /></button></div>
      <form @submit.prevent="saveDialog"><div class="modal-body">
        <div v-if="dialogError" class="error-banner" role="alert"><ShieldAlert :size="17" />{{ dialogError }}</div>
        <template v-if="dialog === 'event' && activeEvent"><div class="event-detail-heading"><span class="event-type" :class="activeEvent.type"><ShieldAlert v-if="activeEvent.type === 'alert'" :size="17" /><LogIn v-else-if="activeEvent.type === 'ssh_login'" :size="17" /><Activity v-else :size="17" />{{ typeLabel(activeEvent.type) }}</span><span class="muted mono">#{{ activeEvent.id }}</span></div><h3 class="detail-event-title">{{ eventTitle(activeEvent) }}</h3><dl class="detail-grid"><div><dt>所属机器</dt><dd class="mono">{{ activeEvent.machine_ip }}</dd></div><div><dt>主机名</dt><dd>{{ activeEvent.host || '—' }}</dd></div><div><dt>发生时间</dt><dd>{{ displayTime(activeEvent.time) }}</dd></div><div><dt>接收时间</dt><dd>{{ displayTime(activeEvent.received_at) }}</dd></div><template v-if="activeEvent.type === 'alert'"><div><dt>检测模块</dt><dd>{{ moduleLabel(activeEvent.data) }}</dd></div><div><dt>告警类型</dt><dd>{{ alertKindLabel(activeEvent.data) }}</dd></div><div class="full"><dt>文件路径 / 检测目标</dt><dd class="path-value mono">{{ textField(activeEvent.data, 'target') }}</dd></div><div v-if="activeEvent.data.message" class="full"><dt>原始描述</dt><dd>{{ textField(activeEvent.data, 'message') }}</dd></div></template><template v-if="activeEvent.type === 'ssh_login'"><div><dt>登录来源 IP</dt><dd class="mono">{{ textField(activeEvent.data, 'source_ip') }}</dd></div><div><dt>登录用户</dt><dd>{{ textField(activeEvent.data, 'user') }}</dd></div><div><dt>终端</dt><dd>{{ textField(activeEvent.data, 'terminal') }}</dd></div><div><dt>登录方式</dt><dd>{{ textField(activeEvent.data, 'method') }}</dd></div></template></dl><div v-if="activeEvent.type === 'alert' && (activeEvent.data.before || activeEvent.data.after)" class="hash-comparison"><h4><Fingerprint :size="17" />变更内容 / MD5</h4><div><span><ArrowLeft :size="13" />变更前</span><code>{{ textField(activeEvent.data, 'before') }}</code></div><div><span><ArrowRight :size="13" />变更后</span><code>{{ textField(activeEvent.data, 'after') }}</code></div></div><div class="form-section-title"><Settings2 :size="17" />处理记录</div><label>处理状态<select v-model="eventStatus" :disabled="dialogBusy"><option value="open">待处理</option><option value="resolved">已处理</option></select></label><label>处理备注<textarea v-model="eventNotes" placeholder="记录排查结果、处理措施或跟进事项…" rows="3" maxlength="4000" :disabled="dialogBusy"></textarea></label><details class="raw-details"><summary>查看原始事件 JSON</summary><button type="button" class="text-button copy-json" @click="copyDetails"><Copy :size="14" />复制</button><pre>{{ jsonEvent }}</pre></details></template>
        <template v-if="dialog === 'machine'"><p class="modal-description">IP 是机器的唯一标识，别名与备注可帮助你快速识别用途。</p><label>机器 IP<input :value="selectedMachine?.ip" disabled class="mono" /></label><label>机器别名<input v-model="machineForm.alias" placeholder="例如：生产环境 · 应用服务器" maxlength="100" :disabled="dialogBusy" /></label><label>备注<textarea v-model="machineForm.notes" placeholder="用途、负责人或其他补充信息" rows="4" maxlength="4000" :disabled="dialogBusy"></textarea></label></template>
        <template v-if="dialog === 'webhook'">
          <p class="modal-description">保存后，主控会将新告警发送到已启用的地址。告警正文包含机器 IP、主机名、时间、类型、目标、描述、变更前后值与事件 ID。</p>
          <label>通知名称<input v-model="hookForm.name" placeholder="例如：运维安全告警群" required maxlength="100" :disabled="dialogBusy" /></label>
          <label>消息格式<select v-model="hookForm.format" :disabled="dialogBusy"><option value="feishu">Lark 机器人</option></select><small>通知将以 Lark 机器人文本消息发送。</small></label>
          <label>Webhook URL<textarea v-model="hookForm.url" class="mono url-input" placeholder="https://…" required rows="3" maxlength="4096" :disabled="dialogBusy" spellcheck="false"></textarea><small>请输入完整的通知地址，包括所需的路径与参数。</small></label>
          <label class="checkbox-label"><input v-model="hookForm.enabled" type="checkbox" :disabled="dialogBusy" /><span>启用这个通知地址<small>开启后接收新告警；暂停后停止自动投递，仍可手动测试。</small></span></label>
          <div class="webhook-form-test"><button type="button" class="button secondary" :disabled="dialogBusy || testingHook !== null" @click="testWebhookForm"><LoaderCircle v-if="testingHookForm" class="spin" :size="16" /><Send v-else :size="16" />{{ testingHookForm ? '正在测试…' : '发送测试' }}</button><p>测试当前填写的配置，不保存更改。</p></div>
          <WebhookTestFeedback v-if="hookFormTestResult" :feedback="hookFormTestResult" :stale="hookFormTestStale" />
        </template>
        <template v-if="dialog === 'password'"><p class="modal-description">为管理员账号设置新的登录密码，更新成功后请重新登录。</p><label>当前密码<input v-model="passwordForm.current" type="password" autocomplete="current-password" required :disabled="dialogBusy" /></label><label>新密码<input v-model="passwordForm.next" type="password" autocomplete="new-password" required maxlength="72" placeholder="8–72 字节，建议使用字母、数字与符号" :disabled="dialogBusy" /></label><label>确认新密码<input v-model="passwordForm.confirm" type="password" autocomplete="new-password" required maxlength="72" :disabled="dialogBusy" /></label></template>
        <template v-if="dialog === 'delete' && deleteTarget"><div class="delete-icon"><Trash2 :size="27" /></div><p class="delete-message">确定删除 <strong>{{ deleteTarget.label }}</strong> 吗？</p><p class="muted delete-hint">{{ deleteTarget.kind === 'machine' ? '这会删除该机器和它的全部事件记录。Agent 再次上报后机器会重新出现，但已删除的历史记录无法恢复。' : deleteTarget.kind === 'event' ? '这条事件及处理备注将永久删除，无法恢复。' : '该通知地址将被移除，不再接收新告警。' }}</p></template>
      </div><div class="modal-footer"><button v-if="dialog === 'event' && activeEvent" type="button" class="button ghost danger-text delete-event-button" :disabled="dialogBusy" @click="confirmDelete('event', activeEvent.id, `事件 #${activeEvent.id}`)"><Trash2 :size="16" />删除记录</button><button type="button" class="button secondary" :disabled="dialogBusy" @click="closeDialog">取消</button><button type="submit" class="button" :class="dialog === 'delete' ? 'danger' : 'primary'" :disabled="dialogBusy"><LoaderCircle v-if="dialogBusy" class="spin" :size="16" /><span>{{ dialogBusy ? '正在处理…' : dialog === 'delete' ? '确认删除' : dialog === 'password' ? '更新密码' : '保存更改' }}</span></button></div></form>
    </section></div></Teleport>
</template>
