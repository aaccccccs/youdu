/**
 * 渲染进程共享 composables
 *
 * 分类组织：
 *   1. useDropdownIcon — NDropdown 图标渲染
 *   2. useThemeSwatchOptions — 主题色块选项
 *   3. useCustomThemeColors — 自定义主题颜色双向绑定
 *   4. useShowCustomColors — 是否显示自定义颜色选择器
 *   5. useBookItem — 书籍项共享逻辑
 *   6. useDebounce — debounce 函数
 *   7. useContextMenu — 右键菜单共享状态管理
 *   8. useCover — 封面 URL 生成与加载失败回退
 *   9. useInlineImageLightbox — 内联图片 Lightbox 放大查看
 */

import {
  computed,
  h,
  ref,
  watch,
  onMounted,
  onBeforeUnmount,
  type ComputedRef,
  type WritableComputedRef,
  type Ref,
  type Component,
  type VNodeChild
} from 'vue';
import { NIcon, type SelectOption } from 'naive-ui';
import { useSettingsStore, getThemeColors, type ThemeType } from '@renderer/stores';
import type { Book } from '@renderer/types';
import { generateCoverDataUrl, coverPathToUrl, formatRelativeTime } from '@renderer/utils';
import { i18n } from '@renderer/i18n';

/* ==================== 1. useDropdownIcon ==================== */

/**
 * 渲染图标 helper（NDropdown icon 需要 VNodeChild）
 *
 * @returns 一个函数，接收图标组件并返回渲染函数
 */
export function useDropdownIcon(): (icon: Component) => () => VNodeChild {
  return (icon: Component): (() => VNodeChild) => {
    return (): VNodeChild => h(NIcon, null, { default: () => h(icon) });
  };
}

/* ==================== 2. useThemeSwatchOptions ==================== */

/** 字体选项（共享常量；label 取当前语言，value 为跨语言稳定标识） */
export const fontFamilyOptions: SelectOption[] = [
  { label: i18n.global.t('settings.fonts.system'), value: 'system' },
  { label: i18n.global.t('settings.fonts.serif'), value: 'serif' },
  { label: i18n.global.t('settings.fonts.kai'), value: 'kai' },
  { label: i18n.global.t('settings.fonts.hei'), value: 'hei' }
];

/** 主题色块选项项结构 */
interface ThemeSwatchItem {
  label: string;
  value: ThemeType;
  bg: string;
  text: string;
}

/**
 * 主题色块选项
 *
 * 返回 6 种预设主题（日间/夜间/护眼/羊皮纸/科研/自定义）的色块数据，
 * 供主题选择器渲染使用。
 *
 * @returns 响应式主题色块数组
 */
export function useThemeSwatchOptions(): ComputedRef<ThemeSwatchItem[]> {
  const settings = useSettingsStore();
  const t = i18n.global.t;
  return computed<ThemeSwatchItem[]>(() => [
    { label: t('settings.themes.day'), value: 'day', ...getThemeColors('day') },
    { label: t('settings.themes.night'), value: 'night', ...getThemeColors('night') },
    { label: t('settings.themes.eye'), value: 'eye', ...getThemeColors('eye') },
    { label: t('settings.themes.parchment'), value: 'parchment', ...getThemeColors('parchment') },
    { label: t('settings.themes.research'), value: 'research', ...getThemeColors('research') },
    {
      label: t('settings.themes.custom'),
      value: 'custom',
      bg: settings.customThemeColors.bg,
      text: settings.customThemeColors.text
    }
  ]);
}

/* ==================== 3. useCustomThemeColors ==================== */

/** 自定义主题颜色双向绑定返回结构 */
interface CustomThemeColorsBinding {
  customBg: WritableComputedRef<string>;
  customText: WritableComputedRef<string>;
  customPrimary: WritableComputedRef<string>;
}

/**
 * 自定义主题颜色双向绑定
 *
 * 为自定义主题的 bg/text/primary 三个颜色提供可读写的 computed，
 * 写入时自动合并到 settings store。
 *
 * @returns customBg, customText, customPrimary 三个双向绑定
 */
