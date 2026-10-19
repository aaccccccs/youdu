#!/bin/bash
# 幽读（Youdu）Linux deb 安装后脚本
# 1. 自动补装缺失的运行时依赖（确保 dpkg -i 后直接可用）
# 2. 修复 chrome-sandbox 的 setuid 权限（打包时在 NTFS 上无法保留 4755）
# 3. 覆盖系统 .desktop：显示名固定中文“幽读”，Exec 用绝对路径
# 4. 创建 /usr/bin/youdu 命令行链接
# 5. 刷新图标缓存、为桌面用户创建桌面图标
# 6. 清理历史包名 youdu-local / YouduLocal / 幽读本地版 遗留的启动项
#
# 注意：书库存放在 ~/.local/share/youdu/（XDG 数据目录），
#       由应用首次启动时自行迁移，postinst 不接触任何用户数据。

set -e

# === 0. 自动补装运行时依赖 ===
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq 2>/dev/null || true
  apt-get install -y -qq --no-install-recommends \
    libnotify4 \
    libxtst6 \
    libnss3 \
    libgbm1 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    libcups2 \
    2>/dev/null || true
  # t64 过渡包（Debian 12/Ubuntu 24.04 库重命名）
  apt-get install -y -qq --no-install-recommends \
    "libgtk-3-0" \
    "libasound2" \
    "libatk-bridge2.0-0" \
    2>/dev/null || true
fi

# === 0.5 检测中文字体，缺失时自动安装 fonts-noto-cjk ===
# 最小安装/服务器版系统可能无中文字体，导致 UI 和阅读器中文显示为方框
if command -v apt-get >/dev/null 2>&1; then
  # 检查是否存在任何中文字体
  HAS_CJK_FONT=0
  for font_dir in /usr/share/fonts /usr/local/share/fonts; do
    if [ -d "$font_dir" ]; then
      # 检查常见中文字体文件
      if find "$font_dir" -iname "*noto*cjk*" -o -iname "*wqy*" -o -iname "*source*han*" -o -iname "*droid*fallback*" -o -iname "*uming*" -o -iname "*ukai*" 2>/dev/null | grep -q .; then
        HAS_CJK_FONT=1
        break
      fi
    fi
  done
  if [ "$HAS_CJK_FONT" -eq 0 ]; then
    echo "[postinst] 未检测到中文字体，正在安装 fonts-noto-cjk ..."
    apt-get install -y -qq --no-install-recommends fonts-noto-cjk 2>/dev/null || true
    echo "[postinst] 中文字体安装完成"
  fi
fi

# === 1. 修复 chrome-sandbox 权限为 root:root 4755 ===
SANDBOX_BIN=""
for candidate in "/opt/Youdu/chrome-sandbox" "/opt/YouduLocal/chrome-sandbox" "/opt/幽读本地版/chrome-sandbox" "/opt/youdu-local/chrome-sandbox" "/usr/lib/youdu/chrome-sandbox"; do
  if [ -f "$candidate" ]; then
    SANDBOX_BIN="$candidate"
    break
  fi
done
if [ -z "$SANDBOX_BIN" ]; then
  SANDBOX_BIN="$(find /opt /usr/lib -maxdepth 4 -type f -name chrome-sandbox 2>/dev/null | head -n 1)"
fi
if [ -n "$SANDBOX_BIN" ]; then
  chown root:root "$SANDBOX_BIN"
  chmod 4755 "$SANDBOX_BIN"
  echo "[postinst] 已修复 chrome-sandbox 权限: $SANDBOX_BIN (root:root 4755)"
fi

# === 2. 覆盖系统 .desktop（内部名 youdu，显示名中文“幽读”）===
DESKTOP_FILE="/usr/share/applications/youdu.desktop"
INSTALL_BIN="/opt/Youdu/youdu"
if [ ! -x "$INSTALL_BIN" ]; then
  INSTALL_BIN="$(find /opt /usr/lib -maxdepth 4 -type f -name youdu 2>/dev/null | head -n 1)"
fi
if [ -n "$INSTALL_BIN" ] && [ -x "$INSTALL_BIN" ]; then
  cat > "$DESKTOP_FILE" <<DESKTOP_EOF
[Desktop Entry]
Type=Application
Name=幽读
GenericName=本地小说阅读器
Comment=支持 TXT/EPUB/MOBI/PDF/CBZ/CBR 的本地电子书阅读器
Exec=$INSTALL_BIN %U
Icon=youdu
Categories=Office;Utility;TextEditor;
Terminal=false
StartupWMClass=youdu
MimeType=application/epub+zip;application/pdf;text/plain;application/x-mobipocket-ebook;
DESKTOP_EOF
  chmod 644 "$DESKTOP_FILE"
  ln -sf "$INSTALL_BIN" /usr/bin/youdu
  echo "[postinst] 启动器项已写入: $DESKTOP_FILE -> $INSTALL_BIN"
fi

# === 3. 清理历史版本遗留启动项/链接（不动 /opt 下用户书库 data/）===
for stale in \
  "/usr/share/applications/youdu-local.desktop" \
  "/usr/share/applications/YouduLocal.desktop"; do
  if [ -f "$stale" ]; then
    rm -f "$stale"
  fi
done
if [ -L /usr/bin/youdu-local ]; then
  rm -f /usr/bin/youdu-local
fi

# === 4. 刷新图标缓存 ===
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f /usr/share/icons/hicolor/ 2>/dev/null || true
fi
if command -v dde-start-refresh >/dev/null 2>&1; then
  dde-start-refresh 2>/dev/null || true
fi
update-desktop-database -q /usr/share/applications 2>/dev/null || true

# === 5. 为所有桌面用户创建桌面图标，并清理旧名桌面图标 ===
if [ -f "$DESKTOP_FILE" ]; then
  STALE_DESKTOP_NAMES="youdu-local.desktop YouduLocal.desktop"
  copy_to_dir() {
    local user_desktop_dir="$1"
    [ -d "$user_desktop_dir" ] || return 0
    local target="$user_desktop_dir/youdu.desktop"
    cp -f "$DESKTOP_FILE" "$target"
    chmod 644 "$target"
    local owner
    owner="$(stat -c '%U:%G' "$user_desktop_dir" 2>/dev/null || true)"
    [ -n "$owner" ] && chown "$owner" "$target" 2>/dev/null || true
    for stale_name in $STALE_DESKTOP_NAMES; do
      if [ -f "$user_desktop_dir/$stale_name" ]; then
        rm -f "$user_desktop_dir/$stale_name"
      fi
    done
    return 0
  }

  for home_dir in /home/*; do
    copy_to_dir "$home_dir/Desktop"
    copy_to_dir "$home_dir/桌面"
  done

  # sudo 安装时的调用用户
  if [ -n "$SUDO_USER" ]; then
    sudo_home=$(getent passwd "$SUDO_USER" | cut -d: -f6)
    if [ -n "$sudo_home" ] && [ -d "$sudo_home" ]; then
      copy_to_dir "$sudo_home/Desktop"
      copy_to_dir "$sudo_home/桌面"
    fi
  fi
fi

echo "[postinst] 幽读安装完成：图标缓存已刷新，桌面快捷方式已创建"
exit 0
