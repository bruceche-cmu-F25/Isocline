#!/bin/sh
# Stands in for /usr/bin/say. `-v ?` lists voices; otherwise writes a small WAV to the -o path whose data is the
# text read from stdin and the arguments, so a test can see what was asked for. A text of "fail" fails.
if [ "$1" = "-v" ] && [ "$2" = "?" ]; then
  printf 'Tingting             zh_CN    # 你好！我叫婷婷。\n'
  printf 'Flo (Chinese (China mainland)) zh_CN    # 你好！我叫Flo。\n'
  printf 'Meijia              zh_TW    # 你好，我叫美佳。\n'
  printf 'Eddy (Chinese (China mainland)) zh_CN    # 你好！我叫Eddy。\n'
  printf 'Samantha            en_US    # Hello! My name is Samantha.\n'
  printf 'Daniel              en_GB    # Hello! My name is Daniel.\n'
  printf 'Bubbles             en_US    # Hello! My name is Bubbles.\n'
  exit 0
fi
out=""; args="$*"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
text=$(cat)
[ "$text" = "fail" ] && { echo "cannot say that" >&2; exit 1; }
printf 'RIFF....WAVE%s|%s' "$args" "$text" > "$out"
