#!/bin/sh
# Git calls reference-transaction under its ref locks, after pre-commit/commit-msg hooks have run.
# Check the actual commit object before the branch moves. Preserve stdin for the repository's own hook.
set -eu
cat > "$ISOCLINE_REF_INPUT"
if [ "$1" = prepared ]; then
  while read -r old new ref; do
    case "$ref" in
      HEAD|"$ISOCLINE_REF")
        if [ "$old" != "$ISOCLINE_PARENT" ] || [ "$(git rev-parse "$new^{tree}")" != "$ISOCLINE_TREE" ]; then
          touch "$ISOCLINE_STALE"
          exit 1
        fi
        printf '%s' "$new" > "$ISOCLINE_REVISION"
        ;;
    esac
  done < "$ISOCLINE_REF_INPUT"
fi
if [ -x "$ISOCLINE_HOOKS/reference-transaction" ]; then
  exec "$ISOCLINE_HOOKS/reference-transaction" "$@" < "$ISOCLINE_REF_INPUT"
fi
