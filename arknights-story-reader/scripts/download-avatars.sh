#!/bin/bash
# 批量下载默认头像到 public/bundled/avatar/
# 使用方式: bash scripts/download-avatars.sh

DEST="$(dirname "$0")/../public/bundled/avatar"
BASE="https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar"
LIST="/tmp/avatar_list.txt"

mkdir -p "$DEST"

total=$(wc -l < "$LIST")
count=0

while IFS= read -r path; do
  filename=$(basename "$path")
  count=$((count + 1))
  if [ -f "$DEST/$filename" ]; then
    continue
  fi
  curl -sL "$BASE/$filename" -o "$DEST/$filename" &
  # 并发 10 个
  if (( count % 10 == 0 )); then
    wait
    printf "\r  %d / %d" "$count" "$total"
  fi
done < "$LIST"
wait
printf "\r  %d / %d done\n" "$total" "$total"
