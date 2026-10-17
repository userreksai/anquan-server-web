<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Check, Clock3, LoaderCircle, RefreshCw, Save, SlidersHorizontal } from 'lucide-vue-next'
import { api } from '../api'
import { readEventPolicy, securityEventSeverityOptions, tetragonKindOptions } from '../event-policy'
import type { EventPolicy } from '../event-policy'

const emit = defineEmits<{ saved: [policy: EventPolicy] }>()
const policy = ref<EventPolicy | null>(null)
const ignoredKinds = ref<string[]>([])
const retentionHours = ref<12 | 24>(24)
const minSeverity = ref<EventPolicy['security_event_min_severity']>('warning')
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const message = ref('')
const controller = new AbortController()
const pending = computed(() => loading.value || saving.value)
const dirty = computed(() => policy.value !== null && (minSeverity.value !== policy.value.security_event_min_severity || retentionHours.value !== policy.value.scan_summary_retention_hours || JSON.stringify([...ignoredKinds.value].sort()) !== JSON.stringify([...policy.value.tetragon_ignored_kinds].sort())))
const canSave = computed(() => policy.value !== null && !pending.value && dirty.value)

function adopt(value: EventPolicy) {
  policy.value = value
  ignoredKinds.value = [...value.tetragon_ignored_kinds]
  retentionHours.value = value.scan_summary_retention_hours
  minSeverity.value = value.security_event_min_severity
}
function changed() { message.value = ''; error.value = '' }
function ignoreRoutineEvents() {
  if (pending.value || !policy.value) return
  ignoredKinds.value = [...new Set([...ignoredKinds.value, 'process_exec', 'process_exit'])]
  changed()
}
function clearIgnoredKinds() {
  if (pending.value || !policy.value) return
  ignoredKinds.value = []
  changed()
}
async function loadPolicy() {
  if (saving.value || controller.signal.aborted) return
  loading.value = true; error.value = ''; message.value = ''
  try {
    const result = await api<unknown>('/settings/event-policy', { signal: controller.signal })
    if (!controller.signal.aborted) adopt(readEventPolicy(result))
  } catch (cause) {
    if (!controller.signal.aborted) error.value = `读取事件策略失败：${cause instanceof Error ? cause.message : '请稍后重试。'} 读取成功前无法保存。`
  } finally { loading.value = false }
}
async function savePolicy() {
  if (!canSave.value || controller.signal.aborted) return
  saving.value = true; error.value = ''; message.value = ''
  try {
    const result = await api<unknown>('/settings/event-policy', {
      method: 'PUT',
      body: JSON.stringify({ tetragon_ignored_kinds: ignoredKinds.value, scan_summary_retention_hours: retentionHours.value, security_event_min_severity: minSeverity.value }),
      signal: controller.signal,
    })
    if (controller.signal.aborted) return
    const confirmed = readEventPolicy(result)
    adopt(confirmed)
    message.value = '事件策略已保存，全局生效。到期巡检记录会由主控自动清理。'
    emit('saved', confirmed)
  } catch (cause) {
    if (!controller.signal.aborted) error.value = `保存事件策略失败：${cause instanceof Error ? cause.message : '请稍后重试。'} 当前修改已保留，请重试。`
  } finally { saving.value = false }
}
onMounted(() => { void loadPolicy() })
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <section class="panel event-policy-panel" aria-labelledby="event-policy-heading" :aria-busy="pending">
    <header class="event-policy-heading">
      <div><h2 id="event-policy-heading"><SlidersHorizontal :size="20" />事件降噪与巡检保留 <span class="count-tag">全局</span></h2><p>在主控统一控制事件入库与巡检保留时间，保存后对所有机器生效，无需更新 Agent。</p></div>
      <span v-if="policy" class="badge" :class="policy.tetragon_ignored_kinds.length ? 'warning' : 'neutral'">{{ policy.tetragon_ignored_kinds.length ? `已屏蔽 ${policy.tetragon_ignored_kinds.length} 类 Tetragon 事件` : '当前未屏蔽 Tetragon 事件' }}</span>
    </header>
    <p v-if="loading" class="event-policy-loading" role="status"><LoaderCircle :size="17" class="spin" />正在读取事件策略…</p>
    <form v-if="policy" @submit.prevent="savePolicy">
      <fieldset :disabled="pending">
        <div class="event-policy-columns">
          <section class="event-policy-card event-policy-severity" aria-labelledby="event-policy-severity-heading">
            <h3 id="event-policy-severity-heading"><label for="event-policy-min-severity">最低安全运行事件级别</label></h3>
            <p id="event-policy-severity-description">默认仅保留警告及以上的异常，普通 auditd 进程执行、sudo 正常记录不入库、不通知。SSH 登录、安全告警、操作命令及单独开启的 sudo 录制文件上传不受影响；已有历史保留。</p>
            <select id="event-policy-min-severity" v-model="minSeverity" aria-describedby="event-policy-severity-description" @change="changed"><option v-for="option in securityEventSeverityOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select>
          </section>
          <section class="event-policy-card" aria-labelledby="event-policy-tetragon">
            <div class="event-policy-card-heading"><h3 id="event-policy-tetragon">屏蔽 Tetragon 事件类型</h3><span class="event-policy-count">已选 {{ ignoredKinds.length }} 类</span></div>
            <p>勾选要屏蔽的具体类型。所选类型的新上报将不入库、不发送通知；已有记录保留，其他来源的事件不受影响。</p>
            <div class="event-policy-shortcuts"><button type="button" class="button secondary small" @click="ignoreRoutineEvents">屏蔽进程执行 / 退出</button><button type="button" class="text-button" :disabled="!ignoredKinds.length" @click="clearIgnoredKinds">取消全部屏蔽</button></div>
            <div class="event-policy-kinds">
              <label v-for="option in tetragonKindOptions" :key="option.value" class="event-policy-choice" :class="{ selected: ignoredKinds.includes(option.value) }"><input v-model="ignoredKinds" type="checkbox" :value="option.value" @change="changed" /><span>{{ option.label }}<small class="mono">{{ option.value }}</small></span></label>
            </div>
          </section>
          <section class="event-policy-card" aria-labelledby="event-policy-retention">
            <h3 id="event-policy-retention"><Clock3 :size="17" />巡检记录保留时间</h3>
            <p>仅清理“巡检记录”（scan_summary），默认保留 24 小时。安全告警、SSH 登录和操作命令不受影响。</p>
            <div class="event-policy-retention">
              <label class="event-policy-choice" :class="{ selected: retentionHours === 24 }"><input v-model="retentionHours" type="radio" name="scan-summary-retention" :value="24" @change="changed" /><span>24 小时<small>保留最近一天的巡检记录</small></span></label>
              <label class="event-policy-choice" :class="{ selected: retentionHours === 12 }"><input v-model="retentionHours" type="radio" name="scan-summary-retention" :value="12" @change="changed" /><span>12 小时<small>减少巡检记录占用</small></span></label>
            </div>
            <div class="event-policy-retention-note"><Clock3 :size="16" /><p>按事件发生时间计算保留期，主控每分钟自动清理。保存后，已有的到期巡检记录也会清理。</p></div>
          </section>
        </div>
      </fieldset>
      <div class="event-policy-actions"><button type="submit" class="button primary" :disabled="!canSave"><LoaderCircle v-if="saving" :size="17" class="spin" /><Save v-else :size="17" />{{ saving ? '正在保存…' : '保存并生效' }}</button><span>{{ dirty ? '有未保存的修改' : '修改选项后，点击保存生效。' }}</span></div>
    </form>
    <div v-if="error" class="event-policy-error" role="alert"><p>{{ error }}</p><button v-if="!policy" type="button" class="button secondary small" :disabled="pending" @click="loadPolicy"><RefreshCw :size="15" />重新读取</button></div>
    <p v-if="message" class="event-policy-success" role="status"><Check :size="17" />{{ message }}</p>
  </section>
