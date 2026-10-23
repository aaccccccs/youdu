/**
 * vitest 全局 setup（node 环境补丁）
 *
 * 背景：src/renderer/src/i18n.ts 在模块顶层读取 localStorage（渲染进程 API），
 * 而 vitest 运行在 node 环境（见 vitest.config.ts 的 environment: 'node'），
 * 缺少该全局对象会导致导入 utils.ts -> i18n.ts 的测试套件直接加载失败。
 *
 * 此处提供一个最小化的内存版 localStorage，仅用于单元测试，
 * 不改变任何产品代码行为。
 */

interface MemoryStorage extends Storage {
  __store: Map<string, string>;
}

function createMemoryLocalStorage(): MemoryStorage {
  const store = new Map<string, string>();

  return {
    __store: store,
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      store.set(String(key), String(value));
    },
    removeItem(key: string): void {
      store.delete(String(key));
    },
    clear(): void {
      store.clear();
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    get length(): number {
      return store.size;
    }
  } as MemoryStorage;
}

if (typeof globalThis.localStorage === 'undefined') {
  (globalThis as Record<string, unknown>).localStorage = createMemoryLocalStorage();
}