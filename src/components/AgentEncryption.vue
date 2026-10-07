<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Copy, Download, LoaderCircle, LockKeyhole } from 'lucide-vue-next'
import { api } from '../api'
import { agentConfigTemplate } from '../agent-config-template'

const yaml = ref(agentConfigTemplate)
const ciphertext = ref('')
const busy = ref(false)
const error = ref('')
const message = ref('')
const size = computed(() => new TextEncoder().encode(yaml.value).length)
const controller = new AbortController()
watch(yaml, () => { ciphertext.value = ''; message.value = ''; error.value = '' })
onBeforeUnmount(() => controller.abort())
async function encrypt() {
  ciphertext.value = ''; message.value = ''; error.value = ''
  if (size.value > 4 * 1024 * 1024) { error.value = '配置不能超过 4 MiB'; return }
  busy.value = true
  try {
    const result = await api<{ ciphertext: string }>('/settings/agent-encryption', {
      method: 'POST', body: JSON.stringify({ yaml: yaml.value }), signal: controller.signal,
    })
    ciphertext.value = result.ciphertext
    message.value = '已生成密文。下载或完整复制后保存为 config.age。'
  } catch (e) {
    if (!controller.signal.aborted) error.value = e instanceof Error ? e.message : '加密失败，请重试'
  } finally { busy.value = false }
}
async function copy() {
  try { await navigator.clipboard.writeText(ciphertext.value); message.value = '密文已复制，包含完整 BEGIN / END 标记。' }
  catch { error.value = '无法访问剪贴板，请使用下载，或选中密文手动复制。' }
}
function download() {
  const url = URL.createObjectURL(new Blob([ciphertext.value], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = 'config.age'; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <div class="age-config">
    <div class="info-banner"><LockKeyhole :size="23" /><div><strong>编辑配置，加密后部署到 Agent</strong><p>将 config.age 放在 Agent 可执行文件所在目录。单次运行下次执行生效；常驻服务重启后生效。</p><p>已预填你的配置与说明，请核对目标路径、主控地址和每台机器唯一的 agent_ip。</p></div></div>
    <form @submit.prevent="encrypt">
      <div class="age-columns">
        <section class="panel age-editor">
          <div class="age-editor-heading"><div><h2>明文配置 <span class="count-tag">YAML</span></h2><p>保留注释，按目标节点修改后加密。</p></div><span class="muted">{{ (size / 1024).toFixed(1) }} KiB / 4 MiB</span></div>
          <label class="age-field-label" for="age-yaml">配置内容</label>
          <textarea id="age-yaml" v-model="yaml" :disabled="busy" required spellcheck="false" autocomplete="off" wrap="off" />
          <div class="age-actions"><button class="button primary" type="submit" :disabled="busy || !yaml.trim() || size > 4 * 1024 * 1024"><LoaderCircle v-if="busy" :size="17" class="spin" /><LockKeyhole v-else :size="17" />{{ busy ? '正在加密…' : '加密配置' }}</button><button type="button" class="button secondary" :disabled="busy" @click="yaml = agentConfigTemplate">恢复示例</button></div>
        </section>
        <section class="panel age-editor">
          <div class="age-editor-heading"><div><h2>加密结果 <span class="count-tag">AGE</span></h2><p>完整保存为 config.age，包含首尾标记。</p></div></div>
          <label class="age-field-label" for="age-ciphertext">密文内容</label>
          <textarea id="age-ciphertext" :value="ciphertext" readonly spellcheck="false" wrap="off" placeholder="点击“加密配置”后，这里会显示可直接复制的 age 密文。" />
          <div class="age-actions"><button type="button" class="button primary" :disabled="!ciphertext || busy" @click="download"><Download :size="17" />下载 config.age</button><button type="button" class="button secondary" :disabled="!ciphertext || busy" @click="copy"><Copy :size="17" />复制密文</button></div>
        </section>
      </div>
      <p v-if="error" class="age-error" role="alert">{{ error }}</p>
      <p v-if="message" class="age-success" role="status">{{ message }}</p>
    </form>
    <p class="age-footnote">明文仅用于本次加密，不保存到数据库或浏览器本地存储。修改输入后旧密文会清空，请重新加密。加密检查 YAML 格式，具体字段由 Agent 启动时校验。</p>
  </div>
</template>

<style scoped>
.age-editor-heading p, .age-footnote { color: #718198; font-size: 13px; line-height: 1.7; }
.age-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; }
.age-editor { padding: 22px; min-width: 0; }
.age-editor-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 68px; }
.age-editor-heading h2 { font-size: 16px; margin: 0; }
.age-editor-heading p { margin: 8px 0 14px; }
.age-field-label { display: block; font-size: 12px; color: #718198; margin: 0 0 8px; }
textarea { height: 520px; min-height: 260px; resize: vertical; font: 12px/1.8 Consolas, monospace; background: #f8faff; padding: 14px; tab-size: 2; }
.age-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
.age-error { color: #b42318; background: #fff0ed; padding: 14px; border-radius: 8px; }
.age-success { color: #14734d; background: #edf9f2; padding: 14px; border-radius: 8px; }
.age-footnote { margin-top: 18px; }
@media (max-width: 1100px) { .age-columns { grid-template-columns: 1fr; } textarea { height: 420px; } }
</style>
