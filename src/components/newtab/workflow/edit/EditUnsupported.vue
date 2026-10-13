<template>
  <div class="rounded-lg border border-red-400 p-4">
    <p class="font-semibold text-red-500">此离线版不支持该节点</p>
    <p class="mt-2">原始配置已保留。请删除或替换该节点后再执行工作流。</p>
    <pre class="mt-4 overflow-auto text-sm">{{
      JSON.stringify(data, null, 2)
    }}</pre>
  </div>
</template>

<script setup>
defineProps({
  data: {
    type: Object,
    default: () => ({}),
  },
});
</script>
