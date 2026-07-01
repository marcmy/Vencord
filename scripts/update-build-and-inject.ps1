param(
    [string]$Remote = "upstream",
    [string]$GitBranch = "main",
    [string]$DiscordBranch = "stable",
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
    Invoke-NativeStep "Updating from $Remote/$GitBranch..." "git" @("pull", "--rebase", $Remote, $GitBranch)

    Invoke-NativeStep "Installing dependencies..." "pnpm" @("install")

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
