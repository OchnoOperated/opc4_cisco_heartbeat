param(
    [Parameter(Mandatory = $true)]
    [string]$CiscoHost,

    [Parameter(Mandatory = $true)]
    [string]$Username,

    [Parameter(Mandatory = $true)]
    [string]$Password,

    [string]$ApiPath = '/putxml',

    [string]$ContentType = 'text/xml',

    [string]$WidgetId = 'opc_status',

    # Widget  = current firmware: UserInterface Extensions Widget SetValue (needs hidden widget, RoomControl role OK)
    # Message = recommended: Message Send (no widget at all, event driven, needs Integrator role)
    [ValidateSet('Widget', 'Message')]
    [string]$Transport = 'Widget',

    [string]$MessagePrefix = 'opc4:',

    # Optional: also register as a RoomOS peripheral and send native Peripherals HeartBeat
    [switch]$RegisterPeripheral,

    [string]$PeripheralId = 'OPC4-EMULATOR-0001',

    [string]$PeripheralName = 'Ochno OPC4',

    [int]$IntervalSeconds = 30,

    [int]$InitialConnected = 0,

    [int]$InitialActive = 0,

    [ValidateSet('uc', 'byod')]
    [string]$InitialMode = 'uc',

    [int]$InitialSequence = 0,

    [switch]$UseHttp,

    [switch]$AllowUntrustedCertificate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($IntervalSeconds -lt 1) {
    throw 'IntervalSeconds must be 1 or higher.'
}

if ($InitialConnected -lt 0 -or $InitialConnected -gt 15) {
    throw 'InitialConnected must be between 0 and 15.'
}

if ($InitialActive -lt 0 -or $InitialActive -gt 4) {
    throw 'InitialActive must be between 0 and 4.'
}

if ($InitialSequence -lt 0 -or $InitialSequence -gt 255) {
    throw 'InitialSequence must be between 0 and 255.'
}

if ($AllowUntrustedCertificate) {
    Add-Type @"
using System.Net;
using System.Security.Cryptography.X509Certificates;

public static class TrustAllCerts
{
    public static bool Validate(
        object sender,
        X509Certificate certificate,
        X509Chain chain,
        System.Net.Security.SslPolicyErrors sslPolicyErrors)
    {
        return true;
    }
}
"@

    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = {
        param($sender, $certificate, $chain, $sslPolicyErrors)
        return [TrustAllCerts]::Validate($sender, $certificate, $chain, $sslPolicyErrors)
    }
}

function New-BasicAuthHeader {
    param(
        [Parameter(Mandatory = $true)]
        [string]$User,

        [Parameter(Mandatory = $true)]
        [string]$Pass
    )

    $token = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$User`:$Pass"))
    return "Basic $token"
}

function ConvertTo-XmlText {
    param([string]$Text)
    return [System.Security.SecurityElement]::Escape($Text)
}

function New-MessageSendXml {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $text = ConvertTo-XmlText ("{0}{1}" -f $MessagePrefix, $Value)
    return @"
<Command>
  <Message>
    <Send>
      <Text>$text</Text>
    </Send>
  </Message>
</Command>
"@
}

function New-PeripheralConnectXml {
    $id = ConvertTo-XmlText $PeripheralId
    $name = ConvertTo-XmlText $PeripheralName
    return @"
<Command>
  <Peripherals>
    <Connect>
      <ID>$id</ID>
      <Name>$name</Name>
      <Type>Other</Type>
      <SoftwareInfo>opc4-emulator</SoftwareInfo>
    </Connect>
  </Peripherals>
</Command>
"@
}

function New-PeripheralHeartBeatXml {
    $id = ConvertTo-XmlText $PeripheralId
    $timeout = [Math]::Max(1, $IntervalSeconds * 3)
    return @"
<Command>
  <Peripherals>
    <HeartBeat>
      <ID>$id</ID>
      <Timeout>$timeout</Timeout>
    </HeartBeat>
  </Peripherals>
</Command>
"@
}

function New-WidgetSetValueXml {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetWidgetId,

        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    return @"
<Command>
  <UserInterface>
    <Extensions>
      <Widget>
        <SetValue>
          <WidgetId>$(ConvertTo-XmlText $TargetWidgetId)</WidgetId>
          <Value>$(ConvertTo-XmlText $Value)</Value>
        </SetValue>
      </Widget>
    </Extensions>
  </UserInterface>
</Command>
"@
}

function Invoke-CiscoPost {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,

        [Parameter(Mandatory = $true)]
        [hashtable]$Headers,

        [Parameter(Mandatory = $true)]
        [string]$TargetWidgetId,

        [Parameter(Mandatory = $true)]
        [string]$RequestContentType,

        [Parameter(Mandatory = $true)]
        [string]$Value,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    $body = if ($Transport -eq 'Message') {
        New-MessageSendXml -Value $Value
    } else {
        New-WidgetSetValueXml -TargetWidgetId $TargetWidgetId -Value $Value
    }

    Invoke-CiscoXml -Uri $Uri -Headers $Headers -RequestContentType $RequestContentType -Body $body -Description $Description
}

function Invoke-CiscoXml {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,

        [Parameter(Mandatory = $true)]
        [hashtable]$Headers,

        [Parameter(Mandatory = $true)]
        [string]$RequestContentType,

        [Parameter(Mandatory = $true)]
        [string]$Body,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    try {
        $response = Invoke-WebRequest `
            -Uri $Uri `
            -Method Post `
            -Headers $Headers `
            -ContentType $RequestContentType `
            -Body $Body `
            -UseBasicParsing

        Write-Host ''
        Write-Host ("[{0}] {1}. HTTP {2}" -f (Get-Date).ToString('s'), $Description, [int]$response.StatusCode)
        if ($response.Content) {
            Write-Host 'Cisco response body:'
            Write-Host $response.Content
        }
    } catch {
        Write-Host ''
        Write-Warning ("[{0}] {1} failed: {2}" -f (Get-Date).ToString('s'), $Description, $_.Exception.Message)
    }
}

function Get-NextSequence {
    $current = [int]$script:Sequence
    $script:Sequence = ($current + 1) % 256
    return $current
}

function New-AliveValue {
    $sequence = Get-NextSequence
    return 'alive={0}' -f $sequence
}

function New-FullStatusValue {
    $sequence = Get-NextSequence
    return 'alive={0},connected={1},active={2},mode={3}' -f $sequence, $script:CurrentConnected, $script:CurrentActive, $script:CurrentMode
}

function Send-PeripheralConnect {
    Invoke-CiscoXml -Uri $script:Uri -Headers $script:Headers -RequestContentType $ContentType `
        -Body (New-PeripheralConnectXml) -Description "Peripheral registered. ID='$PeripheralId'"
}

function Send-PeripheralHeartBeat {
    Invoke-CiscoXml -Uri $script:Uri -Headers $script:Headers -RequestContentType $ContentType `
        -Body (New-PeripheralHeartBeatXml) -Description "Peripheral heartbeat sent. ID='$PeripheralId'"
}

function Send-AliveHeartbeat {
    if ($RegisterPeripheral) {
        Send-PeripheralHeartBeat
    }

    $aliveValue = New-AliveValue
    Invoke-CiscoPost `
        -Uri $script:Uri `
        -Headers $script:Headers `
        -TargetWidgetId $WidgetId `
        -RequestContentType $ContentType `
        -Value $aliveValue `
        -Description "Heartbeat sent. Value='$aliveValue'"
}

function Send-FullStatus {
    $fullStatusValue = New-FullStatusValue
    Invoke-CiscoPost `
        -Uri $script:Uri `
        -Headers $script:Headers `
        -TargetWidgetId $WidgetId `
        -RequestContentType $ContentType `
        -Value $fullStatusValue `
        -Description "Status Change sent. Value='$fullStatusValue'"
}

function Show-Help {
    Write-Host ''
    Write-Host 'Interactive commands:'
    Write-Host '  connected=<0-15>   Set connected bitmap as decimal value'
    Write-Host '  active=<0-4>       Set active port'
    Write-Host '  mode=uc            Set mode to uc'
    Write-Host '  mode=byod          Set mode to byod'
    Write-Host '  status             Print current cached status'
    Write-Host '  send               Send the full current status immediately'
    Write-Host '  help               Show this help'
    Write-Host '  quit               Exit'
    Write-Host ''
    Write-Host 'Port bitmap values: Port1=1, Port2=2, Port3=4, Port4=8'
    Write-Host ''
}

function Show-CurrentStatus {
    Write-Host ("Current status: connected={0}, active={1}, mode={2}, next_sequence={3}" -f $script:CurrentConnected, $script:CurrentActive, $script:CurrentMode, $script:Sequence)
}

function Show-Prompt {
    Write-Host -NoNewline 'opc4> '
}

function Handle-Command {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandText
    )

    $trimmed = $CommandText.Trim()
    if (-not $trimmed) {
        return $true
    }

    if ($trimmed -eq 'quit') {
        return $false
    }

    if ($trimmed -eq 'help') {
        Show-Help
        return $true
    }

    if ($trimmed -eq 'status') {
        Show-CurrentStatus
        return $true
    }

    if ($trimmed -eq 'send') {
        Send-FullStatus
        Show-CurrentStatus
        return $true
    }

    $parts = $trimmed -split '=', 2
    if ($parts.Count -ne 2) {
        Write-Warning "Unknown command: $trimmed"
        Show-Help
        return $true
    }

    $key = $parts[0].Trim().ToLowerInvariant()
    $value = $parts[1].Trim()

    switch ($key) {
        'connected' {
            $parsed = 0
            if (-not [int]::TryParse($value, [ref]$parsed) -or $parsed -lt 0 -or $parsed -gt 15) {
                Write-Warning 'connected must be a decimal value between 0 and 15.'
                return $true
            }

            $script:CurrentConnected = $parsed
        }
        'active' {
            $parsed = 0
            if (-not [int]::TryParse($value, [ref]$parsed) -or $parsed -lt 0 -or $parsed -gt 4) {
                Write-Warning 'active must be a value between 0 and 4.'
                return $true
            }

            $script:CurrentActive = $parsed
        }
        'mode' {
            $normalized = $value.ToLowerInvariant()
            if ($normalized -notin @('uc', 'byod')) {
                Write-Warning 'mode must be uc or byod.'
                return $true
            }

            $script:CurrentMode = $normalized
        }
        default {
            Write-Warning "Unknown field: $key"
            Show-Help
            return $true
        }
    }

    Send-FullStatus
    Show-CurrentStatus
    return $true
}

$normalizedHost = $CiscoHost.Trim()
if ($normalizedHost -match '^https?://') {
    $normalizedHost = $normalizedHost -replace '^https?://', ''
}

$scheme = if ($UseHttp) { 'http' } else { 'https' }
$normalizedApiPath = if ($ApiPath.StartsWith('/')) { $ApiPath } else { "/$ApiPath" }
$script:Uri = '{0}://{1}{2}' -f $scheme, $normalizedHost, $normalizedApiPath
$script:Headers = @{
    Authorization = New-BasicAuthHeader -User $Username -Pass $Password
}

$script:CurrentConnected = $InitialConnected
$script:CurrentActive = $InitialActive
$script:CurrentMode = $InitialMode.ToLowerInvariant()
$script:Sequence = $InitialSequence

Write-Host "POST target: $script:Uri"
Write-Host "ContentType: $ContentType"
Write-Host "Transport: $Transport"
if ($Transport -eq 'Message') {
    Write-Host "MessagePrefix: $MessagePrefix"
} else {
    Write-Host "WidgetId: $WidgetId"
}
if ($RegisterPeripheral) {
    Write-Host "Peripheral: $PeripheralId ($PeripheralName)"
}
Write-Host "IntervalSeconds: $IntervalSeconds"
Show-CurrentStatus
Show-Help

if ($RegisterPeripheral) {
    Send-PeripheralConnect
}

$nextHeartbeatAt = Get-Date
$inputBuffer = ''

Show-Prompt

while ($true) {
    $now = Get-Date
    if ($now -ge $nextHeartbeatAt) {
        Send-AliveHeartbeat
        Show-Prompt
        Write-Host -NoNewline $inputBuffer
        $nextHeartbeatAt = $now.AddSeconds($IntervalSeconds)
    }

    while ([Console]::KeyAvailable) {
        $keyInfo = [Console]::ReadKey($true)

        switch ($keyInfo.Key) {
            'Enter' {
                Write-Host ''
                $shouldContinue = Handle-Command -CommandText $inputBuffer
                $inputBuffer = ''
                if (-not $shouldContinue) {
                    return
                }

                Show-Prompt
            }
            'Backspace' {
                if ($inputBuffer.Length -gt 0) {
                    $inputBuffer = $inputBuffer.Substring(0, $inputBuffer.Length - 1)
                    Write-Host -NoNewline "`b `b"
                }
            }
            default {
                if (-not [char]::IsControl($keyInfo.KeyChar)) {
                    $inputBuffer += $keyInfo.KeyChar
                    Write-Host -NoNewline $keyInfo.KeyChar
                }
            }
        }
    }

    Start-Sleep -Milliseconds 100
}
