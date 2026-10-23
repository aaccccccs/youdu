<!--
  添加/编辑订阅对话框组件

  功能：
  - 订阅名称（文本输入）
  - 订阅类型（NRadioGroup：文件夹/RSS/HTTP源）
  - URL/路径（文本输入，文件夹类型有"浏览"按钮）
  - 检查间隔（NSelect：每小时/每6小时/每天/每周）
  - 自动导入（NSwitch）
  - 文件夹类型：用 window.appApi.selectDirectory 选择文件夹
  - 提交时调用 store.addSubscription 或 store.updateSubscription

  支持两种模式：
  - 添加模式（editSubscription 为 null）
  - 编辑模式（editSubscription 传入已有订阅）
-->
<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  NModal,
  NForm,
  NFormItem,
  NInput,
  NRadioGroup,
  NRadio,
  NSelect,
  NSwitch,
  NButton,
  NIcon,
  NSpace,
  NText,
  useMessage
} from 'naive-ui';
import { Folder, Rss, Globe, FolderOpen, Plus, Check } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import type { SelectOption } from 'naive-ui';
import type { Subscription, SubscriptionType } from '@renderer/types';
import { CHECK_INTERVAL_VALUES, CHECK_INTERVALS } from '@renderer/stores';

const { t } = useI18n();

/** 组件属性 */
const props = defineProps<{
  /** 是否显示 */
  show: boolean;
  /** 编辑模式时传入的订阅（null=添加模式） */
  editSubscription?: Subscription | null;
}>();

/** 组件事件 */
const emit = defineEmits<{
  /** 关闭对话框 */
  'update:show': [value: boolean];
  /** 提交成功 */
  submitted: [];
}>();

const message = useMessage();

/* ==================== 表单状态 ==================== */

/** 订阅名称 */
const formName = ref<string>('');
/** 订阅类型（'auto' 仅为前端 UI 虚拟类型，不会存入数据库） */
const formType = ref<SubscriptionType | 'auto'>('auto');
/** URL/路径 */
const formUrl = ref<string>('');
/** 检查间隔 */
const formCheckInterval = ref<number>(CHECK_INTERVALS.HOUR);
/** 自动导入 */
const formAutoImport = ref<boolean>(true);
/** 提交中 */
const submitting = ref<boolean>(false);

/** 是否为编辑模式 */
const isEditMode = computed((): boolean => !!props.editSubscription);

/** 对话框标题 */
const dialogTitle = computed((): string =>
  isEditMode.value ? t('subscription.editTitle') : t('subscription.addTitle')
);

/* ==================== 选项数据 ==================== */

/** 检查间隔选项（value 为毫秒值，label 随语言切换） */
const intervalLabelKeys = {
  [CHECK_INTERVALS.HOUR]: 'subscription.intervalHour',
  [CHECK_INTERVALS.SIX_HOURS]: 'subscription.interval6Hours',
  [CHECK_INTERVALS.DAY]: 'subscription.intervalDay',
  [CHECK_INTERVALS.WEEK]: 'subscription.intervalWeek'
} as const;

const checkIntervalOptions = computed((): SelectOption[] =>
  CHECK_INTERVAL_VALUES.map((value) => ({
    label: t(intervalLabelKeys[value]),
    value
  }))
);

/** 类型选项配置（'auto' 为前端 UI 虚拟类型，仅用于添加模式） */
const typeOptions = computed((): Array<{ value: SubscriptionType | 'auto'; label: string; icon: typeof Folder }> => [
  { value: 'auto', label: t('subscription.typeAuto'), icon: Globe },
  { value: 'folder', label: t('subscription.typeFolder'), icon: Folder },
  { value: 'rss', label: 'RSS', icon: Rss }
]);

/* ==================== RSS 预置推荐源 ==================== */

/** RSS 预置源条目 */
interface RssPreset {
  category: string;
  name: string;
  url: string;
}

