$ErrorActionPreference = "Stop"

if (-not $env:VENCORD_REMOTE) {
    $env:VENCORD_REMOTE = "Vendicated/Vencord"
}

pnpm build
pnpm inject

Write-Host "Build + inject complete."
