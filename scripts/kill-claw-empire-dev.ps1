param(
  [string]$RepoDir = ""
)

$ErrorActionPreference = "SilentlyContinue"

function Normalize-PathText([string]$Value) {
  if (-not $Value) { return "" }
  return $Value.Replace("/", "\").Trim().ToLowerInvariant()
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $RepoDir) {
  $RepoDir = Split-Path -Parent $scriptDir
}

$resolvedRepoDir = Resolve-Path -LiteralPath $RepoDir -ErrorAction SilentlyContinue
$normalizedRepoDir = if ($resolvedRepoDir) {
  Normalize-PathText($resolvedRepoDir.Path)
} else {
  Normalize-PathText($RepoDir)
}

$targets = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {
  $cmd = [string]$_.CommandLine
  if (-not $cmd) { return $false }

  $normalizedCmd = Normalize-PathText($cmd)
  if (-not $normalizedRepoDir -or -not $normalizedCmd.Contains($normalizedRepoDir)) {
    return $false
  }

  return (
    $normalizedCmd -match 'concurrently\\dist\\bin\\concurrently\.js' -or
    $normalizedCmd -match 'nodemon\\bin\\nodemon\.js' -or
    $normalizedCmd -match 'vite\\bin\\vite\.js' -or
    $normalizedCmd -match 'cross-env\\src\\bin\\cross-env\.js' -or
    $normalizedCmd -match 'tsx\\dist\\cli\.mjs"\s+server/index\.ts' -or
    $normalizedCmd -match 'corepack\\dist\\corepack\.js"\s+pnpm\s+dev:local'
  )
}

foreach ($p in $targets) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
