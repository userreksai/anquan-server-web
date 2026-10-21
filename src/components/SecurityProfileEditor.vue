<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CheckCheck, FileDown, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-vue-next'
import { api } from '../api'
import { defaultSecurityProfile, lines, mergeProfile, parseSysctl } from '../security-profile'

const props = defineProps<{ yaml: string; disabled: boolean }>()
const emit = defineEmits<{ yaml: [value: string]; dirty: [value: boolean]; busy: [value: boolean] }>()
const profile = ref(defaultSecurityProfile())
const dirty = ref(false)
const busy = ref(false)
const stale = ref(false)
const loaded = ref(false)
const error = ref('')
const message = ref('')
const sysctlText = ref('')
const grantsText = ref('[]')
const controller = new AbortController()
let readTimer: ReturnType<typeof setTimeout> | undefined
let requestId = 0
let synchronizedYaml = ''
const locked = computed(() => props.disabled || busy.value)
watch(dirty, value => emit('dirty', value), { flush: 'sync' })
watch(busy, value => emit('busy', value), { flush: 'sync' })
watch(() => props.yaml, value => {
  if (value === synchronizedYaml) { stale.value = false; return }
  stale.value = true
  message.value = ''
  if (!dirty.value) {
    clearTimeout(readTimer)
    readTimer = setTimeout(() => { void readYaml() }, 450)
  }
})
watch(() => props.disabled, value => { if (!value && !loaded.value && !busy.value) void readYaml() })
const watchPaths = computed({ get: () => profile.value.auditd.watch_paths.join('\n'), set: value => { profile.value.auditd.watch_paths = lines(value) } })
const fimPaths = computed({ get: () => profile.value.native_fim.paths.join('\n'), set: value => { profile.value.native_fim.paths = lines(value) } })
const auditRules = computed({ get: () => profile.value.auditd.rules.join('\n'), set: value => { profile.value.auditd.rules = lines(value) } })
const sshUsers = computed({ get: () => profile.value.policies.ssh.allow_users.join('\n'), set: value => { profile.value.policies.ssh.allow_users = lines(value) } })
const sshSources = computed({ get: () => profile.value.policies.ssh.allow_sources.join('\n'), set: value => { profile.value.policies.ssh.allow_sources = lines(value) } })

function changed() { dirty.value = true; message.value = ''; error.value = '' }
function applyPreset(kind: 'base' | 'observe' | 'disabled') {
  profile.value = defaultSecurityProfile()
  if (kind === 'observe') { profile.value.install_missing = false; profile.value.sudo.enabled = false }
  if (kind === 'disabled') profile.value.enabled = false
  sysctlText.value = ''
  grantsText.value = '[]'
  changed()
}
async function readYaml() {
  if (props.disabled || busy.value || controller.signal.aborted) return
  const source = props.yaml
  const id = ++requestId
  busy.value = true; error.value = ''; message.value = ''
  try {
    const result = await api<{ yaml: string; security: unknown }>('/settings/security-profile/compose', { method: 'POST', body: JSON.stringify({ yaml: source }), signal: controller.signal })
    if (controller.signal.aborted || id !== requestId || props.yaml !== source) return
    profile.value = mergeProfile(defaultSecurityProfile(), result.security)
    sysctlText.value = Object.entries(profile.value.policies.sysctl).map(([key, value]) => `${key} = ${value}`).join('\n')
    grantsText.value = JSON.stringify(profile.value.sudo.grants, null, 2)
    synchronizedYaml = source; loaded.value = true; stale.value = false; dirty.value = !result.security
    message.value = result.security ? '已读取当前 YAML 中的组件配置。' : '当前 YAML 尚无 security 配置，已载入基础预设；写入 YAML 后再下发。'
  } catch (cause) {
    if (!controller.signal.aborted) error.value = `读取组件配置失败：${cause instanceof Error ? cause.message : '请重试。'}`
  } finally { busy.value = false }
}
async function compose() {
  if (locked.value || stale.value || !loaded.value) return
  error.value = ''; message.value = ''
  try {
    profile.value.policies.sysctl = parseSysctl(sysctlText.value)
    let grants: unknown
    try { grants = JSON.parse(grantsText.value) } catch { throw new Error('sudo 命令授权必须是有效 JSON 数组。') }
    if (!Array.isArray(grants)) throw new Error('sudo 命令授权必须是 JSON 数组；不授权时填写 []。')
    profile.value.sudo.grants = grants
  }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '内核参数格式有误。'; return }
  const source = props.yaml
  busy.value = true
  try {
    const result = await api<{ yaml: string; security: unknown }>('/settings/security-profile/compose', { method: 'POST', body: JSON.stringify({ yaml: source, security: profile.value }), signal: controller.signal })
    if (controller.signal.aborted || props.yaml !== source) return
    if (typeof result?.yaml !== 'string' || !result.yaml.trim()) throw new Error('服务器未返回有效 YAML。')
    synchronizedYaml = result.yaml
    emit('yaml', result.yaml)
    dirty.value = false; stale.value = false
    message.value = '组件配置已合并到下方 YAML。请检查后使用“下发配置”选择机器；也可存储模板或加密部署。'
  } catch (cause) {
    if (!controller.signal.aborted) error.value = `生成配置失败：${cause instanceof Error ? cause.message : '请重试。'} 表单内容已保留。`
  } finally { busy.value = false }
}
onMounted(() => { void readYaml() })
onBeforeUnmount(() => { clearTimeout(readTimer); controller.abort(); requestId++; emit('busy', false); emit('dirty', false) })
</script>

