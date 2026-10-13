<template>
  <div>
    <ui-textarea
      :model-value="data.description"
      :placeholder="t('common.description')"
      class="w-full"
      @change="updateData({ description: $event })"
    />
    <ui-button
      class="mt-4 mb-2 w-full"
      variant="accent"
      @click="showModal = !showModal"
    >
      {{ t('workflow.blocks.insert-data.name') }} ({{ dataList.length }})
    </ui-button>
    <ui-modal
      v-model="showModal"
      :title="t('workflow.blocks.insert-data.name')"
      padding="p-0"
      content-class="max-w-3xl insert-data-modal"
    >
      <ul
        class="data-list scroll mt-4 overflow-auto px-4 pb-4"
        style="max-height: calc(100vh - 13rem)"
      >
        <li
          v-for="(item, index) in dataList"
          :key="index"
          class="mb-4 rounded-lg border"
        >
          <div class="flex items-center border-b p-2">
            <ui-select
              :model-value="item.type"
              class="mr-2 shrink-0"
              @change="changeItemType(index, $event)"
            >
              <option value="table">
                {{ t('workflow.table.title') }}
              </option>
              <option value="variable">
                {{ t('workflow.variables.title') }}
              </option>
            </ui-select>
            <ui-input
              v-if="item.type === 'variable'"
              v-model="item.name"
              :placeholder="t('workflow.variables.name')"
              :title="t('workflow.variables.name')"
              class="flex-1"
            />
            <ui-select
              v-else
              v-model="item.name"
              :placeholder="t('workflow.table.select')"
            >
              <option
                v-for="column in workflow.columns.value"
                :key="column.id"
                :value="column.id"
              >
                {{ column.name }}
              </option>
            </ui-select>
            <div class="grow" />
            <v-remixicon
              name="riDeleteBin7Line"
              class="cursor-pointer"
              @click="removeItem(index)"
            />
          </div>
          <div class="p-2">
            <div v-if="item.isFile" class="flex items-end">
              <edit-autocomplete class="w-full">
                <ui-input
                  v-model="item.filePath"
                  class="w-full"
                  :placeholder="t('workflow.blocks.insert-data.filePath')"
                />
              </edit-autocomplete>
              <div class="ml-2 shrink-0">
                <label class="mb-1 block text-sm">文件类型</label>
                <ui-select
                  :model-value="item.fileType || 'auto'"
                  aria-label="文件类型"
                  @change="item.fileType = $event"
                >
                  <option value="auto">自动</option>
                  <option value="excel">Excel</option>
                  <option value="csv">CSV</option>
                </ui-select>
              </div>
              <template
                v-if="
                  isExcelFile(item.filePath, item) &&
                  ['json', 'json-header'].includes(
                    item.action || item.csvAction || ''
                  )
                "
              >
                <ui-input
                  v-model="item.xlsSheet"
                  :label="t('workflow.blocks.insert-data.sheet')"
                  class="ml-2"
                  placeholder="Sheet1"
                />
                <ui-input
                  v-model="item.xlsRange"
                  :label="t('workflow.blocks.insert-data.range')"
                  class="ml-2"
                  placeholder="A1:C10"
                />
              </template>
            </div>
            <edit-autocomplete v-else class="w-full">
              <ui-textarea
                v-model="item.value"
                :placeholder="t('common.value')"
                :title="t('common.value')"
                class="w-full"
              />
            </edit-autocomplete>
            <div class="mt-2 flex items-center">
              <ui-button
                v-tooltip="t('workflow.blocks.insert-data.importFile')"
                :class="{ 'text-primary': item.isFile }"
                icon
                @click="item.isFile = !item.isFile"
              >
                <v-remixicon name="riFileLine" />
              </ui-button>
              <template v-if="item.isFile">
                <ui-button class="ml-2" @click="previewData(index, item)">
                  {{ t('workflow.blocks.insert-data.preview') }}
                </ui-button>
                <ui-button
                  v-if="previewState.itemId === index"
                  v-tooltip="t('workflow.blocks.insert-data.clearPreview')"
                  class="ml-2"
                  icon
                  @click="clearPreview"
                >
                  <v-remixicon name="riBrush2Line" />
                </ui-button>
                <div class="grow" />
                <ui-select
                  :model-value="item.action || item.csvAction"
                  :placeholder="t('common.action')"
                  @change="item.action = $event"
                >
                  <option value="default">
                    {{ t('workflow.blocks.insert-data.default') }}
                  </option>
                  <option value="base64">
                    {{ t('workflow.blocks.insert-data.base64') }}
                  </option>
                  <optgroup
                    v-if="isCsvOrExcelFile(item.filePath, item)"
                    :label="t('workflow.blocks.insert-data.csvExcel')"
                  >
                    <option value="json">
                      {{ t('workflow.blocks.insert-data.json') }}
                    </option>
                    <option value="json-header">
                      {{ t('workflow.blocks.insert-data.jsonHeader') }}
                    </option>
                  </optgroup>
                </ui-select>
              </template>
            </div>
            <p
              v-if="previewState.itemId === index && previewState.loading"
              class="mt-2 text-sm text-gray-500"
            >
              正在读取与解析文件…
            </p>
            <p
              v-if="previewState.itemId === index && previewState.warning"
              class="mt-2 text-sm text-orange-600 dark:text-orange-400"
            >
              {{ previewState.warning }}
            </p>
            <shared-codemirror
              v-if="previewState.itemId === index"
              :model-value="previewState.data"
              readonly
              hide-lang
              class="mt-4 w-full"
              lang="json"
              style="max-height: 500px"
            />
          </div>
        </li>
        <ui-button class="mt-4 w-24" variant="accent" @click="addItem">
          {{ t('common.add') }}
        </ui-button>
      </ul>
      <p v-if="!hasFileAccess" class="px-4 pb-4 text-sm text-gray-500">
        {{ t('workflow.blocks.insert-data.noFileAccess') }}
      </p>
    </ui-modal>
  </div>
