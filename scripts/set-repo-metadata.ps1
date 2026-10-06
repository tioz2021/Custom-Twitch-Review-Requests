# Sets the GitHub repository description and topics via the API.
#
# WHY THIS SCRIPT EXISTS
# The repository metadata (About text and Topics) can only be set through the
# GitHub API or the web interface — it is not stored in the repository, so a
# `git push` cannot carry it. This script fills both fields in one go.
#
# The public mirror of the repository description and topics lives in
# GITHUB_ABOUT.md; this script is the automated way to apply them.
#
# USAGE
#   1. Create a personal access token: https://github.com/settings/tokens
#      Classic token with the `public_repo` scope is enough for a public repo.
#   2. Run:
#        .\scripts\set-repo-metadata.ps1 -Repo "YOUR_USERNAME/Custom-Twitch-Review-Requests"
#      and paste the token when prompted.
#
# The token is used once, held only in memory, and never written to disk.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Repo,

    [string]$Description = 'Chrome extension for Twitch: search a viewer''s channel points reward-queue claims and refund points for individual claims. No API keys, no permissions, no bulk actions.',

    [string[]]$Topics = @(
        'twitch',
        'twitch-extension',
        'chrome-extension',
        'manifest-v3',
        'channel-points',
        'twitch-api',
        'moderation',
        'streamer-tools',
        'javascript'
    )
)

$ErrorActionPreference = 'Stop'

$secure = Read-Host -Prompt 'GitHub personal access token (public_repo)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$headers = @{
    Authorization          = "Bearer $token"
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'set-repo-metadata'
}

function Invoke-GitHub {
    param([string]$Method, [string]$Uri, [object]$Body)
    $params = @{
        Method      = $Method
        Uri         = "https://api.github.com$Uri"
        Headers     = $headers
        ContentType = 'application/json; charset=utf-8'
    }
    if ($Body) {
        # GitHub rejects the request without explicit UTF-8 bytes, and the
        # topics endpoint expects raw JSON arrays.
        $json = $Body | ConvertTo-Json -Depth 5 -Compress
        $params.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
    }
    return Invoke-RestMethod @params
}

Write-Host "Repository: $Repo" -ForegroundColor Cyan

# 1) Description (the "About" field)
Invoke-GitHub -Method Patch -Uri "/repos/$Repo" -Body @{
    description = $Description
    has_issues  = $true
    has_wiki    = $false
} | Out-Null
Write-Host '  description set' -ForegroundColor Green
Write-Host "    $Description"

# 2) Topics (a separate endpoint, and it replaces the whole list)
Invoke-GitHub -Method Put -Uri "/repos/$Repo/topics" -Body @{ names = $Topics } | Out-Null
Write-Host '  topics set' -ForegroundColor Green
Write-Host "    $($Topics -join ', ')"

# 3) Read back what GitHub actually stored, so the result is verified rather
#    than assumed.
$check = Invoke-GitHub -Method Get -Uri "/repos/$Repo"
Write-Host ''
Write-Host 'Verification (read back from the API):' -ForegroundColor Cyan
Write-Host "  description: $($check.description)"
Write-Host "  topics:      $($check.topics -join ', ')"
Write-Host "  visibility:  $($check.visibility)"
Write-Host "  issues:      $($check.has_issues)"
