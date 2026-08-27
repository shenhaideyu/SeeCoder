param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Message,

  [switch]$Push
)

$ErrorActionPreference = 'Stop'

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Step
  )

  Write-Host "> $Label" -ForegroundColor DarkCyan
  & $Step
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Label"
  }
}

function Get-BeijingNow {
  try {
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
  } catch {
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById('Asia/Shanghai')
  }
  return [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $zone)
}

if ($Message -notmatch '^(feat|fix|test|docs|chore|refactor|perf|build|ci)(\([^)]+\))?: .+') {
  throw 'Use Conventional Commits, for example: feat(ui): improve composer'
}

$branch = (git branch --show-current).Trim()
if (-not $branch) { throw 'The current Git branch could not be determined' }
if ($branch -eq 'main') { throw 'main only accepts develop pull requests; publish milestones from develop' }

git diff --cached --quiet
if ($LASTEXITCODE -eq 0) { throw 'The index is empty; this script never stages files automatically' }
if ($LASTEXITCODE -ne 1) { throw 'Unable to inspect the Git index' }

$stagedFiles = @(git diff --cached --name-only)
$forbiddenFiles = $stagedFiles | Where-Object {
  $_ -match '(^|/)(\.env($|\.)|.*secret.*|.*credential.*|.*token.*|.*private.*\.(pem|key)$)' -and
  $_ -notmatch '(^|/)\.env\.(example|sample|template)$'
}
if ($forbiddenFiles) {
  throw "The index contains possible credential files: $($forbiddenFiles -join ', ')"
}

$addedLines = git diff --cached --unified=0 --no-color | Where-Object {
  $_ -match '^\+' -and $_ -notmatch '^\+\+\+'
}
$secretPattern = '(sk-[A-Za-z0-9_-]{20,}|(?i)api[_-]?key\s*[:=]\s*["''][^"'']{8,}|(?i)bearer\s+[A-Za-z0-9._-]{20,})'
if (($addedLines -join "`n") -match $secretPattern) {
  throw 'Staged content matched a credential pattern; remove the secret before committing'
}

Invoke-Checked 'pnpm lint' { pnpm lint }
Invoke-Checked 'pnpm typecheck' { pnpm typecheck }
Invoke-Checked 'pnpm test:unit' { pnpm test:unit }
Invoke-Checked 'pnpm test:integration' { pnpm test:integration }
Invoke-Checked 'pnpm test:e2e' { pnpm test:e2e }
Invoke-Checked 'pnpm build' { pnpm build }
Invoke-Checked 'task-board example test' { node --test examples/task-board/tests/task-board.test.mjs }
Invoke-Checked 'git commit' { git commit -m $Message }

if ($Push) {
  $cutoff = [DateTime]::Parse('2026-09-03T00:00:00')
  if ((Get-BeijingNow) -ge $cutoff) {
    throw 'Push is disabled after 2026-09-02 24:00 Asia/Shanghai'
  }
  Invoke-Checked "git push -u origin $branch" { git push -u origin $branch }
}

Write-Host "Milestone completed: $Message" -ForegroundColor Green