export function useCustomThemeColors(): CustomThemeColorsBinding {
  const settings = useSettingsStore();

  const customBg = computed<string>({
    get: (): string => settings.customThemeColors.bg,
    set: (v: string): void => {
      void settings
        .setCustomThemeColors({
          ...settings.customThemeColors,
          bg: v
        })
        .catch((e) => console.error('settings.setCustomThemeColors 失败:', e));
    }
  });

  const customText = computed<string>({
    get: (): string => settings.customThemeColors.text,
    set: (v: string): void => {
      void settings
        .setCustomThemeColors({
          ...settings.customThemeColors,
          text: v
        })
        .catch((e) => console.error('settings.setCustomThemeColors 失败:', e));
    }
  });

  const customPrimary = computed<string>({
    get: (): string => settings.customThemeColors.primary,
    set: (v: string): void => {
      void settings
        .setCustomThemeColors({
          ...settings.customThemeColors,
          primary: v
        })
        .catch((e) => console.error('settings.setCustomThemeColors 失败:', e));
    }
  });

  return { customBg, customText, customPrimary };
}

/* ==================== 4. useShowCustomColors ==================== */

/**
 * 是否显示自定义颜色选择器
 *
 * @param scope 'app' 全局范围（app 或 reader 任一为 custom 时显示） / 'reader' 仅阅读器范围
 * @returns 响应式布尔值
 */
export function useShowCustomColors(scope: 'app' | 'reader'): ComputedRef<boolean> {
  const settings = useSettingsStore();
  if (scope === 'app') {
    return computed<boolean>(() => settings.appTheme === 'custom' || settings.readerTheme === 'custom');
  }
  return computed<boolean>(() => settings.readerTheme === 'custom');
}

/* ==================== 5. useBookItem ==================== */

/** useBookItem 的 emit 事件签名 */
interface BookItemEmit {
  (e: 'open', book: Book): void;
  (e: 'toggle-select', id: number): void;
  (e: 'contextmenu', book: Book, x: number, y: number): void;
}

/** useBookItem 返回结构 */
interface BookItemBinding {
  coverUrl: ComputedRef<string>;
  relativeTime: ComputedRef<string>;
  authorText: ComputedRef<string>;
  handleClick: (e: MouseEvent) => void;
  handleKeyActivate: () => void;
  handleContextmenu: (e: MouseEvent) => void;
  handleCheckboxClick: (e: MouseEvent) => void;
}

/**
 * 书籍项共享逻辑
 *
 * 提供书籍卡片的封面 URL、相对时间、作者文本等计算属性，
 * 以及点击、键盘激活、右键菜单、复选框点击等事件处理函数。
 *
 * @param book 书籍数据获取函数（响应式 getter）
 * @param selectionMode 是否处于多选模式的获取函数（响应式 getter）
 * @param emit 组件 emit 函数
 * @returns 封面 URL、相对时间、作者文本及事件处理函数
 */
export function useBookItem(book: () => Book, selectionMode: () => boolean, emit: BookItemEmit): BookItemBinding {
  /** 封面 URL：有封面用图片，无封面生成 SVG */
  const coverUrl = computed<string>((): string => {
    const b: Book = book();
    const url: string | null = coverPathToUrl(b.cover);
    if (url) return url;
    return generateCoverDataUrl(b.title, b.author);
  });

  /** 相对时间 */
  const relativeTime = computed<string>((): string => formatRelativeTime(book().last_read_at));

  /** 作者文本（空则显示未知作者） */
  const authorText = computed<string>((): string => book().author || i18n.global.t('common.words.unknownAuthor'));

  /** 点击：Ctrl/Cmd 强制多选，多选模式下切换选中，否则打开 */
  function handleClick(e: MouseEvent): void {
    if (e.ctrlKey || e.metaKey) {
      emit('toggle-select', book().id);
      return;
    }
    if (selectionMode()) {
      emit('toggle-select', book().id);
    } else {
      emit('open', book());
    }
  }

  /** 键盘激活（Enter / Space）：与点击行为一致，无修饰键 */
  function handleKeyActivate(): void {
    if (selectionMode()) {
      emit('toggle-select', book().id);
    } else {
      emit('open', book());
    }
  }

  /** 右键菜单 */
  function handleContextmenu(e: MouseEvent): void {
    e.preventDefault();
    emit('contextmenu', book(), e.clientX, e.clientY);
  }

  /** 阻止 checkbox 点击冒泡到卡片 */
  function handleCheckboxClick(e: MouseEvent): void {
    e.stopPropagation();
    emit('toggle-select', book().id);
  }

  return {
    coverUrl,
    relativeTime,
    authorText,
    handleClick,
    handleKeyActivate,
    handleContextmenu,
    handleCheckboxClick
  };
}

