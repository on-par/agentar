#!/usr/bin/env bash
# Double-click in Finder to start Agentar. See agentar-start.sh.
"$(dirname "$0")/agentar-start.sh" || {
  echo
  read -r -p "Agentar did not start. Press Enter to close this window." _
}
