param(
    [string]$Remote = "origin",
    [string]$GitBranch = "custom-plugins",
    [string]$UpstreamRemote = "upstream",
    [string]$UpstreamBranch = "main",
    [string]$DiscordBranch = "stable",
    [switch]$SkipUpstreamSync,
    [switch]$SkipOpenAsar
)

$ErrorActionPreference = "Stop"

function Invoke-NativeStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string[]]$Arguments = @()
    )

    Write-Host $Message
    & $Command @Arguments

    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE while: $Message"
    }
}

function Invoke-UpstreamMerge {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RemoteName,
        [Parameter(Mandatory = $true)]
        [string]$BranchName,
        [Parameter(Mandatory = $true)]
        [string]$ForkRemote,
        [Parameter(Mandatory = $true)]
        [string]$ForkBranch
    )

    $upstreamRef = "$RemoteName/$BranchName"
    Write-Host "Merging $upstreamRef..."
    & git merge --no-edit $upstreamRef
    $mergeExitCode = $LASTEXITCODE

    if ($mergeExitCode -eq 0) {
        return
    }

    $conflictedFiles = @(& git diff --name-only --diff-filter=U)
    if ($LASTEXITCODE -ne 0) {
        throw "git merge failed with exit code $mergeExitCode, and conflicted files could not be determined."
    }

    if ($conflictedFiles.Count -gt 0) {
        Write-Host ""
        Write-Host "Upstream merge stopped because conflicts need to be resolved." -ForegroundColor Yellow
        Write-Host "Conflicted files:" -ForegroundColor Yellow
        foreach ($file in $conflictedFiles) {
            Write-Host "  - $file" -ForegroundColor Yellow
        }

        Write-Host ""
        Write-Host "The merge has been left in progress so you can resolve it." -ForegroundColor Yellow
        Write-Host "After resolving the files, run:" -ForegroundColor Yellow
        Write-Host "  git add -A"
        Write-Host "  git commit"
        Write-Host "  git push $ForkRemote $ForkBranch"
        Write-Host "  .\update.cmd"
        Write-Host ""
        Write-Host "To abandon the merge instead, run:" -ForegroundColor Yellow
        Write-Host "  git merge --abort"

        throw "Upstream merge has unresolved conflicts. Resolve them and rerun update.cmd."
    }

    throw "git merge $upstreamRef failed with exit code $mergeExitCode."
}

function Get-DiscordResourcesPath {
    param([string]$Branch)

    $discordDirName = switch ($Branch) {
        "stable" { "Discord" }
        "ptb" { "DiscordPTB" }
        "canary" { "DiscordCanary" }
        default { "Discord" }
    }

    $discordDir = Join-Path $env:LOCALAPPDATA $discordDirName
    if (-not (Test-Path -LiteralPath $discordDir)) {
        return $null
    }

    $appDir = Get-ChildItem -LiteralPath $discordDir -Directory -Filter "app-*" |
        Sort-Object Name -Descending |
        Select-Object -First 1

    if (-not $appDir) {
        return $null
    }

    $resources = Join-Path $appDir.FullName "resources"
    if (Test-Path -LiteralPath $resources) {
        return $resources
    }

    return $null
}

function Test-OpenAsarInstalled {
    param([string]$Branch)

    $resources = Get-DiscordResourcesPath $Branch
    if (-not $resources) {
        return $false
    }

    foreach ($asarName in @("_app.asar", "app.asar")) {
        $asarPath = Join-Path $resources $asarName
        if (-not (Test-Path -LiteralPath $asarPath)) {
            continue
        }

        if (Select-String -LiteralPath $asarPath -SimpleMatch "OpenAsar" -Quiet) {
            return $true
        }
    }

    return $false
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $repoRoot

try {
    $currentBranch = (& git branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Could not determine the current Git branch."
    }
    if ($currentBranch -ne $GitBranch) {
        throw "Expected branch '$GitBranch', but '$currentBranch' is checked out."
    }

    $pendingChanges = & git status --porcelain
    if ($LASTEXITCODE -ne 0) {
        throw "Could not check the Git working tree."
    }
    if ($pendingChanges) {
        throw "Commit or stash your changes before running update.cmd."
    }

    Invoke-NativeStep "Fetching your fork branch..." "git" @("fetch", $Remote, $GitBranch)
    Invoke-NativeStep "Tracking $Remote/$GitBranch..." "git" @("branch", "--set-upstream-to=$Remote/$GitBranch", $GitBranch)
    Invoke-NativeStep "Updating from your fork without rewriting history..." "git" @("pull", "--ff-only", $Remote, $GitBranch)

    if (-not $SkipUpstreamSync) {
        Invoke-NativeStep "Fetching Vencord upstream..." "git" @("fetch", $UpstreamRemote, $UpstreamBranch)
        Invoke-UpstreamMerge -RemoteName $UpstreamRemote -BranchName $UpstreamBranch -ForkRemote $Remote -ForkBranch $GitBranch
    }

    # A frozen install guarantees the build uses the committed lockfile exactly.
    Invoke-NativeStep "Installing dependencies from the committed lockfile..." "pnpm" @("--config.update-notifier=false", "install", "--frozen-lockfile")

    Invoke-NativeStep "Building Vencord..." "pnpm" @("build")

    # Only publish the revision after dependency installation and the build succeed.
    Invoke-NativeStep "Publishing the verified source revision..." "git" @("push", $Remote, "HEAD:$GitBranch")

    $injectArgs = @("inject", "-branch", $DiscordBranch)

    Invoke-NativeStep "Injecting into Discord $DiscordBranch..." "pnpm" $injectArgs

    if (-not $SkipOpenAsar) {
        if (Test-OpenAsarInstalled $DiscordBranch) {
            Write-Host "OpenAsar already installed."
        } else {
            Invoke-NativeStep "Installing OpenAsar into Discord $DiscordBranch..." "node" @("scripts/runInstaller.mjs", "--", "-branch", $DiscordBranch, "-install-openasar")
        }
    }

    Write-Host "Update + build + inject complete."
} finally {
    Pop-Location
}