<template>
  <section class="panel security-editor">
    <div class="security-heading"><div><span class="eyebrow">SECURITY COMPONENTS</span><h2><ShieldCheck :size="21" />组件与主机策略</h2><p>使用预设开始，按机器用途调整。Agent 启动或收到新配置后检查依赖、生成组件配置并执行校验、reload 或重启，结果通过现有链路上报。</p></div><button type="button" class="button secondary small" :disabled="locked" @click="readYaml"><RefreshCw :size="15" :class="{ spin: busy }" />{{ dirty ? '放弃表单并读取 YAML' : '读取当前 YAML' }}</button></div>
    <div class="security-presets"><strong>快速预设</strong><button type="button" class="button secondary small" :disabled="locked || !loaded" @click="applyPreset('base')">基础审计（推荐）</button><button type="button" class="button secondary small" :disabled="locked || !loaded" @click="applyPreset('observe')">仅接入已有组件</button><button type="button" class="button ghost small" :disabled="locked || !loaded" @click="applyPreset('disabled')">关闭安全扩展</button></div>
    <p v-if="stale" class="security-warning" role="status">下方 YAML 已改变。为保留其中的配置，请先点击“读取当前 YAML”，然后重新调整表单。</p>
    <fieldset :disabled="locked || stale || !loaded" @input="changed" @change="changed">
      <div class="security-overview"><label class="security-toggle"><input v-model="profile.enabled" type="checkbox" /><span>启用安全扩展<small>关闭后停止本模块采集，并撤回由 Agent 管理的配置及策略；已安装软件包保留。</small></span></label><label class="security-toggle"><input v-model="profile.install_missing" type="checkbox" /><span>自动安装缺少的组件<small>启用后由 Agent 使用系统包管理器安装所需依赖；需要 root 和软件源可用。</small></span></label></div>
      <div class="security-grid">
        <article class="security-card"><label class="security-toggle"><input v-model="profile.native_fim.enabled" type="checkbox" /><span>Agent 原生文件监控<small>监控内容、权限和属主，保存基线并结合实时通知与定期补扫。</small></span></label><label>监控路径（每行一项）<textarea v-model="fimPaths" rows="5" spellcheck="false" class="mono" /><small>填写目标机器绝对路径；避免与原有 FilesMonitoring 重复配置同一检测范围。</small></label><div class="security-fields"><label>补扫间隔 / 秒<input v-model.number="profile.native_fim.poll_interval_seconds" type="number" min="1" max="86400" /></label><label>内容留存最大字节数<input v-model.number="profile.native_fim.max_diff_bytes" type="number" min="256" max="16384" /></label></div><label class="security-toggle"><input v-model="profile.native_fim.capture_created_content" type="checkbox" /><span>记录新建文件内容<small>默认开启。记录监控启用后新建文本文件及其后续版本，删除后可查看留存内容；按字节上限截断，敏感路径和二进制文件不采正文。编辑器临时文件默认不通知。</small></span></label>
