$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $root 'src'
$dist = Join-Path $root 'dist'
$output = Join-Path $dist 'BCMapSaver.user.js'
$parts = @(
  '00-userscript-header.js',
  '01-runtime.js',
  '02-storage.js',
  '03-exchange.js',
  '04-map-bridge.js',
  '05-ui.js',
  '06-bootstrap.js'
)
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$content = [System.Text.StringBuilder]::new()
foreach ($part in $parts) {
  $path = Join-Path $source $part
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing source file: $part" }
  [void]$content.AppendLine((Get-Content -LiteralPath $path -Raw -Encoding UTF8))
  [void]$content.AppendLine("`n")
}
[System.IO.File]::WriteAllText($output, $content.ToString(), [System.Text.UTF8Encoding]::new($false))
Write-Host "Built: $output"
