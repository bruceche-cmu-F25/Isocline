#!/bin/sh
# Git calls reference-transaction under its ref locks, after pre-commit/commit-msg hooks have run.
# Check the actual commit object before the branch moves. Preserve stdin for the repository's own hook.
set -eu
cat > "$ZIRMA_REF_INPUT"
if [ "$1" = prepared ]; then
  while read -r old new ref; do
    case "$ref" in
      HEAD|"$ZIRMA_REF")
        if [ "$old" != "$ZIRMA_PARENT" ] || [ "$(git rev-parse "$new^{tree}")" != "$ZIRMA_TREE" ]; then
          touch "$ZIRMA_STALE"
          exit 1
        fi
        printf '%s' "$new" > "$ZIRMA_REVISION"
        ;;
    esac
  done < "$ZIRMA_REF_INPUT"
fi
if [ -x "$ZIRMA_HOOKS/reference-transaction" ]; then
  exec "$ZIRMA_HOOKS/reference-transaction" "$@" < "$ZIRMA_REF_INPUT"
fi
