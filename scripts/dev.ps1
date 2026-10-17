<#
.SYNOPSIS
  OmniPulse AI developer helper for Windows PowerShell.
.EXAMPLE
  ./scripts/dev.ps1 install     # create the venv, install backend + frontend dependencies
  ./scripts/dev.ps1 setup       # apply migrations and seed demo data (skips seeding if data exists)
  ./scripts/dev.ps1 api         # run the API with reload (http://localhost:8000/docs)
  ./scripts/dev.ps1 web         # run the frontend (http://localhost:5173)
  ./scripts/dev.ps1 test        # backend + frontend tests
  ./scripts/dev.ps1 reset       # drop, migrate and reseed the demo database
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("install", "setup", "api", "worker", "web", "test", "lint", "reset", "build", "e2e")]
  [string]$Command
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"
$Py = Join-Path $Backend ".venv\Scripts\python.exe"

function In($dir, [scriptblock]$block) { Push-Location $dir; try { & $block } finally { Pop-Location } }

switch ($Command) {
  "install" {
    In $Backend { python -m venv .venv; & $Py -m pip install -e ".[dev,redis,pgvector]" }
    In $Frontend { npm ci }
  }
  "setup"  { In $Backend { & $Py -m app.cli migrate; & $Py -m app.cli seed } }
  "api"    { In $Backend { & $Py -m uvicorn app.main:app --reload --port 8000 } }
  "worker" { In $Backend { & $Py -m app.tasks.worker } }
  "web"    { In $Frontend { npm run dev } }
  "test"   { In $Backend { & $Py -m pytest }; In $Frontend { npm test } }
  "lint"   { In $Backend { & $Py -m ruff check app tests }; In $Frontend { npm run lint; npm run typecheck } }
  "reset"  { In $Backend { & $Py -m app.cli reset --yes } }
  "build"  { In $Frontend { npm run build } }
  "e2e"    { In $Frontend { npx playwright test } }
}