/** RSS 预置源列表（按分类组织，文案随语言切换） */
const rssPresets = computed((): RssPreset[] => [
  // 技术博客
  {
    category: t('subscription.presets.categories.techBlogs'),
    name: t('subscription.presets.names.ruanyifeng'),
    url: 'https://www.ruanyifeng.com/blog/atom.xml'
  },
  {
    category: t('subscription.presets.categories.techBlogs'),
    name: t('subscription.presets.names.coolshell'),
    url: 'https://coolshell.cn/rss.xml'
  },
  {
    category: t('subscription.presets.categories.techBlogs'),
    name: t('subscription.presets.names.qianxin'),
    url: 'https://forum.butian.net/Rss'
  },
  {
    category: t('subscription.presets.categories.techBlogs'),
    name: t('subscription.presets.names.hackerNews'),
    url: 'https://hnrss.org/frontpage'
  },
  {
    category: t('subscription.presets.categories.techBlogs'),
    name: t('subscription.presets.names.techCrunch'),
    url: 'https://techcrunch.com/feed/'
  },

  // 新闻资讯
  {
    category: t('subscription.presets.categories.news'),
    name: t('subscription.presets.names.bbcChinese'),
    url: 'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml'
  },
  {
    category: t('subscription.presets.categories.news'),
    name: t('subscription.presets.names.reutersWorld'),
    url: 'https://feeds.reuters.com/Reuters/worldNews'
  },
  {
    category: t('subscription.presets.categories.news'),
    name: t('subscription.presets.names.zhihuDaily'),
    url: 'https://www.zhihu.com/rss'
  },

  // 文学阅读
  {
    category: t('subscription.presets.categories.literature'),
    name: t('subscription.presets.names.doubanReviews'),
    url: 'https://www.douban.com/feed/review/book'
  },
  {
    category: t('subscription.presets.categories.literature'),
    name: t('subscription.presets.names.singleReading'),
    url: 'https://single.reading.cn/rss.xml'
  },

  // 科学科普
  {
    category: t('subscription.presets.categories.science'),
    name: t('subscription.presets.names.guokr'),
    url: 'https://www.guokr.com/rss.xml'
  },
  {
    category: t('subscription.presets.categories.science'),
    name: t('subscription.presets.names.solidot'),
    url: 'https://www.solidot.org/index.rss'
  },
  {
    category: t('subscription.presets.categories.science'),
    name: t('subscription.presets.names.quanta'),
    url: 'https://api.quantamagazine.org/feed/'
  }
]);

/** 按分类分组的 RSS 预置源（保持插入顺序） */
const rssPresetGroups = computed((): Array<{ category: string; items: RssPreset[] }> => {
  const groups = new Map<string, RssPreset[]>();
  for (const preset of rssPresets.value) {
    let group = groups.get(preset.category);
    if (!group) {
      group = [];
      groups.set(preset.category, group);
    }
    group.push(preset);
  }
  return Array.from(groups.entries()).map(([category, items]) => ({ category, items }));
});

/* ==================== URL 输入框占位符 ==================== */

/** URL 输入框占位符（根据类型变化） */
const urlPlaceholder = computed((): string => {
  switch (formType.value) {
    case 'auto':
      return t('subscription.urlPlaceholderAuto');
    case 'folder':
      return t('subscription.urlPlaceholderFolder');
    case 'rss':
      return t('subscription.urlPlaceholderRss');

    default:
      return '';
  }
});

/* ==================== 表单校验 ==================== */

/** 是否可提交（名称可留空，RSS 类型会自动从 feed 获取标题） */
const canSubmit = computed((): boolean => {
  return formUrl.value.trim().length > 0 && !submitting.value;
});

/** 从 URL/路径推导默认名称（非 RSS 类型留空时使用） */
function deriveDefaultName(url: string, type: SubscriptionType): string {
  if (type === 'folder') {
    // 取文件夹最后一段作为名称
    const parts = url.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] ?? t('subscription.defaultFolderName');
  }
  // RSS/HTTP：取域名
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return t('subscription.defaultName');
  }
}

/* ==================== 文件夹选择 ==================== */

/** 浏览选择文件夹 */
async function handleBrowseFolder(): Promise<void> {
  try {
    const dirPath = await window.appApi.selectDirectory();
    if (dirPath) {
      formUrl.value = dirPath;
    }
  } catch (err) {
    message.error(t('subscription.selectFolderFailed', { message: (err as Error).message }));
  }
}

/** 选择 RSS 预置源：自动填入名称和 URL */
function handleSelectRssPreset(preset: { name: string; url: string }): void {
  formName.value = preset.name;
  formUrl.value = preset.url;
}

/* ==================== 表单重置/填充 ==================== */

/** 重置表单为默认值 */
function resetForm(): void {
  formName.value = '';
  formType.value = 'auto';
  formUrl.value = '';
  formCheckInterval.value = CHECK_INTERVALS.HOUR;
  formAutoImport.value = true;
}

/** 用已有订阅填充表单（编辑模式） */
function fillForm(sub: Subscription): void {
  formName.value = sub.name;
  formType.value = sub.type;
  formUrl.value = sub.url;
  formCheckInterval.value = sub.check_interval;
  formAutoImport.value = sub.auto_import === 1;
}

/* ==================== 监听显示状态变化 ==================== */

