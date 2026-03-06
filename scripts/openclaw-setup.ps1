param(
  [string]$AgentsPath = "",
  [int]$Port = 0,
  [string]$OpenClawConfig = "",
  [switch]$Start
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $rootDir

function Assert-LastExitCode {
  param(
    [string]$Action
  )

  if ($LASTEXITCODE -ne 0) {
    throw "[Claw-Empire] $Action failed with exit code $LASTEXITCODE."
  }
}

if (!(Test-Path "package.json") -or !(Test-Path "scripts/setup.mjs")) {
  throw "Run this script from the Claw-Empire repository."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22+ is required. Install from https://nodejs.org/"
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) {
  throw "Node.js 22+ is required. Current: $(node -v)"
}

if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
  throw "corepack is required (bundled with Node.js)."
}

corepack enable | Out-Null
Assert-LastExitCode "corepack enable"
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  corepack prepare pnpm@latest --activate | Out-Null
  Assert-LastExitCode "corepack prepare pnpm@latest --activate"
}

Write-Host "[Claw-Empire] Installing dependencies..."
pnpm install
Assert-LastExitCode "pnpm install"

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "[Claw-Empire] Created .env from .env.example"
}

$resolvedOpenClaw = ""
if ([string]::IsNullOrWhiteSpace($OpenClawConfig)) {
  $defaultOpenClaw = Join-Path $HOME ".openclaw/openclaw.json"
  if (Test-Path $defaultOpenClaw) {
    $resolvedOpenClaw = (Resolve-Path $defaultOpenClaw).Path
  }
} else {
  $candidate = $OpenClawConfig
  if ($candidate.StartsWith("~")) {
    $candidate = $candidate.Replace("~", $HOME)
  }
  if (Test-Path $candidate) {
    $resolvedOpenClaw = (Resolve-Path $candidate).Path
  } else {
    Write-Warning "[Claw-Empire] OPENCLAW config not found at $candidate. Keeping path for later."
    $resolvedOpenClaw = $candidate
  }
}

if ($Port -gt 0) {
  $env:CLAW_SETUP_PORT = $Port.ToString()
} else {
  Remove-Item Env:CLAW_SETUP_PORT -ErrorAction SilentlyContinue
}

if ($resolvedOpenClaw) {
  $env:CLAW_SETUP_OPENCLAW = $resolvedOpenClaw.Replace("\", "/")
} else {
  Remove-Item Env:CLAW_SETUP_OPENCLAW -ErrorAction SilentlyContinue
}

$envPatchScript = @'
const fs = require("node:fs");
const crypto = require("node:crypto");

const envPath = ".env";
let content = fs.readFileSync(envPath, "utf8");

function upsert(key, value) {
  const line = `${key}=${value}`;
  const active = new RegExp(`^${key}\\s*=.*$`, "m");
  const commented = new RegExp(`^#\\s*${key}\\s*=.*$`, "m");
  if (active.test(content)) {
    content = content.replace(active, line);
    return;
  }
  if (commented.test(content)) {
    content = content.replace(commented, line);
    return;
  }
  if (!content.endsWith("\n")) content += "\n";
  content += `${line}\n`;
}

function read(key) {
  const match = content.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, "m"));
  if (!match) return "";
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

const currentSecret = read("OAUTH_ENCRYPTION_SECRET");
if (!currentSecret || currentSecret === "__CHANGE_ME__") {
  const generated = crypto.randomBytes(32).toString("hex");
  upsert("OAUTH_ENCRYPTION_SECRET", `"${generated}"`);
  console.log("[Claw-Empire] Generated OAUTH_ENCRYPTION_SECRET");
}

const currentInboxSecret = read("INBOX_WEBHOOK_SECRET");
if (!currentInboxSecret || currentInboxSecret === "__CHANGE_ME__") {
  const generatedInbox = crypto.randomBytes(32).toString("hex");
  upsert("INBOX_WEBHOOK_SECRET", `"${generatedInbox}"`);
  console.log("[Claw-Empire] Generated INBOX_WEBHOOK_SECRET");
}

const port = process.env.CLAW_SETUP_PORT?.trim();
if (port) {
  upsert("PORT", port);
  console.log(`[Claw-Empire] Set PORT=${port}`);
}

const openclaw = process.env.CLAW_SETUP_OPENCLAW?.trim();
if (openclaw) {
  const normalized = openclaw.replace(/\\/g, "/");
  upsert("OPENCLAW_CONFIG", `"${normalized}"`);
  console.log(`[Claw-Empire] Set OPENCLAW_CONFIG=${normalized}`);
}

fs.writeFileSync(envPath, content, "utf8");
'@
$envPatchScript | node -
Assert-LastExitCode "patch .env"

Remove-Item Env:CLAW_SETUP_PORT -ErrorAction SilentlyContinue
Remove-Item Env:CLAW_SETUP_OPENCLAW -ErrorAction SilentlyContinue

$portToUse = $Port
if ($portToUse -le 0) {
  $portLine = Select-String -Path ".env" -Pattern "^\s*PORT\s*=" | Select-Object -First 1
  if ($portLine) {
    $rawPort = ($portLine.Line -split "=")[1].Trim().Trim('"').Trim("'")
    if ($rawPort -match "^\d+$") {
      $portToUse = [int]$rawPort
    }
  }
}
if ($portToUse -le 0) {
  $portToUse = 8790
}

$setupArgs = @("setup", "--", "--port", $portToUse.ToString())
if ($AgentsPath) {
  $setupArgs += @("--agents-path", $AgentsPath)
}

Write-Host "[Claw-Empire] Installing AGENTS.md orchestration rules..."
& pnpm @setupArgs
Assert-LastExitCode "pnpm setup"

Write-Host ""
Write-Host "[Claw-Empire] Setup complete."
Write-Host "Frontend: http://127.0.0.1:8800"
Write-Host "API:      http://127.0.0.1:$portToUse/healthz"

if ($Start) {
  Write-Host "[Claw-Empire] Starting development server..."
  pnpm dev:local
  exit $LASTEXITCODE
}

Write-Host "Run 'pnpm dev:local' to start."
