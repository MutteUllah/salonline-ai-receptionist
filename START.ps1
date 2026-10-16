$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$salonNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $salonNode) {
  $salonBundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $salonBundledNode) { $salonNode = $salonBundledNode }
  else { throw 'Install Node.js 24 or newer, then run this script again.' }
}
if (-not (Test-Path -LiteralPath 'node_modules')) {
  if (Get-Command pnpm -ErrorAction SilentlyContinue) { & pnpm install --frozen-lockfile }
  elseif (Get-Command npm -ErrorAction SilentlyContinue) { & npm install }
  else {
    $salonBundledPnpm = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
    if (Test-Path -LiteralPath $salonBundledPnpm) { & $salonBundledPnpm install --frozen-lockfile }
    else { throw 'Install npm or pnpm to install the project dependencies.' }
  }
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
& $salonNode scripts/setup.mjs
& $salonNode --env-file-if-exists=.env server/index.mjs
