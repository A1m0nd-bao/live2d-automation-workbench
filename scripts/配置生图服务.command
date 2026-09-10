#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="${0:A:h}"
/usr/bin/python3 "$SCRIPT_DIR/configure-prep-key.py"
read '?按回车关闭…'
