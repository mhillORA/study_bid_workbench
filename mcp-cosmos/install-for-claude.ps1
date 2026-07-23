# One-click Claude Desktop setup for SBW Cosmos MCP (Windows).
# Other person needs: Node.js 20+, this repo's mcp-cosmos folder, and Cosmos URI + key from you.
# Usage: right-click → Run with PowerShell  (or: powershell -ExecutionPolicy Bypass -File .\install-for-claude.ps1)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

Write-Host "SBW Cosmos MCP — Claude Desktop installer" -ForegroundColor Cyan
Write-Host "Folder: $here"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Install Node.js 20+ from https://nodejs.org then run this again." -ForegroundColor Red
  exit 1
}

Write-Host "Installing packages..."
npm install --silent

$endpoint = Read-Host "Paste COSMOS_ENDPOINT (URI)"
$key = Read-Host "Paste COSMOS_KEY"
$db = Read-Host "Database name [bd-budgets]"
if (-not $db) { $db = "bd-budgets" }

if (-not $endpoint -or -not $key) {
  Write-Host "Endpoint and key are required." -ForegroundColor Red
  exit 1
}

$indexJs = (Resolve-Path (Join-Path $here "index.js")).Path
$claudeDir = Join-Path $env:APPDATA "Claude"
$claudeConfig = Join-Path $claudeDir "claude_desktop_config.json"
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null

$config = @{ mcpServers = @{} }
if (Test-Path $claudeConfig) {
  try {
    $config = Get-Content $claudeConfig -Raw | ConvertFrom-Json -AsHashtable
  } catch {
    $config = @{ mcpServers = @{} }
  }
}
if (-not $config.mcpServers) { $config.mcpServers = @{} }

$config.mcpServers["sbw-cosmos"] = @{
  command = "node"
  args    = @($indexJs)
  env     = @{
    COSMOS_ENDPOINT = $endpoint.Trim()
    COSMOS_KEY      = $key.Trim()
    COSMOS_DATABASE = $db.Trim()
  }
}

$config | ConvertTo-Json -Depth 8 | Set-Content -Path $claudeConfig -Encoding UTF8

Write-Host ""
Write-Host "Done. Wrote: $claudeConfig" -ForegroundColor Green
Write-Host "1) Fully quit Claude Desktop (tray too)"
Write-Host "2) Reopen Claude"
Write-Host "3) Ask: List studies in Cosmos"
Write-Host ""
Write-Host "If it fails with a firewall error, Matt must allow your IP on Cosmos Networking." -ForegroundColor Yellow
