<script setup lang="ts">
import { computed } from 'vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
const props = defineProps<{ page: number; pageSize: number; total: number; disabled?: boolean }>()
const emit = defineEmits<{ change: [page: number]; resize: [size: number] }>()
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
</script>

<template>
  <div class="pagination">
    <span class="muted">共 <strong>{{ total.toLocaleString() }}</strong> 条记录</span>
    <div class="pagination-controls">
      <select :value="pageSize" aria-label="每页记录数" :disabled="disabled" @change="emit('resize', Number(($event.target as HTMLSelectElement).value))">
        <option :value="10">10 条 / 页</option><option :value="25">25 条 / 页</option><option :value="50">50 条 / 页</option><option :value="100">100 条 / 页</option>
      </select>
      <button class="icon-button" aria-label="上一页" :disabled="page <= 1 || disabled" @click="emit('change', page - 1)"><ChevronLeft :size="17" /></button>
      <span class="page-indicator">{{ page }} <span class="muted">/ {{ pages }}</span></span>
      <button class="icon-button" aria-label="下一页" :disabled="page >= pages || disabled" @click="emit('change', page + 1)"><ChevronRight :size="17" /></button>
    </div>
  </div>
</template>