</template>
<script setup>
import {
  ref,
  watch,
  inject,
  shallowReactive,
  defineAsyncComponent,
  onUnmounted,
} from 'vue';
import { useI18n } from 'vue-i18n';
import { useToast } from 'vue-toastification';
import browser from 'webextension-polyfill';
import {
  normalizeInsertItem,
  readInsertFile,
  parseInsertData,
  isExcelFile,
  isCsvOrExcelFile,
  previewLimits,
} from '@/utils/insertData';
import EditAutocomplete from './EditAutocomplete.vue';

const SharedCodemirror = defineAsyncComponent(() =>
  import('@/components/newtab/shared/SharedCodemirror.vue')
);

const props = defineProps({
  data: {
    type: Object,
    default: () => ({}),
  },
});
const emit = defineEmits(['update:data']);

const { t } = useI18n();
const toast = useToast();

const workflow = inject('workflow', {});

const showModal = ref(false);
const hasFileAccess = ref(false);
const dataList = ref(JSON.parse(JSON.stringify(props.data.dataList)));

const previewState = shallowReactive({
  data: '',
  itemId: '',
  warning: '',
  loading: false,
});
const previewSequence = ref(0);
const previewAbort = ref(null);

function clearPreview() {
  // 递增序号并中止在途读取：旧结果不再回填
  previewSequence.value += 1;
  if (previewAbort.value) {
    previewAbort.value.abort();
    previewAbort.value = null;
  }
  previewState.itemId = '';
  previewState.data = '';
  previewState.warning = '';
  previewState.loading = false;
}
function updateData(value) {
  emit('update:data', { ...props.data, ...value });
}
function addItem() {
  dataList.value.push({
    type: 'table',
    name: '',
    value: '',
    filePath: '',
    fileType: 'auto',
    isFile: false,
    action: 'default',
  });
}
function changeItemType(index, type) {
  dataList.value[index] = {
    ...dataList.value[index],
    type,
    name: '',
  };
}
async function previewData(index, item) {
  // 含模板变量的路径只能在运行时解析，预览无意义
  if (/\{\{[\s\S]*?\}\}/.test(item.filePath || '')) {
    toast.error('变量路径需在工作流运行时解析，请运行后查看结果');
    return;
  }

  const sequence = previewSequence.value + 1;
  previewSequence.value = sequence;
  if (previewAbort.value) previewAbort.value.abort();

  const controller = new AbortController();
  previewAbort.value = controller;

  const itemSnapshot = JSON.stringify(item);
  previewState.itemId = index;
  previewState.loading = true;
  previewState.data = '';
  previewState.warning = '';

  try {
    const path = item.filePath || '';
    if (!/^https?:\/\//i.test(path) && !hasFileAccess.value) {
      throw new Error(t('workflow.blocks.insert-data.noFileAccess'));
    }

    const { item: normalizedItem, warnings: normalizeWarnings } =
      normalizeInsertItem(item);
    const readResult = await readInsertFile(path, normalizedItem, {
      signal: controller.signal,
    });
    const {
      value,
      metadata,
      warnings: parseWarnings,
    } = await parseInsertData(readResult, normalizedItem, {
      purpose: 'preview',
      signal: controller.signal,
    });

    // 序号变化或配置已修改：丢弃过期结果
    const currentItem = dataList.value[index];
    if (
      sequence !== previewSequence.value ||
      !currentItem ||
      JSON.stringify(currentItem) !== itemSnapshot
    ) {
      return;
    }

    const messages = [...normalizeWarnings, ...parseWarnings].map(
      (warning) => warning.message
    );
    if (metadata.sheet) {
      messages.unshift(`实际工作表：${metadata.sheet}`);
    }
    if (metadata.truncated?.rows) {
      messages.push(
        `仅展示前 ${metadata.previewRows} 行（如有），完整数据以执行结果为准`
      );
    }
    if (metadata.truncated?.columns) {
      messages.push(`列数超过 ${previewLimits.columns}，已截断展示`);
    }

    let text =
      typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (text.length > previewLimits.chars) {
      text = text.slice(0, previewLimits.chars);
      messages.push('内容超长，已截断展示');
    }

    previewState.data = text;
    previewState.warning = messages.join('；');
  } catch (error) {
    if (sequence !== previewSequence.value) return;

    console.error(error);
    toast.error(error.message);
  } finally {
    if (sequence === previewSequence.value) {
      previewState.loading = false;
    }
  }
}

browser.extension
  .isAllowedFileSchemeAccess()
  .then((value) => {
    hasFileAccess.value = value;
  })
  .catch((error) => {
    toast.error(error.message);
  });

onUnmounted(clearPreview);

watch(showModal, (value) => {
  if (!value) clearPreview();
});

watch(
  dataList,
  (value) => {
    if (previewState.itemId !== '') clearPreview();
    updateData({ dataList: value });
  },
  { deep: true }
);
</script>
<style>
.insert-data-modal .modal-ui__content-header {
  @apply p-4;
}
</style>