</template>

<style scoped>
.event-policy-panel { padding: 22px; margin-bottom: 22px; border-top: 3px solid var(--blue); }
.event-policy-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
h2, h3 { display: flex; align-items: center; gap: 8px; margin: 0; }
h2 { font-size: 16px; } h3 { font-size: 14px; }
.event-policy-heading p, .event-policy-card > p, .event-policy-retention-note p { color: #718198; font-size: 12px; line-height: 1.8; margin: 8px 0 0; }
.event-policy-heading > .badge { margin-top: 2px; white-space: nowrap; }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.event-policy-columns { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(270px, 1fr); gap: 18px; }
.event-policy-card { min-width: 0; border: 1px solid var(--line); border-radius: 9px; padding: 18px; }
.event-policy-severity { grid-column: 1 / -1; }
.event-policy-severity label { margin: 0; font-size: inherit; color: inherit; }
.event-policy-severity select { width: 100%; max-width: 360px; margin-top: 14px; }
.event-policy-card-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.event-policy-count { font-size: 12px; color: #718198; white-space: nowrap; }
.event-policy-shortcuts { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 14px 0; }
.event-policy-kinds { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.event-policy-choice { display: flex; align-items: flex-start; flex-direction: row; gap: 9px; padding: 11px; border: 1px solid var(--line); border-radius: 7px; cursor: pointer; margin: 0; }
.event-policy-choice.selected { border-color: #a9c4fb; background: #f4f7ff; }
.event-policy-choice input { width: 16px; height: 16px; flex-shrink: 0; padding: 0; margin: 2px 0 0; accent-color: var(--blue); }
.event-policy-choice span { min-width: 0; font-size: 12px; line-height: 1.6; }
.event-policy-choice small { display: block; margin-top: 3px; color: #718198; font-size: 11px; overflow-wrap: anywhere; }
.event-policy-retention { display: grid; gap: 10px; margin-top: 18px; }
.event-policy-retention-note { display: flex; align-items: flex-start; gap: 8px; padding: 12px; margin-top: 16px; border-radius: 7px; background: #f4f7fd; color: #718198; }
.event-policy-retention-note svg { flex-shrink: 0; margin-top: 3px; } .event-policy-retention-note p { margin: 0; }
.event-policy-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 18px; }
.event-policy-actions > span { color: #718198; font-size: 12px; }
.event-policy-loading, .event-policy-success { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 1.8; }
.event-policy-loading { color: #718198; } .event-policy-success { margin: 14px 0 0; padding: 12px 14px; border-radius: 8px; color: #14734d; background: #edf9f2; }
.event-policy-error { margin-top: 14px; padding: 12px 14px; border-radius: 8px; color: #b42318; background: #fff0ed; font-size: 12px; line-height: 1.8; }
.event-policy-error p { margin: 0; } .event-policy-error button { margin-top: 10px; }
@media(max-width: 1100px) { .event-policy-columns { grid-template-columns: 1fr; } }
@media(max-width: 650px) { .event-policy-panel { padding: 18px; } .event-policy-heading { flex-direction: column; } .event-policy-kinds { grid-template-columns: 1fr; } }
</style>
