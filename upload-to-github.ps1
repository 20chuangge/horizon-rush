# Horizon Rush - publish to GitHub and enable GitHub Pages
# Usage: right-click "upload-to-github.ps1" -> Run with PowerShell
#   or: powershell -NoProfile -ExecutionPolicy Bypass -File .\upload-to-github.ps1
# Optional:
#   .\upload-to-github.ps1 -RepoName horizon-rush
param(
  [string]$RepoName = "horizon-rush",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDir

function Stop-Here([string]$Message) {
  Write-Host ""
  Write-Host "ERROR: $Message" -ForegroundColor Red
  Write-Host ""
  [void](Read-Host "Press Enter to exit")
  exit 1
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  HORIZON RUSH -> GitHub + GitHub Pages" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "Project folder : $ProjectDir"
Write-Host "Repo name      : $RepoName"
Write-Host "Branch         : $Branch"
Write-Host ""

if (-not (Test-Path (Join-Path $ProjectDir "index.html"))) {
  Stop-Here "index.html not found. Please put this script in the horizon-rush folder."
}

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
  Stop-Here "Git is not installed. Install Git for Windows first: https://git-scm.com/download/win"
}
Write-Host ("Git: " + ((git --version) -join ' '))

# ---------- 1) init local repo + commit ----------
$hasGitDir = Test-Path (Join-Path $ProjectDir ".git")
if (-not $hasGitDir) {
  Write-Host "Initializing git repository ..." -ForegroundColor Yellow
  git init -b $Branch
  if ($LASTEXITCODE -ne 0) {
    git init
    if ($LASTEXITCODE -ne 0) { Stop-Here "git init failed." }
    git branch -M $Branch
  }
}

$userName = (git config user.name) 2>$null
if (-not $userName) {
  git config user.name $env:USERNAME
  Write-Host "Set local git user.name = $env:USERNAME" -ForegroundColor Yellow
}
$userEmail = (git config user.email) 2>$null
if (-not $userEmail) {
  git config user.email ("$env:USERNAME" + "@users.noreply.github.com")
  Write-Host "Set local git user.email (only for commit author)" -ForegroundColor Yellow
}

git add -A
if ($LASTEXITCODE -ne 0) { Stop-Here "git add failed." }
git commit -m "Horizon Rush: pseudo-3D arcade racing game with AI drivers"
if ($LASTEXITCODE -ne 0) {
  Write-Host "Nothing new to commit (already committed). Continue." -ForegroundColor Yellow
}

# ---------- 2) create remote repo and push ----------
$ghCmd = Get-Command gh -ErrorAction SilentlyContinue
$useGh = $false
if ($ghCmd) {
  gh auth status *> $null
  if ($LASTEXITCODE -eq 0) { $useGh = $true }
}

if ($useGh) {
  Write-Host ""
  Write-Host "GitHub CLI detected and logged in. Creating public repo ..." -ForegroundColor Yellow
  gh repo create $RepoName --public --source . --remote origin --push
  if ($LASTEXITCODE -ne 0) {
    Write-Host "gh repo create failed (repo may already exist). Falling back to manual remote." -ForegroundColor Yellow
    $useGh = $false
  } else {
    $owner = (gh api user --jq .login).Trim()
    Write-Host "Enabling GitHub Pages ..." -ForegroundColor Yellow
    gh api --method POST "repos/$owner/$RepoName/pages" -f "source[branch]=$Branch" -f "source[path]=/" *> $null
    Start-Sleep -Seconds 3
    $url = ""
    try { $url = (gh api "repos/$owner/$RepoName/pages" --jq .html_url).Trim() } catch { $url = "" }
    if (-not $url) { $url = "https://$owner.github.io/$RepoName/" }
    Write-Host ""
    Write-Host "DONE!" -ForegroundColor Green
    Write-Host "Repository : https://github.com/$owner/$RepoName" -ForegroundColor Green
    Write-Host "Public URL : $url" -ForegroundColor Green
    Write-Host ""
    Write-Host "GitHub Pages first deploy usually takes 1-2 minutes."
    Write-Host "If the URL 404s, wait a bit and refresh."
    Write-Host ""
    [void](Read-Host "Press Enter to exit")
    exit 0
  }
}

# ---------- 3) manual mode (no gh / gh not logged in) ----------
Write-Host ""
Write-Host "Manual mode (no GitHub CLI login detected)." -ForegroundColor Yellow
Write-Host ""
Write-Host "STEP 1: create a new PUBLIC empty repository:"
Write-Host "        https://github.com/new"
Write-Host ("        - Repository name : " + $RepoName)
Write-Host "        - Visibility      : Public"
Write-Host "        - Do NOT add README / .gitignore / license"
Write-Host ""
$owner = Read-Host "Enter your GitHub username (e.g. octocat)"
if ([string]::IsNullOrWhiteSpace($owner)) { Stop-Here "GitHub username is required." }
$owner = $owner.Trim()
[void](Read-Host "Press Enter after the empty repo is created")

git remote remove origin *> $null
git remote add origin ("https://github.com/" + $owner + "/" + $RepoName + ".git")
if ($LASTEXITCODE -ne 0) { Stop-Here "git remote add failed." }

Write-Host ""
Write-Host "Pushing (a browser/login window may appear for GitHub authentication) ..." -ForegroundColor Yellow
git push -u origin $Branch
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "Push failed. Common reasons:" -ForegroundColor Red
  Write-Host "  - repo name/username wrong"
  Write-Host "  - not logged in: run  gh auth login  or use Git Credential Manager"
  Write-Host "  - repo already has commits (create an EMPTY repo next time)"
  Stop-Here "git push failed."
}

Write-Host ""
Write-Host "Pushed successfully!" -ForegroundColor Green
Write-Host ("Repository : https://github.com/" + $owner + "/" + $RepoName) -ForegroundColor Green
Write-Host ""
Write-Host "STEP 2: enable GitHub Pages (one time):"
Write-Host "        Repo -> Settings -> Pages"
Write-Host "        Source: Deploy from a branch"
Write-Host ("        Branch: " + $Branch + " / (root)  -> Save")
Write-Host ""
Write-Host ("STEP 3: public URL (after 1-2 min): https://" + $owner + ".github.io/" + $RepoName + "/") -ForegroundColor Green
Write-Host ""
[void](Read-Host "Press Enter to exit")
