<#
.SYNOPSIS
    Deploy the independent Cloudbite Worker using wrangler.cloudbite.jsonc.
.DESCRIPTION
    Does not upload, rotate or remove secrets. Does not target gw-shinick domains.
    Configure the independent Worker and its secrets before an authorized deployment.
.EXAMPLE
    .\deploy.ps1 -DryRun
#>
[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath 'wrangler.cloudbite.jsonc')) {
        throw 'Missing independent Cloudbite configuration: wrangler.cloudbite.jsonc'
    }
    $cloudbiteDeployArgs = @('wrangler', 'deploy', '--config', 'wrangler.cloudbite.jsonc')
    if ($DryRun) { $cloudbiteDeployArgs += '--dry-run' }
    & npx @cloudbiteDeployArgs
    if ($LASTEXITCODE -ne 0) { throw 'Cloudbite build/deployment failed.' }
} finally {
    Pop-Location
}
