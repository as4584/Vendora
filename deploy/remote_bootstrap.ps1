param(
    [string]$HostAlias = "vendora",
    [string]$AppDir = "/opt/vendora",
    [string]$RepoUrl = "https://github.com/as4584/Vendora.git",
    [string]$Branch = "sprint-5-lightspeed-deploy",
    [string]$RemoteUser = "vendora",
    [switch]$SkipInteractive
)

# Ensure ssh is available before continuing.
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Error "ssh command is not available in PATH." -ErrorAction Stop
}

$script = @"
APP_DIR='$AppDir'
REPO_URL='$RepoUrl'
BRANCH='$Branch'
REMOTE_USER='$RemoteUser'

if [ ! -d "${APP_DIR}/.git" ]; then
  sudo rm -rf "$APP_DIR"
  sudo mkdir -p "$APP_DIR"
  sudo chown "${REMOTE_USER}:${REMOTE_USER}" "$APP_DIR"
  git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch --all
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
fi

cd "$APP_DIR"
sudo bash deploy/server_bootstrap.sh
"@

# Normalize line endings for bash compatibility.
$normalizedScript = $script -replace "`r`n", "`n"

# Run the remote bootstrap commands via ssh.
$normalizedScript | ssh $HostAlias "bash -s" | Write-Output

if (-not $SkipInteractive) {
    Write-Host "Opening interactive SSH session (press Ctrl+D or exit to leave)..." -ForegroundColor Cyan
    ssh $HostAlias
}
