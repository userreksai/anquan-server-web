<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, query } from '../api'
import { sshAccountSnapshot } from '../ssh-accounts'
import type { AgentConfigDelivery, ComponentReport } from '../types'

const props = defineProps<{ machineIP?: string; disabled: boolean }>()
const emit = defineEmits<{ 'target-machine': [value: string]; add: [users: string[]] }>()
const machines = ref<AgentConfigDelivery[]>([])
const report = ref<ComponentReport>()
const selected = ref<string[]>([])
const loadingMachines = ref(false)
const loadingAccounts = ref(false)
const error = ref('')
const showNonLogin = ref(false)
const now = ref(Date.now())
const controller = new AbortController()
let requestID = 0
let timer: ReturnType<typeof setInterval> | undefined
const snapshot = computed(() => sshAccountSnapshot(report.value, props.machineIP || '', now.value))
const canSelect = computed(() => !props.disabled && !loadingAccounts.value && !!props.machineIP && snapshot.value.usable && !error.value)
const visibleUsers = computed(() => snapshot.value.users.filter(user => showNonLogin.value || user.login_shell))
const nonLoginCount = computed(() => snapshot.value.users.filter(user => !user.login_shell).length)
async function refreshMachines() {
  if (loadingMachines.value || props.disabled || controller.signal.aborted) return
  loadingMachines.value = true
  try {
    const result = await api<{ items: AgentConfigDelivery[] }>('/settings/agent-config-deliveries', { signal: controller.signal })
    if (controller.signal.aborted) return
    if (!Array.isArray(result.items)) throw new Error('机器列表格式无效。')
    machines.value = result.items
    error.value = ''
  } catch (cause) { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '读取机器失败。' }
  finally { loadingMachines.value = false }
}
function chooseMachine(value: string) {
  if (props.disabled || value === (props.machineIP || '')) return
  requestID++
  report.value = undefined; selected.value = []; error.value = ''
  emit('target-machine', value)
}
async function refreshAccounts() {
  if (props.disabled || !props.machineIP || controller.signal.aborted) return
  const machineIP = props.machineIP
  const id = ++requestID
  loadingAccounts.value = true; report.value = undefined; selected.value = []; error.value = ''
  try {
    const result = await api<{ items: ComponentReport[] }>('/security/status' + query({ machine_ip: machineIP }), { signal: controller.signal })
    if (controller.signal.aborted || id !== requestID || props.machineIP !== machineIP) return
    if (!Array.isArray(result.items)) throw new Error('组件状态格式无效。')
    report.value = result.items.filter(item => item.machine_ip === machineIP).sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at))[0]
    now.value = Date.now()
  } catch (cause) {
    if (!controller.signal.aborted && id === requestID && props.machineIP === machineIP) error.value = cause instanceof Error ? cause.message : '读取账户快照失败。'
  } finally { if (id === requestID) loadingAccounts.value = false }
}
function addSelected() {
  now.value = Date.now()
  if (!canSelect.value) return
  const eligible = new Set(snapshot.value.users.filter(user => user.login_shell).map(user => user.name))
  const names = [...new Set(selected.value)].filter(name => eligible.has(name))
  if (names.length) emit('add', names)
  selected.value = []
}
watch(() => props.machineIP, () => {
  requestID++; report.value = undefined; selected.value = []; error.value = ''; loadingAccounts.value = false
  void refreshAccounts()
}, { flush: 'sync' })
watch(() => props.disabled, value => {
  if (!value) {
    if (!machines.value.length) void refreshMachines()
    if (props.machineIP && !report.value && !loadingAccounts.value) void refreshAccounts()
  }
})
onMounted(() => {
  void refreshMachines()
  void refreshAccounts()
  timer = setInterval(() => { now.value = Date.now() }, 10_000)
})
onBeforeUnmount(() => { controller.abort(); requestID++; clearInterval(timer) })
</script>

