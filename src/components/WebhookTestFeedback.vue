<script setup lang="ts">
import { CheckCheck, ShieldAlert } from 'lucide-vue-next'
import type { WebhookTestFeedback } from '../types'

defineProps<{ feedback: WebhookTestFeedback; stale?: boolean }>()
</script>

<template>
  <section class="webhook-test-result" :class="feedback.result?.success ? 'is-success' : 'is-error'" aria-live="polite">
    <div class="webhook-test-heading">
      <CheckCheck v-if="feedback.result?.success" :size="17" /><ShieldAlert v-else :size="17" />
      <strong>{{ feedback.result?.success ? '接口确认成功' : '测试未成功' }}</strong>
      <time :datetime="feedback.checked_at">{{ new Date(feedback.checked_at).toLocaleTimeString('zh-CN', { hour12: false }) }}</time>
    </div>
    <p>{{ feedback.result?.message || feedback.error }}</p>
    <p v-if="stale" class="webhook-test-warning">当前配置已修改，以下是上次测试结果，请重新测试。</p>
    <dl v-if="feedback.result" class="webhook-test-metrics">
      <div><dt>HTTP 状态</dt><dd>{{ feedback.result.http_status ?? '未收到响应' }}</dd></div>
      <div><dt>业务码</dt><dd>{{ feedback.result.business_code ?? '未返回' }}</dd></div>
      <div><dt>耗时</dt><dd>{{ feedback.result.duration_ms }} ms</dd></div>
    </dl>
    <details v-if="feedback.result" class="webhook-test-content" open>
      <summary>本次测试正文 · {{ feedback.name || '未命名通知' }}</summary>
      <pre>{{ feedback.result.text }}</pre>
    </details>
    <p v-else class="webhook-test-warning">主控未返回可核验的测试正文与投递详情。</p>
    <p v-if="feedback.refresh_error" class="webhook-test-warning">通知状态刷新失败：{{ feedback.refresh_error }}。以上测试结果已保留。</p>
  </section>
</template>
