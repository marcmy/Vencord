param(
    [string]$Remote = "upstream",
    [string]$GitBranch = "main",
    [string]$DiscordBranch = "stable",
    [switch]$SkipOpenAsar
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $repoRoot

try {
    if (-not $env:VENCORD_REMOTE) {
        $env:VENCORD_REMOTE = "Vendicated/Vencord"
    }

    Write-Host "Updating from $Remote/$GitBranch..."
    git pull --rebase $Remote $GitBranch

    Write-Host "Installing dependencies..."
    pnpm install

    Write-Host "Building Vencord..."
    pnpm build

    $injectArgs = @("-branch", $DiscordBranch)
    if (-not $SkipOpenAsar) {
        $injectArgs += "-install-openasar"
    }

    Write-Host "Injecting into Discord $DiscordBranch..."
    pnpm inject -- @injectArgs

    Write-Host "Update + build + inject complete."
} finally {
    Pop-Location
}