/* ==================== 6. useDebounce ==================== */

/** useDebounce 返回结构 */
interface DebounceBinding {
  run: (...args: unknown[]) => void;
  cancel: () => void;
}

/**
 * 创建 debounce 函数
 *
 * 在指定延迟内多次调用只执行最后一次。用于替代各组件中手动实现的 debounce 逻辑。
 * 组件卸载时自动清理 pending timer，避免回调在组件销毁后执行导致内存泄漏。
 *
 * @param fn 需要 debounce 的函数
 * @param delay 延迟毫秒数
 * @returns run 触发 debounce 调用，cancel 取消 pending 调用
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useDebounce(fn: (...args: any[]) => unknown, delay: number): DebounceBinding {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function run(...args: unknown[]): void {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout((): void => {
      timer = null;
      fn(...args);
    }, delay);
  }

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  // 组件卸载时自动清理 pending timer，避免回调在组件销毁后执行导致内存泄漏
  onBeforeUnmount(cancel);

  return { run, cancel };
}

/* ==================== 7. useContextMenu ==================== */

/** useContextMenu 返回结构 */
interface ContextMenuBinding {
  contextMenuShow: Ref<boolean>;
  contextMenuX: Ref<number>;
  contextMenuY: Ref<number>;
  openContextMenu: (x: number, y: number) => void;
  closeContextMenu: () => void;
}

/**
 * 右键菜单共享状态管理
 *
 * 用于替代 Bookshelf.vue、Reader.vue、GroupSidebar.vue
 * 中重复的右键菜单状态管理代码。
 *
 * @returns contextMenuShow/X/Y 响应式状态及 open/close 操作函数
 */
export function useContextMenu(): ContextMenuBinding {
  const contextMenuShow = ref<boolean>(false);
  const contextMenuX = ref<number>(0);
  const contextMenuY = ref<number>(0);

  /** 打开右键菜单：设置坐标并显示 */
  function openContextMenu(x: number, y: number): void {
    contextMenuX.value = x;
    contextMenuY.value = y;
    contextMenuShow.value = true;
  }

  /** 关闭右键菜单 */
  function closeContextMenu(): void {
    contextMenuShow.value = false;
  }

  return { contextMenuShow, contextMenuX, contextMenuY, openContextMenu, closeContextMenu };
}
/* ==================== 8. useCover ==================== */

/** useCover 接受的 book 形状（Book 的结构子集，仅需封面相关字段） */
interface CoverSource {
  cover?: string | null;
  title?: string;
  author?: string | null;
}

/** useCover 返回结构 */
interface CoverBinding {
  /** 实际渲染的封面 URL（含加载失败回退） */
  coverUrl: ComputedRef<string>;
  /** 封面图片是否加载失败 */
  coverLoadFailed: Ref<boolean>;
  /** 封面图片加载失败时的错误处理函数（绑定到 <img @error>） */
  onCoverError: () => void;
}

/**
 * 封面 URL 生成与加载失败回退
 *
 * 统一封装 GridItem.vue、ListItem.vue、BookDetail.vue、Subscriptions.vue
 * 中重复的封面加载逻辑：
 *   - 有封面路径 → 通过 coverPathToUrl 转为可用的 URL
 *   - 无封面路径 → 通过 generateCoverDataUrl 生成默认 SVG 封面
 *   - 封面加载失败（@error）→ 回退到默认 SVG 封面，避免破图
 *   - 封面路径变化（如用户更换封面）→ 自动重置失败标志，重新尝试加载
 *
 * @param book 书籍数据获取函数（响应式 getter，与 useBookItem 风格一致）
 * @returns coverUrl（最终渲染 URL）、coverLoadFailed（失败标志）、onCoverError（错误处理）
 */
