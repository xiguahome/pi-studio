#!/usr/bin/env bash
# =====================================================================
#  macOS 桌面端打包脚本（pi-studio）
#
#  用法（在 macOS 终端执行）：
#      bash packaging/build-mac.sh
#
#  说明：macOS 家目录默认可读，next build 不会遇到 Windows 上那种
#  "扫描系统级不可读目录" 的问题，因此无需重定向家目录。
#
#  本地自测用未签名构建（CSC_IDENTITY_AUTO_DISCOVERY=false）；
#  正式分发时移除该环境变量并配置 Developer ID 证书。
# =====================================================================
set -euo pipefail

# 项目根目录（脚本位于 packaging/，上一级即为项目根）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 本地未签名构建：跳过 macOS 代码签名（分发时再配置证书）
export CSC_IDENTITY_AUTO_DISCOVERY=false

# 若日后在 Mac 上也遇到 next build 扫描家目录报错，取消下面两行注释：
# export HOME="$ROOT/.buildhome"
# mkdir -p "$HOME"

# 清掉 dev / 上次构建残留，避免 .next 被污染
rm -rf .next

echo "[build] 开始打包 macOS 安装包（dmg + zip，x64 & arm64）..."
npm run desktop:dist

echo "[build] 完成 ✅  上传这两个文件到更新服务器："
echo "        dist-desktop/pi-studio-*.dmg（或 zip）"
echo "        dist-desktop/latest.json（已自动生成，记得先改 releaseNotes）"
