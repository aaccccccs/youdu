import { createApp, watch } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import naive from 'naive-ui';
import App from './App.vue';
import { i18n, setAppLocale, getSavedLocale } from './i18n';
import './styles/main.css';

// 暴露全局切换语言函数（设置页使用）
(window as unknown as Record<string, unknown>).__setLocale = (locale: 'zh-CN' | 'en') => {
  setAppLocale(locale);
};

// 首屏同步 <html lang>
try {
  document.documentElement.lang = getSavedLocale();
} catch {
  /* ignore */
}

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'bookshelf',
    component: () => import('@renderer/views/Bookshelf.vue'),
    meta: { title: 'bookshelf.title' }
  },
  {
    path: '/book/:bookId',
    name: 'book-detail',
    component: () => import('@renderer/views/BookDetail.vue'),
    meta: { title: 'bookDetail.title' }
  },
  {
    path: '/reader/:bookId',
    name: 'reader',
    component: () => import('@renderer/views/Reader.vue'),
    meta: { title: 'reader.title' }
  },
  {
    path: '/article/:bookId',
    name: 'article',
    component: () => import('@renderer/views/ArticleView.vue'),
    meta: { title: 'article.title' }
  },
  {
    path: '/sources',
    name: 'sources',
    component: () => import('@renderer/views/Sources.vue'),
    meta: { title: 'sources.title' }
  },
  {
    path: '/subscriptions',
    redirect: '/sources?tab=rss'
  },
  {
    path: '/opds',
    redirect: '/sources'
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@renderer/views/Settings.vue'),
    meta: { title: 'settings.title' }
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    redirect: '/'
  }
];

const router = createRouter({
  history: createWebHashHistory(),
  routes
});

// 根据当前路由与语言更新窗口标题（路由切换或语言切换时均触发）
function applyDocumentTitle(): void {
  const titleKey = router.currentRoute.value.meta?.title as string | undefined;
  const appName = i18n.global.t('common.appName');
  if (titleKey) {
    const translated = i18n.global.t(titleKey);
    document.title = translated === titleKey ? appName : `${translated} - ${appName}`;
  } else {
    document.title = appName;
  }
}

router.afterEach(() => applyDocumentTitle());
// 语言切换后窗口标题即时跟随
watch(i18n.global.locale, () => applyDocumentTitle());

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(naive);
app.use(i18n);

// 全局错误处理器：捕获渲染组件中未处理的错误，避免白屏
app.config.errorHandler = (err, _instance, info) => {
  console.error('[renderer] Vue 错误:', info, err);
};

// 捕获未处理的 Promise 拒绝
window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer] 未处理的 Promise 拒绝:', event.reason);
  event.preventDefault();
});

app.mount('#app');