watch(
  () => props.show,
  (show) => {
    if (show) {
      // 打开时：编辑模式填充表单，添加模式重置
      if (props.editSubscription) {
        fillForm(props.editSubscription);
      } else {
        resetForm();
      }
    }
  }
);

/* ==================== 提交 ==================== */

/** 提交表单 */
async function handleSubmit(): Promise<void> {
  if (!canSubmit.value) return;

  submitting.value = true;
  try {
    // URL 前缀补全：auto/rss 类型自动补 https://（保留用户显式输入的 http://）
    let url = formUrl.value.trim();
    if (formType.value === 'auto' || formType.value === 'rss') {
      if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
      }
    }

    const input = {
      name:
        formName.value.trim() ||
        (formType.value === 'rss' || formType.value === 'auto'
          ? ''
          : deriveDefaultName(formUrl.value.trim(), formType.value)),
      type: formType.value,
      url: url,
      checkInterval: formCheckInterval.value,
      autoImport: formAutoImport.value ? 1 : 0
    };

    if (isEditMode.value && props.editSubscription) {
      // 编辑模式：更新（编辑模式 formType 不会是 'auto'）
      await window.subscriptionApi.update(props.editSubscription.id, {
        name: input.name,
        url: input.url,
        check_interval: input.checkInterval,
        auto_import: input.autoImport
      });
      message.success(t('subscription.updated'));
    } else if (formType.value === 'auto') {
      // 自动识别模式：调用 addSmart，根据返回 kind 决定后续处理
      const result = await window.subscriptionApi.addSmart(url, input.name);
      if (result.kind === 'opds') {
        // 检测到 OPDS 书库：调用 OPDS 添加目录 API
        const catalogName =
          input.name ||
          (() => {
            try {
              return new URL(url).hostname.replace(/^www\./, '');
            } catch {
              return t('subscription.opdsCatalog');
            }
          })();
        await window.opdsApi.addCatalog({ name: catalogName, url: url });
        message.success(t('subscription.opdsAdded', { name: catalogName }));
        // P2 修复：通知 OpdsBrowser 刷新目录列表，避免用户手动刷新
        // OpdsBrowser 监听此事件并重新调用 loadCatalogs
        window.dispatchEvent(new CustomEvent('opds:catalogs-changed'));
      } else {
        // RSS/HTTP 内容订阅
        const contentLabel =
          result.contentType === 'comic'
            ? t('common.bookType.comic')
            : result.contentType === 'novel'
              ? t('subscription.contentNovel')
              : result.contentType === 'book'
                ? t('subscription.contentBook')
                : '';
        const suffix = contentLabel ? t('subscription.contentSuffix', { type: contentLabel }) : '';
        message.success(t('subscription.contentAdded', { name: result.subscriptionName ?? input.name, suffix }));
      }
    } else if (formType.value === 'rss' || formType.value === 'http') {
      // RSS/HTTP 类型：智能添加（自动检测格式，XML/HTML→内容订阅）
      const result = await window.subscriptionApi.addSmart(url, input.name);
      // → 内容订阅
      const contentLabel =
        result.contentType === 'comic'
          ? t('common.bookType.comic')
          : result.contentType === 'novel'
            ? t('subscription.contentNovel')
            : result.contentType === 'book'
              ? t('subscription.contentBook')
              : '';
      const suffix = contentLabel ? t('subscription.contentSuffix', { type: contentLabel }) : '';
      message.success(t('subscription.contentAdded', { name: result.subscriptionName ?? input.name, suffix }));
    } else {
      // folder 类型：普通添加（此处 formType 一定是 'folder'）
      await window.subscriptionApi.add({
        name: input.name,
        type: 'folder',
        url: input.url,
        check_interval: input.checkInterval,
        auto_import: input.autoImport,
        enabled: 1
      });
      message.success(t('subscription.added'));
    }

    emit('submitted');
    emit('update:show', false);
  } catch (err) {
    message.error(t('subscription.actionFailed', { message: (err as Error).message }));
  } finally {
    submitting.value = false;
  }
}

/** 取消 */
function handleCancel(): void {
  emit('update:show', false);
}
</script>

