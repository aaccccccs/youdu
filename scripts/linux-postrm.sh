#!/bin/bash
# 幽读（Youdu）Linux deb 卸载后脚本
#
# 数据策略（用户拍板 2026-10-20）：
#   普通卸载/升级（remove / disappear / upgrade）：
#     不碰用户数据（书库、配置、阅读进度全部保留）。
#     仅清理各用户桌面上的启动器副本（系统启动器由 dpkg 自动清除）。
#   彻底清除（purge，dpkg -P）：
#     删除全部用户的幽读数据（书库 + 配置），卸载即清空：
#       ~/.config/youdu、~/.config/youdu-local、~/.config/YouduLocal、
#       ~/.config/幽读本地版（新规范目录 + 0.2.x 及更早配置）、
#       ~/.local/share/youdu（XDG 数据目录，0.2.x 末起书库存放位置）
#     删除遗留在安装位置旁的旧版书库：
#       /opt/YouduLocal、/opt/幽读本地版、/opt/youdu-local
#     清理各用户桌面的 youdu 启动器副本。
#
# 已知坑（记录备查）：
#   Deepin 深度安装器「同版本换装」内部流程是 remove → purge → install，
#   会触发本脚本的 purge 分支清空书库（2026-10-20 实际发生）。
#   正常升级（版本号递增，如 0.2.0 → 0.2.1）走 upgrade 路径，不删数据。
#   因此：发布版本号必须递增；避免用深度安装器重装同版本包。
#
# 设计要点：
#   - 升级（upgrade）路径绝不能删数据，任何分支末尾都正常退出，
#     避免因清理失败导致 dpkg 卸载/升级中断。

action="$1"

# 清理所有普通用户桌面/启动器副本（系统 /usr/share/applications 由 dpkg 管）
clean_user_launchers() {
  local home_dir desktop_dir
  for home_dir in /home/* /root; do
    [ -d "$home_dir" ] || continue
    for desktop_dir in "$home_dir/Desktop" "$home_dir/桌面"; do
      [ -d "$desktop_dir" ] || continue
      rm -f "$desktop_dir/youdu.desktop" \
            "$desktop_dir/youdu-local.desktop" \
            "$desktop_dir/YouduLocal.desktop" 2>/dev/null || true
    done
  done
}

# 彻底清除：删除全部用户数据与历史书库
purge_all_data() {
  local home_dir cfg_dir
  for home_dir in /home/* /root; do
    [ -d "$home_dir" ] || continue
    for cfg_dir in "$home_dir/.config/youdu" \
                   "$home_dir/.config/youdu-local" \
                   "$home_dir/.config/YouduLocal" \
                   "$home_dir/.config/幽读本地版" \
                   "$home_dir/.local/share/youdu"; do
      if [ -e "$cfg_dir" ] || [ -L "$cfg_dir" ]; then
        rm -rf "$cfg_dir" 2>/dev/null || true
      fi
    done
  done

  # 安装目录旁的历代书库（非 dpkg 管辖，普通卸载不会删除）
  local legacy_lib
  for legacy_lib in "/opt/YouduLocal" \
                    "/opt/幽读本地版" \
                    "/opt/youdu-local"; do
    [ -e "$legacy_lib" ] || [ -L "$legacy_lib" ] || continue
    echo "[postrm] 正在删除旧版书库: $legacy_lib"
    rm -rf "$legacy_lib" 2>/dev/null || true
  done
}

case "$action" in
  purge)
    clean_user_launchers
    purge_all_data
    echo "[postrm] 幽读已彻底清除：书库与配置已全部删除"
    ;;
  remove|disappear)
    # 普通卸载：保留书库与配置，仅移除桌面启动器副本
    clean_user_launchers
    ;;
  upgrade|failed-upgrade|abort-install|abort-upgrade)
    # 升级相关：数据与启动器都不动（桌面副本由新版 postinst 维护）
    :
    ;;
  *)
    :
    ;;
esac

exit 0
