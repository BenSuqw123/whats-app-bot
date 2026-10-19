param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('Init','Message','Relay','Inspect','Verify','Cleanup','LockInfo')][string]$Mode,
    [string]$LogPath = '', [string]$Text = '', [string]$Kind = '',
    [ValidateRange(1,120)][int]$VerifySeconds = 30,
    [ValidateRange(1,10)][int]$StableSamples = 3,
    [ValidateRange(25,5000)][int]$PollMilliseconds = 1000
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$lock = Join-Path $root '.deploy.lock'
$ownerPath = Join-Path $lock 'owner.json'

function Write-Safe([string]$line) {
    [Console]::WriteLine($line)
    if ($LogPath) { Add-Content -LiteralPath $LogPath -Value ('[' + (Get-Date -Format o) + '] ' + $line) -Encoding UTF8 }
}
function Field($obj, [string]$name) {
    if ($null -eq $obj) { return $null }
    $p = $obj.PSObject.Properties[$name]
    if ($null -ne $p) { return $p.Value }
    return $null
}
function Get-App {
    # Resolve only a native shim/executable; never print the full jlist (it includes env).
    $command = Get-Command pm2.cmd -ErrorAction SilentlyContinue
    if (-not $command) { $command = Get-Command pm2.exe -ErrorAction Stop }
    $raw = & $command.Source jlist 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'PM2 inspection failed' }
    $json = ($raw | ForEach-Object { $_.ToString() }) -join "`n"
    $json = $json.Trim()
    if (-not $json.StartsWith('[') -or -not $json.EndsWith(']')) { throw 'Invalid PM2 process list' }
    # Windows PowerShell 5.1 emits the decoded array as one pipeline object.
    # Assign first, then expand it, so [] and a single process both work.
    $decoded = ConvertFrom-Json -InputObject $json
    $list = @($decoded)
    foreach ($entry in $list) {
        if ($null -eq (Field $entry 'name') -or $null -eq (Field $entry 'pm2_env')) { throw 'Invalid PM2 process entry' }
    }
    $matches = @($list | Where-Object { (Field $_ 'name') -ceq 'whatsappbot' })
    if ($matches.Count -gt 1) { throw 'Multiple whatsappbot entries: refusing ambiguous deployment' }
    if ($matches.Count -eq 0) { return $null }
    $entry = $matches[0]; $envState = Field $entry 'pm2_env'
    $status = [string](Field $envState 'status')
    if ($status -notin @('online','stopped','stopping','launching','errored','waiting restart','one-launch-status')) { throw 'Unknown PM2 status' }
    return [pscustomobject]@{ name='whatsappbot'; status=$status;
        pid=[long](Field $entry 'pid'); id=[long](Field $entry 'pm_id');
        restarts=[long](Field $envState 'restart_time'); exitCode=(Field $envState 'exit_code') }
}
function Show-App($app) {
    if ($null -eq $app) { Write-Safe 'PM2: whatsappbot absent'; return }
    Write-Safe ('PM2: name=whatsappbot status={0} pid={1} id={2} restarts={3}' -f $app.status,$app.pid,$app.id,$app.restarts)
    if ([string]$app.exitCode -eq '78') {
        Write-Safe 'Exit code 78: session ownership refused. Inspect the owner; do not loop restarts or delete bot.lock.'
    }
}
function Safe-LogIndicator([string]$line) {
    $brace = $line.IndexOf('{')
    if ($brace -ge 0) {
        try {
            $data = $line.Substring($brace) | ConvertFrom-Json
            $safe = [ordered]@{}
            $operation = [string](Field $data 'operation')
            if ($operation -in @('connection-open','connection-stable','connection-close','reconnect-scheduled','socket-build',
                'QR_REQUIRED','CONFLICT','AUTH_REQUIRES_ACTION','connection.update','messages.upsert','creds.update',
                'socket-end','socket-build-timeout','socket-build-fatal','fatal-handler')) { $safe.operation = $operation }
            $state = [string](Field $data 'connectionState')
            if ($state -in @('STARTING','CONNECTING','READY','RECONNECTING','AUTH_REQUIRED','STOPPING')) { $safe.connectionState = $state }
            foreach ($key in @('pid','generation','socketGeneration','disconnectStatus','reconnectAttempt','reconnectDelay',
                'lastConnectionOpenAt','lastMessageReceivedAt','lastMessagePersistedAt','reconnects','conflictEvents','authFailures',
                'seenAlbumsSize','seenIdsSize','groupCacheSize','mediaActive','mediaQueued','mediaQueueOldestAge',
                'rssMB','heapUsedMB','externalMB','arrayBuffersMB')) {
                $value = Field $data $key
                if ($null -ne $value -and [string]$value -match '^\d+(\.\d+)?$') { $safe[$key] = $value }
            }
            if ($safe.Contains('operation') -or $safe.Contains('connectionState')) { Write-Safe ('[indicator] ' + ($safe | ConvertTo-Json -Compress)); return }
        } catch { } # Never echo raw parser exceptions or raw log content.
    }
    foreach ($marker in @('CONFLICT','AUTH_REQUIRES_ACTION','QR_REQUIRED','AUTH_REQUIRED','connection-open','connection-stable','READY')) {
        if ($line -cmatch ('\b' + [regex]::Escape($marker) + '\b')) { Write-Safe ('[indicator] ' + $marker); return }
    }
}