export function useCover(book: () => CoverSource): CoverBinding {
  /** 封面图片加载失败标志：失败后回退到默认 SVG 封面，避免无限循环 */
  const coverLoadFailed = ref<boolean>(false);

  /**
   * 基础封面 URL：有封面用图片，无封面生成 SVG（不含加载失败回退）。
   *
   * 单独抽出此 computed 是为了给 watch 提供一个不依赖 coverLoadFailed 的信号源，
   * 避免 watch(coverUrl) 与 coverLoadFailed 形成循环依赖。
   */
  const baseCoverUrl = computed<string>((): string => {
    const b: CoverSource = book();
    const url: string | null = coverPathToUrl(b.cover ?? null);
    if (url) return url;
    return generateCoverDataUrl(b.title || '', b.author ?? '');
  });

  /**
   * 封面路径变化时重置加载失败标志。
   *
   * 监听 baseCoverUrl（而非最终 coverUrl）避免循环：
   *   - 加载失败 → coverLoadFailed=true → coverUrl 变为 SVG → baseCoverUrl 不变 → watch 不触发
   *   - 封面更新 → baseCoverUrl 变化 → watch 触发 → coverLoadFailed 重置 → coverUrl 重新尝试加载
   */
  watch(baseCoverUrl, (): void => {
    coverLoadFailed.value = false;
  });

  /** 实际渲染的封面 URL：加载失败时回退到默认 SVG */
  const coverUrl = computed<string>((): string => {
    if (coverLoadFailed.value) {
      const b: CoverSource = book();
      return generateCoverDataUrl(b.title || '', b.author ?? '');
    }
    return baseCoverUrl.value;
  });

  /** 封面图片加载失败时的错误处理函数 */
  function onCoverError(): void {
    coverLoadFailed.value = true;
  }

  return { coverUrl, coverLoadFailed, onCoverError };
}

/* ==================== 9. useInlineImageLightbox ==================== */

/** useInlineImageLightbox 返回结构 */
interface InlineImageLightboxBinding {
  /** 当前放大查看的图片 src */
  imageViewerSrc: Ref<string>;
  /** 是否显示图片放大查看 */
  imageViewerVisible: Ref<boolean>;
  /** 打开图片放大查看 */
  openImageViewer: (src: string) => void;
  /** 关闭图片放大查看 */
  closeImageViewer: () => void;
  /** Lightbox 遮罩点击关闭（点击遮罩背景关闭，点击图片本身不关闭） */
  handleLightboxClick: (e: MouseEvent) => void;
  /** Lightbox Esc 键关闭 */
  handleLightboxKeydown: (e: KeyboardEvent) => void;
  /** 为单张内联图片绑定 load/error 事件 */
  bindInlineImgEvents: (img: HTMLImageElement) => void;
  /** 扫描容器内所有 .inline-illustration 图片，纳入 IntersectionObserver 监听 */
  observeInlineImages: () => void;
}

/**
 * 内联图片 Lightbox 放大查看
 *
 * 统一封装 ScrollView.vue 和 PageView.vue 中约 80 行重复的 Lightbox 逻辑：
 *   - 图片放大查看状态管理（imageViewerSrc / imageViewerVisible）
 *   - 打开/关闭 lightbox（openImageViewer / closeImageViewer）
 *   - 遮罩点击关闭 + Esc 键关闭（handleLightboxClick / handleLightboxKeydown）
 *   - 内联图片懒加载事件绑定（bindInlineImgEvents）
 *   - IntersectionObserver 监听内联图片进入视口（observeInlineImages）
 *   - 自动在 onMounted 初始化 observer + 添加 Esc 键监听
 *   - 自动在 onBeforeUnmount 清理 observer + 移除 Esc 键监听
 *
 * 组件只需提供容器 ref，并在点击图片时调用 openImageViewer(img.src) 即可。
 *
 * @param containerRef 滚动/显示容器的 ref（用于 IntersectionObserver 的 root）
 * @returns lightbox 状态、操作函数及内联图片事件绑定方法
 */