<label class="security-toggle"><input v-model="profile.native_fim.report_changes" type="checkbox" /><span>同时留存已有文件文本<small>默认关闭。开启后也记录监控前已存在的文本及其变化；账户口令和私钥等敏感文件仍不采正文。</small></span></label></article>
        <article class="security-card"><label class="security-toggle"><input v-model="profile.auditd.enabled" type="checkbox" /><span>Linux Audit / auditd<small>由系统审计记录文件修改人与进程身份；Agent 解析关联事件并上传。</small></span></label><label class="security-toggle"><input v-model="profile.auditd.audit_exec" type="checkbox" /><span>采集外部程序执行<small>Shell 内建命令与完整终端输入不属于外部程序执行事件。</small></span></label><label>审计路径（每行一项）<textarea v-model="watchPaths" rows="5" spellcheck="false" class="mono" /><small>为关键配置增加写入和属性审计；保留其他产品的规则。</small></label><details><summary>高级 Audit 规则</summary><label>附加规则（每行一条）<textarea v-model="auditRules" rows="4" spellcheck="false" class="mono" placeholder="-w /opt/app/config -p wa -k anquan_custom" /><small>无需填写 -D 等清空全局规则命令。Agent 会校验允许的规则范围。</small></label></details></article>
        <article class="security-card"><label class="security-toggle"><input v-model="profile.sudo.enabled" type="checkbox" /><span>sudo 审计<small>使用 sudo 自身的事件与输入输出录制机制；额外授权见高级配置。</small></span></label><label class="security-toggle"><input v-model="profile.sudo.io_logging" type="checkbox" /><span>启用 sudo 输入输出录制<small>终端记录可能包含敏感输入，请按需启用上传并配置保留策略。</small></span></label><label class="security-toggle"><input v-model="profile.sudo.upload_io" type="checkbox" /><span>上传 sudo 会话文件<small>默认关闭。开启后按会话大小上限分片上传；完整文件可从平台下载并使用 sudoreplay 回放。</small></span></label><label>单个会话上传上限 / 字节<input v-model.number="profile.sudo.max_session_bytes" type="number" min="1048576" max="209715200" /></label><details><summary>高级命令授权</summary><label>授权清单（JSON 数组）<textarea v-model="grantsText" rows="6" class="mono" spellcheck="false" placeholder='[{"user":"ops","run_as":"root","commands":["/usr/bin/systemctl status nginx"],"nopasswd":false}]' /><small>默认 [] 不新增授权。填写用户、目标身份和绝对命令路径即可，Agent 生成 sudoers；audit 模式只检查，enforce 模式才写入。此清单不会撤销其他配置中的既有 ALL 广泛授权。</small></label></details></article>
        <article class="security-card"><label class="security-toggle"><input v-model="profile.tetragon.enabled" type="checkbox" /><span>Tetragon（可选增强）<small>提供基于 eBPF 的进程执行、退出及扩展追踪。需要支持的 Linux 内核与 BTF；默认关闭。</small></span></label><p class="security-hint">可接入已安装的 Tetragon。已预设固定版本 v1.7.1，勾选即可自动获取官方发布包及校验值；自定义下载地址需另填 SHA-256。</p><details :open="profile.tetragon.enabled"><summary>版本、安装与高级配置</summary><div class="security-fields"><label>版本<input v-model="profile.tetragon.version" placeholder="默认 v1.7.1" /></label><label>SHA-256<input v-model="profile.tetragon.sha256" class="mono" placeholder="官方发布可留空；自定义包必填" /></label></div><label>受信任安装包 URL<input v-model="profile.tetragon.download_url" type="url" placeholder="https://…/tetragon-linux-amd64.tar.gz" /></label><label>Tetragon 配置<textarea v-model="profile.tetragon.config" rows="4" spellcheck="false" class="mono" placeholder="留空使用 Agent 默认模板" /></label><label>TracingPolicy<textarea v-model="profile.tetragon.tracing_policy" rows="4" spellcheck="false" class="mono" placeholder="可选；基础进程执行/退出无需自定义策略" /></label></details></article>
        <article class="security-card"><label class="security-toggle"><input v-model="profile.ssh_auth.enabled" type="checkbox" /><span>SSH 失败认证监控<small>采集失败登录并按来源 IP 统计窗口内次数；达到阈值产生告警，不自动封禁来源。</small></span></label><div class="security-fields"><label>告警阈值 / 次<input v-model.number="profile.ssh_auth.alert_threshold" type="number" min="1" max="1000" /></label><label>统计窗口 / 秒<input v-model.number="profile.ssh_auth.window_seconds" type="number" min="10" max="86400" /></label></div><details><summary>采集设置</summary><div class="security-fields"><label>采集间隔 / 秒<input v-model.number="profile.ssh_auth.poll_interval_seconds" type="number" min="1" max="300" /></label><label>首次回看 / 秒<input v-model.number="profile.ssh_auth.initial_lookback_seconds" type="number" min="1" max="86400" /></label></div></details></article>
      </div>
      <details class="policy-section"><summary>主机加固策略 <span class="count-tag">{{ profile.policies.mode === 'audit' ? '默认仅检查' : '应用配置' }}</span></summary><p class="security-hint">组件审计配置与主机加固策略分别控制。audit 检查目标状态并上报；enforce 才会尝试修改下列系统配置。SSH、网络和启动策略请先在测试机器验证。</p><label>策略模式<select v-model="profile.policies.mode"><option value="audit">仅检查（audit）</option><option value="enforce">应用配置（enforce）</option></select></label><p v-if="profile.policies.mode === 'enforce'" class="security-warning">下发后允许 Agent 修改已启用的系统策略。请先确认 SSH 账户、密钥和来源地址，避免失去远程连接。</p><div class="security-grid"><article class="security-card"><label class="security-toggle"><input v-model="profile.policies.ssh.enabled" type="checkbox" /><span>SSH 策略<small>使用 Agent 管理的配置片段并验证；不覆盖整个 sshd_config。</small></span></label><div class="security-fields"><label>密码登录<select v-model="profile.policies.ssh.password_authentication"><option value="no">关闭</option><option value="yes">允许</option></select></label><label>root 登录<select v-model="profile.policies.ssh.permit_root_login"><option value="prohibit-password">仅密钥</option><option value="no">禁止</option><option value="yes">允许</option></select></label></div><label>允许用户（每行一个）<textarea v-model="sshUsers" rows="3" spellcheck="false" placeholder="留空不设置 AllowUsers" /></label><label>允许来源 IP / CIDR（每行一个）<textarea v-model="sshSources" rows="3" spellcheck="false" placeholder="留空不设置来源白名单" /><small>按目标主机的网络后端能力应用；不再依赖 hosts.allow / hosts.deny。</small></label></article><article class="security-card"><label>内核参数（每行 key = value）<textarea v-model="sysctlText" rows="5" spellcheck="false" class="mono" placeholder="kernel.kptr_restrict = 2&#10;kernel.dmesg_restrict = 1" /><small>默认不改。反向路径过滤、转发等参数需根据多网卡、VPN、容器网络角色决定。</small></label><label>交互 Shell 空闲超时 / 秒<input v-model.number="profile.policies.session_timeout_seconds" type="number" min="0" max="86400" /><small>0 表示不管理此项；此项不等于终止所有空闲程序。</small></label><label class="security-toggle"><input v-model="profile.policies.disable_ctrl_alt_del" type="checkbox" /><span>禁用 Ctrl+Alt+Del 重启</span></label></article></div><details class="grub-section"><summary>启动保护（高级）</summary><label class="security-toggle"><input v-model="profile.policies.grub.enabled" type="checkbox" /><span>管理 GRUB 密码保护<small>需要支持的 GRUB 环境；请在有控制台恢复渠道的机器验证。</small></span></label><label>GRUB PBKDF2 哈希<input v-model="profile.policies.grub.password_hash" class="mono" autocomplete="off" placeholder="grub.pbkdf2.sha512.…" /><small>使用 grub-mkpasswd-pbkdf2 生成。只填写哈希，不填写明文密码。</small></label></details></details>
      <details class="policy-section"><summary>采集与队列设置</summary><div class="security-fields"><label>组件日志采集间隔 / 秒<input v-model.number="profile.poll_interval_seconds" type="number" min="1" max="300" /></label><label>状态上报间隔 / 秒<input v-model.number="profile.status_interval_seconds" type="number" min="10" max="86400" /></label><label>本地事件队列上限<input v-model.number="profile.max_queue_events" type="number" min="100" max="100000" /></label></div><p class="security-hint">沿用现有 Agent → Master 通信与确认补传链路，不新增监听端口。队列与丢失状态通过组件状态上报。</p></details>
    </fieldset>
    <p v-if="error" class="security-error" role="alert">{{ error }}</p><p v-if="message" class="security-success" role="status"><CheckCheck :size="16" />{{ message }}</p>
    <div class="security-actions"><button type="button" class="button primary" :disabled="locked || stale || !loaded" @click="compose"><LoaderCircle v-if="busy" :size="17" class="spin" /><FileDown v-else :size="17" />写入下方 YAML</button><span>{{ dirty ? '表单有未写入的修改；写入后才能加密、存储或下发。' : '写入 YAML 不会立即修改机器；请继续选择目标机器下发。' }}</span></div>
  </section>
