#!/usr/bin/env bash
# 下载 Qwen2.5-1.5B-Instruct（Q4_K_M）GGUF 到工程根目录的 models/。
#
# 用法：
#   bash server/download-model.sh            # 已存在则跳过
#   bash server/download-model.sh --force    # 强制重新下载
#
# 下载源：https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF
# 国内网络慢时可以走镜像（huggingface-cli 和 curl 都认这个环境变量）：
#   HF_ENDPOINT=https://hf-mirror.com bash server/download-model.sh
#
# 优先用 huggingface-cli（或新版 hf 命令）下载，失败自动回退到 curl。
# curl 带 -C - 断点续传，中断后重新运行本脚本即可。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODELS_DIR="$ROOT_DIR/models"

REPO="bartowski/Qwen2.5-1.5B-Instruct-GGUF"
FILE="Qwen2.5-1.5B-Instruct-Q4_K_M.gguf"
TARGET="$MODELS_DIR/$FILE"

HF_ENDPOINT="${HF_ENDPOINT:-https://huggingface.co}"
HF_ENDPOINT="${HF_ENDPOINT%/}"
URL="$HF_ENDPOINT/$REPO/resolve/main/$FILE"

FORCE=0
case "${1:-}" in
  --force|-f) FORCE=1 ;;
  "") ;;
  *) echo "未知参数：$1（可用参数：--force）" >&2; exit 2 ;;
esac

mkdir -p "$MODELS_DIR"

if [ -f "$TARGET" ] && [ "$FORCE" -ne 1 ]; then
  SIZE="$(wc -c < "$TARGET" | tr -d '[:space:]')"
  echo "模型已经在了：$TARGET"
  echo "大小：$SIZE 字节"
  echo "想重新下载就加 --force。"
  exit 0
fi

if [ "$FORCE" -eq 1 ] && [ -f "$TARGET" ]; then
  echo "已删除旧文件：$TARGET"
  rm -f "$TARGET"
fi

echo "=============================================="
echo " 下载 Qwen2.5-1.5B-Instruct Q4_K_M（约 1 GB）"
echo " 仓库：$REPO"
echo " 文件：$FILE"
echo " 保存：$TARGET"
echo "=============================================="

try_huggingface_cli() {
  local cli=""
  if command -v huggingface-cli >/dev/null 2>&1; then
    cli="huggingface-cli"
  elif command -v hf >/dev/null 2>&1; then
    cli="hf"
  else
    echo "没有找到 huggingface-cli，直接用 curl。"
    return 1
  fi

  echo "[1/2] 用 $cli 下载…"
  if "$cli" download "$REPO" "$FILE" --local-dir "$MODELS_DIR"; then
    if [ -f "$TARGET" ]; then
      return 0
    fi
    echo "$cli 跑完了，但没在 $TARGET 看到文件，回退到 curl。"
  else
    echo "$cli 下载失败，回退到 curl。"
  fi
  return 1
}

if try_huggingface_cli; then
  echo "huggingface-cli 下载完成。"
else
  if ! command -v curl >/dev/null 2>&1; then
    echo "错误：没有找到 curl，也没有可用的 huggingface-cli。" >&2
    echo "先安装 curl：apt-get update && apt-get install -y curl" >&2
    echo "或者安装 huggingface-cli：pip install -U 'huggingface_hub[cli]'" >&2
    exit 1
  fi
  echo "[2/2] 用 curl 下载（支持断点续传，中断后重新运行本脚本即可）…"
  curl -fL -C - --retry 3 --retry-delay 2 -o "$TARGET" "$URL"
fi

if [ ! -s "$TARGET" ]; then
  echo "错误：下载完成后文件不存在或是空的：$TARGET" >&2
  echo "请重新运行：bash server/download-model.sh" >&2
  exit 1
fi

SIZE="$(wc -c < "$TARGET" | tr -d '[:space:]')"
# Q4_K_M 大约 1 GB；小于 500 MB 基本可以断定没下完
if [ "$SIZE" -lt 500000000 ]; then
  echo "警告：文件只有 $SIZE 字节，可能没有下载完整。" >&2
  echo "重新运行本脚本可以断点续传，或加 --force 从头下载。" >&2
  exit 1
fi

echo ""
echo "下载完成：$TARGET"
echo "大小：$SIZE 字节"
echo "启动服务：python3 server/server.py"
