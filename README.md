# 幽读 Youdu

本地优先的电子书阅读器：核心阅读完全离线可用，无需登录、无云端依赖；RSS 订阅与 OPDS 书库为可选联网功能。

## 功能

- 支持 TXT / EPUB / MOBI / AZW3 / PDF / CBZ / CBR 等主流格式
- 智能分类：自动识别文字 / 图文 / 漫画，支持手动修正与学习
- 三种阅读模式：按章显示、无限拼接、翻页
- 漫画与扫描版优化：图片精确占位、按需加载、滚动稳定
- 多主题、字体排版自定义，繁简转换
- 书签、高亮、全文搜索，阅读进度精确保存
- 可选联网：RSS 订阅、OPDS 在线书库浏览下载


## 下载安装

当前版本 v0.3.6（Linux x64）：

- **Deepin / Debian / Ubuntu（deb）**：[Youdu-0.3.6-linux-x64.deb](https://github.com/aaccccccs/youdu/releases/download/v0.3.6/Youdu-0.3.6-linux-x64.deb)
- **通用 Linux（AppImage）**：[Youdu-0.3.6-linux-x86_64.AppImage](https://github.com/aaccccccs/youdu/releases/download/v0.3.6/Youdu-0.3.6-linux-x86_64.AppImage)
- **Deepin 玲珑（uab）**：[Youdu-0.3.6-linglong-x64.uab](https://github.com/aaccccccs/youdu/releases/download/v0.3.6/Youdu-0.3.6-linglong-x64.uab)

安装方式：

```bash
# deb 包
sudo dpkg -i Youdu-0.3.6-linux-x64.deb

# AppImage：下载后添加执行权限直接运行
chmod +x Youdu-0.3.6-linux-x86_64.AppImage && ./Youdu-0.3.6-linux-x86_64.AppImage

# 玲珑包
ll-cli install Youdu-0.3.6-linglong-x64.uab
```

其他版本见 [Releases](https://github.com/aaccccccs/youdu/releases)。

## 从源码构建

需要 Node.js 20+。

```bash
npm install
npm run dev      # 开发调试
npm run build:linux
```

### GLIBC 2.28 兼容构建（Deepin 20 / UOS 20 / Debian 10）

面向上述老 glibc（2.28）系统打包时，需先构建兼容的 better-sqlite3 二进制：

```bash
bash scripts/build-better-sqlite3-glibc228.sh
```

脚本会在 Debian 10 chroot 中从源码编译，产物保存到 `resources/native/`，之后执行 `npm run build:linux` 时自动替换进安装包。脚本首次运行会通过 debootstrap 创建 chroot（需要 `sudo`，并访问 archive.debian.org）。仅面向较新系统（glibc 2.31+）构建时无需此步骤。

## 许可证

[MIT License](LICENSE)，第三方组件许可证见 [third-party-licenses/](third-party-licenses/)。
