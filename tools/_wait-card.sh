#!/usr/bin/env bash
# Wait for the GPU to be free and *stay* free before taking it.
#
# Being third in the queue means the card going quiet once is not my turn — the
# system ahead of me may not have claimed it yet. So require a continuous idle
# window before returning, which lets the next in line grab it first if they are
# ready. Idle is "no Playwright-launched chrome.exe": the preview servers these
# probes run are cheap, the card is what is scarce.
set -u
NEED="${1:-90}"
STEP=15
MAX="${2:-3600}"
free_for=0
waited=0
while [ "$waited" -lt "$MAX" ]; do
  n=$(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*ms-playwright*' } | Measure-Object | Select-Object -ExpandProperty Count" 2>/dev/null | tr -d '\r\n ')
  [ -z "$n" ] && n=0
  if [ "$n" = "0" ]; then
    free_for=$((free_for + STEP))
  else
    if [ "$free_for" -gt 0 ]; then echo "[wait] card taken again after ${free_for}s idle ($n procs)"; fi
    free_for=0
  fi
  if [ "$free_for" -ge "$NEED" ]; then
    echo "[wait] card idle ${free_for}s after waiting ${waited}s — taking it"
    exit 0
  fi
  sleep "$STEP"
  waited=$((waited + STEP))
done
echo "[wait] gave up after ${MAX}s with the card still busy"
exit 1
