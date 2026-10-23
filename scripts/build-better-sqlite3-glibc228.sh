#!/bin/bash
# 在 Debian 10 (GLIBC 2.28) chroot 中编译 better-sqlite3 v13.0.3
# 生成兼容 uosV20/deepinV20 的 linux-x64.node
# 用法：bash scripts/build-better-sqlite3-glibc228.sh
set -euo pipefail

# chroot 目录：默认 $HOME/debian10-buster，可通过环境变量 CHROOT_DIR 覆盖
# （脚本普通用户启动时求值，$HOME 为当前用户主目录；sudo 内部命令不受影响）
CHROOT_DIR="${CHROOT_DIR:-$HOME/debian10-buster}"
NODE_VERSION="v22.11.0"
BETTER_SQLITE3_VERSION="13.0.3"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${SCRIPT_DIR}/../resources/native"
OUTPUT_FILE="${OUTPUT_DIR}/better-sqlite3-linux-x64-glibc228.node"

# Debian 10 buster 已 EOL，国内镜像已下线，只有 archive.debian.org 可用
MIRROR="http://archive.debian.org/debian"

echo "================================================"
echo "  better-sqlite3 v${BETTER_SQLITE3_VERSION} GLIBC 2.28 兼容编译"
echo "  目标：uosV20 / deepinV20 (Debian 10, GLIBC 2.28)"
echo "  chroot: ${CHROOT_DIR}"
echo "  镜像: ${MIRROR}"
echo "================================================"
echo ""

# 1. 安装 debootstrap
if ! command -v debootstrap &>/dev/null; then
  echo "[1/6] 安装 debootstrap..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq debootstrap
else
  echo "[1/6] debootstrap 已安装"
fi

# 2. 创建 Debian 10 chroot
if [ ! -f "${CHROOT_DIR}/etc/debian_version" ]; then
  echo "[2/6] 创建 Debian 10 (buster) chroot..."
  sudo rm -rf "${CHROOT_DIR}"
  sudo mkdir -p "${CHROOT_DIR}"
  sudo debootstrap --arch=amd64 --no-check-gpg buster "${CHROOT_DIR}" "${MIRROR}"
  echo "  chroot 创建完成"
else
  echo "[2/6] chroot 已存在，跳过"
fi

# 验证 chroot 的 GLIBC 版本
CHROOT_GLIBC=$(sudo chroot "${CHROOT_DIR}" /lib/x86_64-linux-gnu/libc.so.6 2>/dev/null | head -1 | grep -oP 'release version \K[\d.]+' || echo "unknown")
echo "  chroot GLIBC 版本: ${CHROOT_GLIBC}"

# 3. 安装编译工具链
echo "[3/6] 在 chroot 中安装编译工具链..."
# buster EOL，sources.list 必须用 archive 镜像
sudo chroot "${CHROOT_DIR}" /bin/bash -c "
  echo 'deb http://archive.debian.org/debian buster main' > /etc/apt/sources.list
  echo 'Acquire::Check-Valid-Until \"false\";' > /etc/apt/apt.conf.d/99no-check-valid-until
  apt-get update -qq 2>&1 | tail -3
  apt-get install -y -qq python3 g++ make curl xz-utils ca-certificates 2>&1 | tail -5
"

# 4. 安装 Node.js 22
echo "[4/6] 安装 Node.js ${NODE_VERSION}..."
sudo chroot "${CHROOT_DIR}" /bin/bash -c "
  if ! command -v node &>/dev/null; then
    cd /tmp
    curl -fsSL https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz -o node.tar.xz
    tar -xf node.tar.xz
    mv node-${NODE_VERSION}-linux-x64 /opt/node
    ln -sf /opt/node/bin/node /usr/local/bin/node
    ln -sf /opt/node/bin/npm /usr/local/bin/npm
    ln -sf /opt/node/bin/npx /usr/local/bin/npx
    rm -f node.tar.xz
  fi
  echo '  Node:' \$(node --version)
  echo '  npm:' \$(npm --version)
"

# 5. 编译 better-sqlite3
echo "[5/6] 从源码编译 better-sqlite3 v${BETTER_SQLITE3_VERSION}..."
sudo chroot "${CHROOT_DIR}" /bin/bash -c "
  cd /tmp
  rm -rf better-sqlite3-build
  mkdir better-sqlite3-build
  cd better-sqlite3-build
  npm init -y
  # --ignore-scripts: 不运行 install 脚本，避免复制预编译
  npm install better-sqlite3@${BETTER_SQLITE3_VERSION} --ignore-scripts 2>&1 | tail -5
  cd node_modules/better-sqlite3
  # 删除预编译，确保从源码编译
  rm -rf prebuilds build
  # 安装 node-gyp v9（v10+ 的 gyp 脚本用海象运算符，需要 Python 3.8+，Debian10 只有 3.7）
  npm install node-gyp@9 --no-save 2>&1 | tail -3
  # c++20 → c++17：g++8 不支持 c++20 标志；源码已用 g++ -std=c++17 -fsyntax-only 验证兼容
  sed -i 's/-std=c++20/-std=c++17/g' binding.gyp
  # 从源码编译
  echo '  开始 node-gyp 编译（c++17）...'
  npx node-gyp configure build 2>&1 | tail -20
"

# 6. 提取并验证
echo "[6/6] 提取编译产物并验证 GLIBC 依赖..."
COMPILED_NODE="${CHROOT_DIR}/tmp/better-sqlite3-build/node_modules/better-sqlite3/build/Release/better_sqlite3.node"

if [ ! -f "${COMPILED_NODE}" ]; then
  echo "❌ 编译失败：未找到 better_sqlite3.node"
  echo "   检查编译日志："
  sudo chroot "${CHROOT_DIR}" /bin/bash -c "ls -la /tmp/better-sqlite3-build/node_modules/better-sqlite3/build/Release/ 2>/dev/null || echo '  build/Release 不存在'"
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"
sudo cp "${COMPILED_NODE}" "${OUTPUT_FILE}"
sudo chown "${SUDO_UID:-$(id -u)}:${SUDO_GID:-$(id -g)}" "${OUTPUT_FILE}"

echo ""
echo "=== 验证 ==="
echo "文件类型："
file "${OUTPUT_FILE}"

echo ""
echo "GLIBC 依赖（最高版本）："
objdump -T "${OUTPUT_FILE}" | grep -oP 'GLIBC_[\d.]+' | sort -t_ -k2 -V | uniq

echo ""
echo "GLIBCXX 依赖（最高版本）："
objdump -T "${OUTPUT_FILE}" | grep -oP 'GLIBCXX_[\d.]+' | sort -t_ -k2 -V | uniq

echo ""
echo "✅ 编译完成！产物已保存到："
echo "   ${OUTPUT_FILE}"
echo ""
echo "下一步：afterPack hook 会自动将此文件替换到打包产物中。"