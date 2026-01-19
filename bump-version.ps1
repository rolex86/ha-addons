param(
  [string]$AddonPath = "",         # např. "presence-ssh-mqtt" nebo prázdné = všechny add-ony
  [switch]$Commit,
  [switch]$Push
)

function Bump-Patch([string]$ver) {
  if ($ver -notmatch '^(\d+)\.(\d+)\.(\d+)$') { throw "Unexpected version format: $ver" }
  $maj = [int]$matches[1]; $min = [int]$matches[2]; $pat = [int]$matches[3]
  return "$maj.$min." + ($pat + 1)
}

$targets = @()
if ([string]::IsNullOrWhiteSpace($AddonPath)) {
  $targets = Get-ChildItem -Directory | ForEach-Object { Join-Path $_.FullName "config.yaml" } | Where-Object { Test-Path $_ }
} else {
  $cfg = Join-Path (Resolve-Path $AddonPath) "config.yaml"
  if (!(Test-Path $cfg)) { throw "config.yaml not found at: $cfg" }
  $targets = @($cfg)
}

$changed = @()

foreach ($cfg in $targets) {
  $txt = Get-Content $cfg -Raw
  if ($txt -notmatch '(?m)^\s*version:\s*"?(\d+\.\d+\.\d+)"?\s*$') { continue }
  $old = $matches[1]
  $new = Bump-Patch $old
  $txt2 = [regex]::Replace($txt, '(?m)^(\s*version:\s*")?(\d+\.\d+\.\d+)("?\s*)$', { param($m)
      # zachovej uvozovky / mezery
      $prefix = $m.Groups[1].Value
      $suffix = $m.Groups[3].Value
      return ($prefix + $new + $suffix)
    }, 1)
  Set-Content -Path $cfg -Value $txt2 -Encoding UTF8
  Write-Host "Bumped $cfg : $old -> $new"
  $changed += $cfg
}

if ($changed.Count -eq 0) {
  Write-Host "No config.yaml files updated."
  exit 0
}

if ($Commit) {
  git add $changed
  git commit -m "Bump add-on version(s)"
  if ($Push) { git push }
}
