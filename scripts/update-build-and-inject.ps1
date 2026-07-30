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
        Invoke-NativeStep "Merging $UpstreamRemote/$UpstreamBranch..." "git" @("merge", "--no-edit", "$UpstreamRemote/$UpstreamBranch")
    }

    Invoke-NativeStep "Publishing the exact source revision that will be built..." "git" @("push", $Remote, "HEAD:$GitBranch")

    Invoke-NativeStep "Installing dependencies..." "pnpm" @("--config.update-notifier=false", "install")

    Invoke-NativeStep "Building Vencord..." "pnpm" @("build")

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