</template>

<style scoped>
.security-editor { padding: 24px; margin-bottom: 24px; }
.security-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.security-heading h2 { display: flex; gap: 9px; align-items: center; font-size: 19px; margin: 8px 0; }
.security-heading p, .security-hint { color: #718198; font-size: 12px; line-height: 1.8; }
.security-heading > div { max-width: 850px; }
.security-heading button { flex-shrink: 0; }
.security-presets { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 20px 0; font-size: 12px; }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.security-overview { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; padding: 18px; border-radius: 9px; background: #f4f7fd; margin-bottom: 20px; }
.security-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; }
.security-card { border: 1px solid var(--line); border-radius: 9px; padding: 18px; display: flex; flex-direction: column; gap: 17px; min-width: 0; }
.security-toggle { display: flex; flex-direction: row; align-items: flex-start; gap: 10px; }
.security-toggle input { width: 16px; height: 16px; margin-top: 1px; flex-shrink: 0; accent-color: var(--blue); }
.security-toggle span { line-height: 1.5; }
.security-toggle small { display: block; margin-top: 5px; }
.security-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 13px; }
textarea { font-size: 12px; }
summary { cursor: pointer; font-weight: 600; font-size: 13px; line-height: 1.8; }
details > label, details > .security-fields, details > .security-hint, details > .security-grid, details > .security-warning { margin-top: 16px; }
.policy-section { padding: 18px; border: 1px solid var(--line); border-radius: 9px; margin-top: 18px; }
.policy-section > label { max-width: 420px; }
.grub-section { margin-top: 20px; }
.security-warning, .security-error, .security-success { padding: 12px 14px; border-radius: 8px; margin: 14px 0; font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.security-warning { background: #fff7e5; color: #93621b; }
.security-error { background: #fff0ed; color: #b42318; }
.security-success { display: flex; align-items: flex-start; gap: 8px; background: #edf9f2; color: #14734d; }
.security-success svg { margin-top: 3px; }
.security-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin-top: 20px; }
.security-actions span { font-size: 12px; color: #718198; line-height: 1.7; }
@media(max-width: 850px) { .security-grid, .security-overview { grid-template-columns: 1fr; } .security-heading { flex-direction: column; } .security-editor { padding: 18px; } }
</style>
