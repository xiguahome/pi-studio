#!/usr/bin/env bash
# =====================================================================
#  Linux 桌面端打包脚本（pi-studio）
#
#  用法（在 Linux 终端执行）：
#      bash packaging/build-linux.sh
#
#  说明：Linux 家目录默认可读，next build 不会遇到 Windows 上那种
#  "扫描系统级不可读目录" 的问题，因此无需重定向家目录。
#
#  产物：AppImage（便携可执行）+ deb（Debian/Ubuntu 包），
#  具体见 electron-builder.yml 的 linux 配置（category: Development）。
#
#  本地自测无需签名（AppImage / deb 均不强制签名）；
#  正式分发时按需配置仓库签名 / GPG。
#
#  前置依赖（部分发行版需自行安装）：
#    - 构建 AppImage 由 electron-builder 自动下载 appimagetool，无需手动装。
#    - 构建 deb 一般无需额外工具。
#    - 运行生成的 AppImage / deb 需要系统具备 libgtk-3、libnss3、
#      libasound2 等常见库（与运行任何 Electron 应用一致）。
# =====================================================================
set -euo pipefail

# 项目根目录（脚本位于 packaging/，上一级即为项目根）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 若日后在 Linux 上也遇到 next build 扫描家目录报错，取消下面两行注释：
# export HOME="$ROOT/.buildhome"
# mkdir -p "$HOME"

# 清掉 dev / 上次构建残留，避免 .next / dist-desktop（含 win-unpacked 等
# 中间产物）影响本次干净打包
rm -rf .next dist-desktop

echo "[build] 开始打包 Linux 安装包（AppImage + deb）..."
npm run desktop:dist

echo "[build] 完成 ✅  上传这两个文件到更新服务器："
echo "        dist-desktop/pi-studio-*.AppImage（或 deb）"
echo "        dist-desktop/latest.json（已自动生成，记得先改 releaseNotes）"