try {
    switch ($Mode) {
        'Init' {
            if (-not $env:DEPLOY_TOKEN -or -not [IO.Directory]::Exists($lock)) { throw 'Missing deployment ownership' }
            $parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
            @{ token=$env:DEPLOY_TOKEN; pid=$parentPid; startedAt=(Get-Date -Format o) } |
                ConvertTo-Json | Set-Content -LiteralPath $ownerPath -Encoding UTF8
            $file = [IO.File]::Open($LogPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
            $file.Dispose()
            Write-Safe 'Deployment started; logs contain sanitized diagnostics only.'
            Write-Safe ('Deployment log: ' + $LogPath)
        }
        'Message' { Write-Safe $Text }
        'Relay' {
            $result = $null
            while ($null -ne ($line = [Console]::ReadLine())) {
                if ($line -match '^__WHATSAPP_DEPLOY_EXIT__=(\d+)$') { $result = [int]$Matches[1]; continue }
                $line = $line -replace "\x1b\[[0-9;]*[A-Za-z]", ''
                if ($Kind -eq 'Version' -and $line.Trim() -match '^v?\d+\.\d+\.\d+([-+][A-Za-z0-9.]+)?$') {
                    Write-Safe ($Text + ': ' + $line.Trim())
                } elseif ($Kind -eq 'Test' -and $line.Trim() -match '^(?:[^A-Za-z0-9]*)(tests|pass|fail|cancelled|skipped|duration_ms)\s+\d+(\.\d+)?$') {
                    Write-Safe ('[tests] ' + $Matches[1] + '=' + ($line.Trim() -replace '^.*\s', ''))
                } elseif ($Kind -eq 'Logs') { Safe-LogIndicator $line }
                # Describe/status/command output may contain env/private text. Inspect renders a safe jlist summary instead.
            }
            if ($null -eq $result) { Write-Safe ('ERROR: ' + $Text + ' did not return a verified command exit code.'); exit 1 }
            Write-Safe ('Command ' + $Text + ' exit=' + $result)
            if ($result -ne 0) { exit 1 }
        }
        'Inspect' {
            $app = Get-App; Show-App $app
            if ($null -eq $app) { exit 3 }
        }
        'Verify' {
            $until = (Get-Date).AddSeconds($VerifySeconds)
            $good = 0; $identity = ''; $previous = ''
            do {
                $app = Get-App
                if ($null -eq $app) { Write-Safe 'ERROR: new whatsappbot is absent.'; exit 1 }
                if ($app.status -ne $previous) { Show-App $app; $previous = $app.status }
                if ([string]$app.exitCode -eq '78') { Write-Safe 'ERROR: Ownership conflict (exit 78). No restart loop will be attempted.'; exit 1 }
                if ($app.status -in @('stopped','errored','stopping')) { Write-Safe 'ERROR: new whatsappbot is not online.'; exit 1 }
                $current = '{0}/{1}' -f $app.pid,$app.restarts
                if ($app.status -eq 'online' -and $app.pid -gt 0) {
                    if ($identity -eq $current) { $good++ } else { $identity=$current; $good=1 }
                    if ($good -ge $StableSamples) { Write-Safe 'Verified whatsappbot online with a stable PID/restart count.'; exit 0 }
                } else { $good=0; $identity='' }
                Start-Sleep -Milliseconds $PollMilliseconds
            } while ((Get-Date) -lt $until)
            Write-Safe 'ERROR: online verification timed out.'; exit 1
        }
        'LockInfo' {
            Write-Safe 'Another deployment appears to be running. Existing deploy lock will NOT be removed.'
            if ([IO.File]::Exists($ownerPath)) {
                try {
                    $owner = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
                    $ownerPid = [int](Field $owner 'pid')
                    $alive = $null -ne (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)
                    Write-Safe ('Deploy owner pid={0} alive={1}. Verify manually if the lock is stale.' -f $ownerPid,$alive)
                } catch { Write-Safe 'Deploy ownership metadata is unreadable; inspect manually.' }
            }
        }
        'Cleanup' {
            # Only our empty/owned deployment directory. Never recursive-delete a computed Windows path.
            if ([IO.Path]::GetFullPath($lock) -ne [IO.Path]::GetFullPath((Join-Path $root '.deploy.lock'))) { throw 'Unsafe cleanup target' }
            if ([IO.File]::Exists($ownerPath)) {
                $owner = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
                if ((Field $owner 'token') -cne $env:DEPLOY_TOKEN) { throw 'Deployment token mismatch' }
                Remove-Item -LiteralPath $ownerPath
            }
            [IO.Directory]::Delete($lock, $false)
            Write-Safe 'Deploy lock released.'
        }
    }
    exit 0
} catch {
    # Exceptions from PM2/JSON parsing may include sensitive original output; keep them private.
    [Console]::WriteLine('ERROR: deployment helper failed in mode ' + $Mode + '. Inspect commands privately; no raw output was logged.')
    if ($LogPath -and [IO.File]::Exists($LogPath)) {
        try { Add-Content -LiteralPath $LogPath -Value ('Helper failure: ' + $Mode) -Encoding UTF8 } catch { }
    }
    exit 1
}
