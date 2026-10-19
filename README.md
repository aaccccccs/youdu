# 幽读 Youdu

本地优先的电子书阅读器：核心阅读完全离线可用，无需登录、无云端依赖；RSS 订阅与 OPDS 书库为可选联网功能。

## 功能

- 支持 TXT / EPUB / MOBI / AZW3 / PDF / CBZ / CBR 等主流格式
- 三种阅读模式：按章显示、无限拼接、翻页
- 多主题、字体排版自定义，繁简转换
- 书签、高亮、全文搜索，阅读进度精确保存
- 可选联网：RSS 订阅、OPDS 在线书库浏览下载

## 下载安装

当前版本 v0.2.0（Linux x64）：

- **Deepin / Debian / Ubuntu（deb）**：[Youdu-0.2.0-linux-x64.deb](https://github.com/aaccccccs/youdu/releases/download/v0.2.0/Youdu-0.2.0-linux-x64.deb)
- **通用 Linux（AppImage）**：[Youdu-0.2.0-linux-x86_64.AppImage](https://github.com/aaccccccs/youdu/releases/download/v0.2.0/Youdu-0.2.0-linux-x86_64.AppImage)
- **Deepin 玲珑（uab）**：[Youdu-0.2.0-linglong-x64.uab](https://github.com/aaccccccs/youdu/releases/download/v0.2.0/Youdu-0.2.0-linglong-x64.uab)

安装方式：

```bash
# deb 包
sudo dpkg -i Youdu-0.2.0-linux-x64.deb

# AppImage：下载后添加执行权限直接运行
chmod +x Youdu-0.2.0-linux-x86_64.AppImage && ./Youdu-0.2.0-linux-x86_64.AppImage

# 玲珑包
ll-cli install Youdu-0.2.0-linglong-x64.uab
```

其他版本见 [Releases](https://github.com/aaccccccs/youdu/releases)。

## 从源码构建

需要 Node.js 20+。

```bash
npm install
npm run dev      # 开发调试
npm run build:linux
```

## 许可证

[MIT License](LICENSE)，第三方组件许可证见 [third-party-licenses/](third-party-licenses/)。