<template>
  <section class="ssh-account-picker" @input.stop @change.stop>
    <h4>从目标机器已发现账户中选择</h4>
    <p>读取 Agent 最近上报的 /etc/passwd 本地账户快照，不含 LDAP / SSSD 目录账户，不会触发远程立即扫描。选择机器后，整份 YAML 仅可下发至该机。</p>
    <label>账户所属机器<select :value="machineIP || ''" :disabled="disabled || loadingMachines" @change="chooseMachine(($event.target as HTMLSelectElement).value)"><option value="">请选择机器</option><option v-if="machineIP && !machines.some(item => item.machine_ip === machineIP)" :value="machineIP">{{ machineIP }}（暂未列出）</option><option v-for="machine in machines" :key="machine.machine_ip" :value="machine.machine_ip">{{ machine.alias || machine.host || machine.machine_ip }} · {{ machine.machine_ip }}</option></select></label>
    <div class="picker-actions"><button type="button" class="button secondary small" :disabled="disabled || loadingMachines" @click="refreshMachines">{{ loadingMachines ? '读取机器中…' : '刷新机器列表' }}</button><button type="button" class="button secondary small" :disabled="disabled || !machineIP || loadingAccounts" @click="refreshAccounts">{{ loadingAccounts ? '读取快照中…' : '读取最新已上报账户' }}</button><button v-if="machineIP" type="button" class="button ghost small" :disabled="disabled" @click="chooseMachine('')">清除机器绑定</button></div>
    <p v-if="machineIP" class="picker-binding">下发目标已绑定：{{ machineIP }}。切换或清除绑定时撤下本次从发现列表追加的账户，已有手工白名单保留。</p>
    <p v-if="error" class="picker-warning" role="alert">{{ error }}</p>
    <template v-if="machineIP && !loadingAccounts">
      <p :class="{ 'picker-warning': !snapshot.usable || snapshot.truncated }" role="status">{{ snapshot.message }}</p>
      <p v-if="snapshot.checkedAt">主机检测时间：{{ new Date(snapshot.checkedAt).toLocaleString('zh-CN', { hour12: false }) }}</p>
      <label v-if="nonLoginCount" class="picker-option"><input v-model="showNonLogin" type="checkbox" :disabled="disabled" />显示 {{ nonLoginCount }} 个非交互账户（通常不能 SSH 登录）</label>
      <div v-if="visibleUsers.length" class="account-list"><label v-for="user in visibleUsers" :key="user.name" class="picker-option"><input v-model="selected" type="checkbox" :value="user.name" :disabled="!canSelect || !user.login_shell" /><span><strong>{{ user.name }}</strong> · UID {{ user.uid }}<small>{{ user.shell || '未设置 shell' }}<span v-if="!user.login_shell"> · 非交互 shell，仅展示</span><span v-else-if="user.uid === 0"> · 特权账户，请明确选择</span></small></span></label></div>
      <p v-else-if="snapshot.usable">没有可建议的交互账户；可按实际需求手动填写白名单。</p>
      <button type="button" class="button secondary small" :disabled="!canSelect || !selected.length" @click="addSelected">将所选账户添加至允许用户</button>
    </template>
  </section>
</template>

<style scoped>
.ssh-account-picker { margin: 14px 0; padding: 14px; border: 1px solid #dfe7f2; border-radius: 8px; background: #f8faff; }
h4 { margin: 0 0 8px; font-size: 13px; }
p { color: #718198; font-size: 12px; line-height: 1.7; margin: 8px 0; overflow-wrap: anywhere; }
label { display: flex; flex-direction: column; gap: 7px; font-size: 12px; }
.picker-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.picker-binding { color: #375f9c; }
.picker-warning { color: #a45d13; }
.account-list { max-height: 240px; overflow: auto; margin: 10px 0; }
.picker-option { flex-direction: row; align-items: flex-start; gap: 8px; padding: 6px 0; }
.picker-option input { width: 16px; height: 16px; flex-shrink: 0; }
small { display: block; color: #718198; margin-top: 4px; overflow-wrap: anywhere; }
</style>
