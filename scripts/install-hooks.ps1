<#
.SYNOPSIS
    Installs Vendora's Git pre-push hook and checks prerequisites.
.DESCRIPTION
    - Configures git to use the committed .hooks/ directory
    - Verifies act and Docker Desktop are available
    - Guides you through creating your .act.secrets file
.EXAMPLE
    .\scripts\install-hooks.ps1
#>

$ErrorActionPreference = "Stop"

$CYAN   = "`e[96m"
$GREEN  = "`e[92m"
$RED    = "`e[91m"
$YELLOW = "`e[93m"
$NC     = "`e[0m"

function Write-Banner { Write-Host "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}" }

Write-Banner
Write-Host "${CYAN}  Vendora — installing pre-push hook${NC}"
Write-Banner

# ── Move to repo root ─────────────────────────────────────────────────────────
$repoRoot = git rev-parse --show-toplevel 2>$null
if (-not $repoRoot) {
    Write-Host "${RED}❌  Not inside a Git repository.${NC}"
    exit 1
}
Set-Location $repoRoot

# ── Check: act ────────────────────────────────────────────────────────────────
if (-not (Get-Command act -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "${YELLOW}⚠️   'act' is not installed.${NC}"
    Write-Host "     Install it now?  (requires winget)"
    $choice = Read-Host "     [Y/n]"
    if ($choice -ne 'n' -and $choice -ne 'N') {
        winget install nektos.act
    } else {
        Write-Host "${RED}     'act' is required. Install from https://nektosact.com/installation/${NC}"
        exit 1
    }
} else {
    Write-Host "${GREEN}✅  act found:  $(act --version)${NC}"
}

# ── Check: Docker ─────────────────────────────────────────────────────────────
$dockerOk = $false
try {
    $null = docker info 2>$null
    $dockerOk = $true
} catch {}

if (-not $dockerOk) {
    Write-Host ""
    Write-Host "${YELLOW}⚠️   Docker is not running (or not installed).${NC}"
    Write-Host "     The pre-push hook needs Docker Desktop to run containers."
    Write-Host "     Download: https://www.docker.com/products/docker-desktop/"
} else {
    Write-Host "${GREEN}✅  Docker Desktop is running.${NC}"
}

# ── Configure Git to use .hooks/ ──────────────────────────────────────────────
git config core.hooksPath .hooks
Write-Host "${GREEN}✅  Git hooks path set to .hooks/${NC}"

# ── Secrets file ──────────────────────────────────────────────────────────────
$secretsFile = Join-Path $repoRoot ".act.secrets"
if (-not (Test-Path $secretsFile)) {
    Copy-Item (Join-Path $repoRoot ".act.secrets.example") $secretsFile
    Write-Host ""
    Write-Host "${YELLOW}📝  Created .act.secrets from example.${NC}"
    Write-Host "    Edit it and add your real Expo token:"
    Write-Host "    ${CYAN}notepad .act.secrets${NC}"
    Write-Host "    Token source: https://expo.dev/accounts/lexmakesit/settings/access-tokens"
} else {
    Write-Host "${GREEN}✅  .act.secrets already exists.${NC}"
}

Write-Host ""
Write-Banner
Write-Host "${GREEN}  Hook installed! Every 'git push' will now run CI locally first.${NC}"
Write-Host ""
Write-Host "  What happens on push:"
Write-Host "    1. Detects changed paths (mobile/ or backend/)"
Write-Host "    2. Runs matching GitHub Actions jobs via act + Docker"
Write-Host "    3. Blocks the push if any job fails"
Write-Host ""
Write-Host "  To bypass in emergencies:  git push --no-verify"
Write-Banner
