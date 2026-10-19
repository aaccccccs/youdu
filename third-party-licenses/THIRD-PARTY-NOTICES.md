# 第三方组件许可声明（Third-Party Notices）

本应用（幽读 / Youdu，本体 MIT 许可）随分发包附带以下第三方组件。
其中标注"包内未附带 LICENSE"的组件，许可声明在此书面补录。

## libvips 8.18.7（@img/sharp-libvips-linux-x64）

- 许可证：LGPL-3.0-or-later，全文见同目录 [LICENSE-LGPL-3.0.txt](LICENSE-LGPL-3.0.txt)；
  LGPL-3.0 以 GPL-3.0 为基础许可证，GPL-3.0 全文见 [LICENSE-GPL-3.0.txt](LICENSE-GPL-3.0.txt)
- 用途：图像处理库（sharp 的原生依赖），以独立预编译共享库形式分发
- 上游：https://github.com/libvips/libvips
- 说明：上游 npm 包（@img/sharp-libvips-linux-x64）内未附带许可证文本，此处补录

## epub-gen 0.1.0

- 许可证：MIT © cyrilis（https://github.com/cyrilis/epub-gen）
- 用途：EPUB 导出生成
- 说明：上游 npm 包内未附带 LICENSE 文件，此处补录 MIT 声明

## uslug 1.0.4

- 许可证：MIT © Jeremy Selier <jerem.selier@gmail.com>
- 用途：URL slug 生成（epub-gen 依赖）

## domutils 1.5.1

- 许可证：BSD-2-Clause © Felix Böhm
- 用途：DOM 工具（epub-gen 依赖链）

## 其他随包分发的组件

- Electron / Chromium：随安装目录附带 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`
- sharp 与 @img/sharp-linux-x64：Apache-2.0（npm 包内已附 LICENSE 全文）
- 其余 Node.js 依赖的完整许可清单见仓库 `package-lock.json`（npm 依赖树元数据）