export function useInlineImageLightbox(containerRef: Ref<HTMLDivElement | null>): InlineImageLightboxBinding {
  /* ─── Lightbox 状态 ─── */

  /** 当前放大查看的图片 src */
  const imageViewerSrc = ref<string>('');
  /** 是否显示图片放大查看 */
  const imageViewerVisible = ref<boolean>(false);

  /** 打开图片放大查看 */
  function openImageViewer(src: string): void {
    if (!src) return;
    imageViewerSrc.value = src;
    imageViewerVisible.value = true;
  }

  /** 关闭图片放大查看 */
  function closeImageViewer(): void {
    imageViewerVisible.value = false;
    imageViewerSrc.value = '';
  }

  /** Lightbox 遮罩点击关闭（点击遮罩背景关闭，点击图片本身不关闭） */
  function handleLightboxClick(e: MouseEvent): void {
    // 仅当点击的是遮罩层本身（而非图片）时关闭
    if (e.target === e.currentTarget) {
      closeImageViewer();
    }
  }

  /** Lightbox Esc 键关闭 */
  function handleLightboxKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && imageViewerVisible.value) {
      closeImageViewer();
    }
  }

  /* ─── 内联图片懒加载 & 事件委托 ─── */

  /** IntersectionObserver 实例（用于监听内联图片进入视口时附加 load/error 事件） */
  let inlineImgObserver: IntersectionObserver | null = null;

  /**
   * 处理单张内联图片的 load 事件：移除 data-loading 占位状态，触发淡入动画。
   */
  function handleInlineImgLoad(img: HTMLImageElement): void {
    img.removeAttribute('data-loading');
    img.classList.add('inline-illustration-loaded');
  }

  /**
   * 处理单张内联图片的 error 事件：标记加载失败状态，显示重试提示。
   */
  function handleInlineImgError(img: HTMLImageElement): void {
    img.removeAttribute('data-loading');
    img.setAttribute('data-error', 'true');
  }

  /**
   * 为单张内联图片绑定 load/error 事件。
   * 若图片已加载完成（complete 且 naturalWidth>0），直接触发 load 处理。
   */
  function bindInlineImgEvents(img: HTMLImageElement): void {
    if (img.dataset.bound === 'true') return;
    img.dataset.bound = 'true';
    img.addEventListener('load', () => handleInlineImgLoad(img), { once: true });
    img.addEventListener('error', () => handleInlineImgError(img), { once: true });
    // 若图片已从缓存加载完成，load 事件可能不再触发，手动处理
    if (img.complete && img.naturalWidth > 0) {
      handleInlineImgLoad(img);
    }
  }

  /**
   * 扫描容器内所有 .inline-illustration 图片，纳入 IntersectionObserver 监听。
   * 图片进入视口时绑定 load/error 事件（配合 loading="lazy" 实现按需加载）。
   */
  function observeInlineImages(): void {
    if (!containerRef.value) return;
    const observer = inlineImgObserver;
    if (!observer) return;
    const imgs = containerRef.value.querySelectorAll<HTMLImageElement>('.inline-illustration');
    imgs.forEach((img) => {
      if (img.dataset.observed === 'true') return;
      img.dataset.observed = 'true';
      observer.observe(img);
    });
  }

  /* ─── 生命周期管理（自动初始化/清理 observer 和 Esc 键监听） ─── */

  onMounted((): void => {
    // 初始化 IntersectionObserver：监听内联图片进入视口时绑定 load/error 事件
    // rootMargin 提前 200px 触发，让图片在进入视口前就开始加载
    if (typeof IntersectionObserver !== 'undefined' && containerRef.value) {
      inlineImgObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const img = entry.target as HTMLImageElement;
              bindInlineImgEvents(img);
              inlineImgObserver?.unobserve(img);
            }
          }
        },
        { root: containerRef.value, rootMargin: '200px 0px' }
      );
    }

    // 添加 Esc 键监听：关闭 lightbox
    window.addEventListener('keydown', handleLightboxKeydown);
  });

  onBeforeUnmount((): void => {
    // 清理内联图片相关资源
    if (inlineImgObserver) {
      inlineImgObserver.disconnect();
      inlineImgObserver = null;
    }
    // 移除 Esc 键监听
    window.removeEventListener('keydown', handleLightboxKeydown);
  });

  return {
    imageViewerSrc,
    imageViewerVisible,
    openImageViewer,
    closeImageViewer,
    handleLightboxClick,
    handleLightboxKeydown,
    bindInlineImgEvents,
    observeInlineImages
  };
}