<template>
  <n-modal
    :show="props.show"
    @update:show="(v: boolean) => emit('update:show', v)"
    :mask-closable="!submitting"
    :close-on-esc="!submitting"
    preset="card"
    :title="dialogTitle"
    class="subscription-modal"
    :bordered="false"
  >
    <n-form label-placement="top" class="subscription-form">
      <!-- 订阅名称 -->
      <n-form-item :label="t('subscription.nameLabel')">
        <n-input
          v-model:value="formName"
          :placeholder="
            formType === 'folder' ? t('subscription.namePlaceholderFolder') : t('subscription.namePlaceholderAuto')
          "
          :disabled="submitting"
        />
      </n-form-item>

      <!-- 订阅类型（仅添加模式可编辑，编辑模式不可改类型） -->
      <n-form-item :label="t('subscription.typeLabel')">
        <n-radio-group v-model:value="formType" :disabled="submitting || isEditMode">
          <n-space>
            <n-radio v-for="opt in typeOptions" :key="opt.value" :value="opt.value">
              <n-icon :component="opt.icon" :size="14" style="margin-right: 4px" />
              {{ opt.label }}
            </n-radio>
          </n-space>
        </n-radio-group>
      </n-form-item>

      <!-- URL/路径 -->
      <n-form-item :label="t('subscription.urlLabel')">
        <n-input v-model:value="formUrl" :placeholder="urlPlaceholder" :disabled="submitting">
          <template v-if="formType === 'folder'" #suffix>
            <n-button
              size="tiny"
              quaternary
              :title="t('subscription.browseTitle')"
              :disabled="submitting"
              @click="handleBrowseFolder"
            >
              <template #icon>
                <n-icon :component="FolderOpen" :size="16" />
              </template>
              {{ t('subscription.browse') }}
            </n-button>
          </template>
        </n-input>
      </n-form-item>

      <!-- RSS 预置推荐源（仅添加模式 + RSS 类型时显示） -->
      <div v-if="formType === 'rss' && !isEditMode" class="rss-presets">
        <p class="rss-presets-title">{{ t('subscription.presetsTitle') }}</p>
        <div v-for="group in rssPresetGroups" :key="group.category" class="rss-preset-group">
          <span class="rss-preset-category">{{ group.category }}</span>
          <div class="rss-preset-tags">
            <button
              v-for="preset in group.items"
              :key="preset.url"
              type="button"
              class="rss-preset-tag"
              :class="{ active: formUrl === preset.url }"
              :disabled="submitting"
              @click="handleSelectRssPreset(preset)"
            >
              {{ preset.name }}
            </button>
          </div>
        </div>
      </div>

      <!-- 检查间隔（自动识别模式隐藏，该模式仅做一次性识别） -->
      <n-form-item :label="t('subscription.intervalLabel')" v-if="formType !== 'auto'">
        <n-select v-model:value="formCheckInterval" :options="checkIntervalOptions" :disabled="submitting" />
      </n-form-item>

      <!-- 自动导入（自动识别模式隐藏） -->
      <n-form-item :label="t('subscription.autoImportLabel')" v-if="formType !== 'auto'">
        <n-space align="center">
          <n-switch v-model:value="formAutoImport" :disabled="submitting" />
          <n-text depth="3" style="font-size: var(--font-size-sm)">
            {{ t('subscription.autoImportHint') }}
          </n-text>
        </n-space>
      </n-form-item>
    </n-form>

    <!-- 底部按钮 -->
    <template #footer>
      <n-space justify="end">
        <n-button @click="handleCancel" :disabled="submitting">{{ t('common.actions.cancel') }}</n-button>
        <n-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="handleSubmit">
          <template #icon>
            <n-icon :component="isEditMode ? Check : Plus" :size="16" />
          </template>
          {{ isEditMode ? t('common.actions.save') : t('common.actions.add') }}
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style>
/* NModal preset="card" 时，class 传递给 NCard，teleport 到 body 后需全局样式 */
.subscription-modal {
  width: 480px;
  max-width: 90vw;
}

.subscription-modal .n-card__content {
  max-height: 70vh;
  overflow-y: auto;
  padding: var(--spacing-md) var(--spacing-lg);
}

.subscription-modal .n-card-header {
  padding: var(--spacing-sm-md) var(--spacing-lg);
}
</style>

<style scoped>
.subscription-form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

/* RSS 预置推荐源 */
.rss-presets {
  margin-top: var(--spacing-xs);
}

.rss-presets-title {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-secondary);
  margin: 0 0 var(--spacing-xs);
}

.rss-preset-group {
  margin-bottom: var(--spacing-sm);
}

.rss-preset-group:last-child {
  margin-bottom: 0;
}

.rss-preset-category {
  display: inline-block;
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  margin-bottom: var(--spacing-xs);
}

.rss-preset-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
}

.rss-preset-tag {
  padding: 4px var(--spacing-sm);
  border-radius: var(--border-radius);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease,
    color 0.2s ease;
}

.rss-preset-tag:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--primary);
  color: var(--primary);
}

.rss-preset-tag.active {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--text-on-primary);
}

.rss-preset-tag:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
