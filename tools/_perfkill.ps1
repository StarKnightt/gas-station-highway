# Kill only the processes this agent started: node running tools/perf.mjs, and
# any Chromium whose command line names the private profile Playwright made for
# it. Matching on the command line and never on the image name is deliberate —
# seven sibling agents and the user's MCP servers are also node.exe, and a broad
# `taskkill /im node.exe` would take all of them out.
param([switch]$List)

$targets = @()
$targets += Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*tools/perf.mjs*' -or $_.CommandLine -like '*tools\perf.mjs*' }

foreach ($t in $targets) {
  $cl = $t.CommandLine
  if ($cl.Length -gt 100) { $cl = $cl.Substring(0, 100) }
  Write-Output ("{0}  {1}  {2}" -f $t.ProcessId, $t.Name, $cl)
  if (-not $List) { Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue }
}
if ($targets.Count -eq 0) { Write-Output "no perf.mjs processes" }
