import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

// 修复：某些环境（如 Windows Insider Preview + 某些工具链）会全局设置
// ELECTRON_RUN_AS_NODE=1，导致 electron.exe 作为纯 Node.js 运行而非 Electron 主进程。
// 在此清除该变量，确保 electron-vite dev/preview 启动的是完整的 Electron 主进程。
if (process.env.ELECTRON_RUN_AS_NODE) {
  delete process.env.ELECTRON_RUN_AS_NODE;
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // sourcemap: 'hidden' 生成 source map 但不在输出文件末尾追加 //# sourceMappingURL 注释，
      // 适合生产构建：可在外部工具（如 sentry）中映射错误，又不向用户暴露源码路径。
      sourcemap: 'hidden',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'pdf-worker': resolve(__dirname, 'src/main/core/pdf-worker.ts')
        },
        output: {
          // 在打包产物最开头执行：
          // 1. delete ELECTRON_RUN_AS_NODE — 确保 require("electron") 之前清除该变量
          // 2. worker_threads 中 stub electron — file-parser→utils→require('electron')在worker中失败
          //    banner是原始文本在所有require()之前执行，确保stub先安装
          //    isMainThread检查确保只在worker中生效，不影响主进程
          banner: `delete process.env.ELECTRON_RUN_AS_NODE;
if (!require('worker_threads').isMainThread) {
  var _NM = require('module');
  var _OL = _NM._load;
  _NM._load = function(req, par, isM) {
    if (req === 'electron') {
      var p = require('path'), o = require('os');
      return {
        app: {
          isPackaged: true,
          getPath: function(n) {
            if (n === 'userData') return p.join(p.dirname(process.execPath), 'data');
            if (n === 'temp') return o.tmpdir();
            if (n === 'home') return o.homedir();
            return '';
          },
          isReady: function(){return true;},
          getVersion: function(){return '0.0.1';},
          getName: function(){return 'youdu';}
        },
        BrowserWindow:{},dialog:{},Notification:{},
        ipcMain:{handle:function(){},on:function(){},removeHandler:function(){}},
        shell:{},screen:{},session:{},Menu:{},
        clipboard:{readText:function(){return '';},writeText:function(){}}
      };
    }
    return _OL.call(this, req, par, isM);
  };
}`,
          // chunk 文件名不带 hash 和子目录，确保 require('./file-parser') 能解析到
          chunkFileNames: '[name].js',
          // 强制 file-parser 和 utils 成为独立 chunk（file-parser.js），
          // 否则 rollup 会把它们内联进 index.js，导致 pdf-worker.js 的
          // require('./file-parser') 在打包后找不到模块
          manualChunks: (id: string): string | undefined => {
            if (id.includes('/src/main/core/file-parser') || id.includes('/src/main/utils')) {
              return 'file-parser';
            }
            return undefined;
          }
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: 'hidden',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        // '@renderer' 是主推的渲染进程源码别名（与 tsconfig.web.json paths 对应）。
        '@renderer': resolve('src/renderer/src'),
        // '@' 作为兼容别名保留，方便迁移自其他模板的代码。
        // 新代码建议统一使用 '@renderer'。
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [
      vue({
        // Electron <webview> 标签是自定义元素，需告知 Vue 编译器不要将其视为 Vue 组件
        // 否则 Vue 3 可能不正确渲染 webview，导致浏览器页面无法加载外部网页
        template: {
          compilerOptions: {
            isCustomElement: (tag) => tag === 'webview'
          }
        }
      })
    ],
    build: {
      sourcemap: 'hidden',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
});
