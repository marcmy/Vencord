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

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $repoRoot

try {
    Invoke-NativeStep "Updating from $Remote/$GitBranch..." "git" @("pull", "--rebase", $Remote, $GitBranch)

    Invoke-NativeStep "Installing dependencies..." "pnpm" @("install")

    Invoke-NativeStep "Building Vencord..." "pnpm" @("build")

    $injectArgs = @("inject", "-branch", $DiscordBranch)
    if (-not $SkipOpenAsar) {
        $injectArgs += "-install-openasar"
    }

    Invoke-NativeStep "Injecting into Discord $DiscordBranch..." "pnpm" $injectArgs

    Write-Host "Update + build + inject complete."
} finally {
    Pop-Location
}
