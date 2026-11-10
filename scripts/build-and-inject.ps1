$ErrorActionPreference = "Stop"

pnpm build
pnpm inject

Write-Host "Build + inject complete."
