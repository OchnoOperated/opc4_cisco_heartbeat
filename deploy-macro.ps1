<#
  Uploads and enables the OPC4 heartbeat macro on a Cisco RoomOS device
  without using the web UI. Requires an Admin user on the codec.

  Install / update:  .\deploy-macro.ps1 -CiscoHost 192.168.6.1 -Username admin -Password '...' -UseHttp
  Uninstall (v2):    .\deploy-macro.ps1 -CiscoHost 192.168.6.1 -Username admin -Password '...' -UseHttp -Remove

  Installs side by side with any existing macro / panels. It does not modify or
  delete existing UI extensions or other macros. If the widget opc_status already
  exists, the macro reuses it and creates no panel.
#>
param(
    [Parameter(Mandatory = $true)][string]$CiscoHost,
    [Parameter(Mandatory = $true)][string]$Username,
    [Parameter(Mandatory = $true)][string]$Password,
    [string]$MacroFile = (Join-Path $PSScriptRoot 'opc4-heartbeat-monitor.js'),
    [string]$MacroName = 'opc4_heartbeat_monitor_v2',
    [switch]$Remove,
    [switch]$UseHttp,
    [switch]$AllowUntrustedCertificate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($AllowUntrustedCertificate) {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
}

$scheme = if ($UseHttp) { 'http' } else { 'https' }
$uri = '{0}://{1}/putxml' -f $scheme, ($CiscoHost -replace '^https?://', '')
$token = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$Username`:$Password"))
$headers = @{ Authorization = "Basic $token" }

function Send-Xml([string]$Description, [string]$Xml) {
    try {
        $r = Invoke-WebRequest -Uri $uri -Method Post -Headers $headers -ContentType 'text/xml' -Body $Xml -UseBasicParsing
        Write-Host ("[OK]   {0} (HTTP {1})" -f $Description, [int]$r.StatusCode)
        if ($r.Content -match 'status="Error"|<Reason>') { Write-Warning $r.Content }
    } catch {
        Write-Warning ("[FAIL] {0}: {1}" -f $Description, $_.Exception.Message)
        throw
    }
}

$code = [System.Security.SecurityElement]::Escape((Get-Content -Raw -Path $MacroFile))
$name = [System.Security.SecurityElement]::Escape($MacroName)

if ($Remove) {
    Send-Xml "Deactivate macro '$MacroName'" "<Command><Macros><Macro><Deactivate><Name>$name</Name></Deactivate></Macro></Macros></Command>"
    Send-Xml "Remove macro '$MacroName'" "<Command><Macros><Macro><Remove><Name>$name</Name></Remove></Macro></Macros></Command>"
    try { Send-Xml 'Remove saved status store' '<Command><Macros><Macro><Remove><Name>opc4_heartbeat_state</Name></Remove></Macro></Macros></Command>' } catch { }
    try { Send-Xml 'Remove v2 status panel (if it was created)' '<Command><UserInterface><Extensions><Panel><Remove><PanelId>opc4_hb_v2_status</PanelId></Remove></Panel></Extensions></UserInterface></Command>' } catch { }
    Send-Xml 'Remove v2 hidden panel (if it was created)' '<Command><UserInterface><Extensions><Panel><Remove><PanelId>opc4_hb_v2_source</PanelId></Remove></Panel></Extensions></UserInterface></Command>'
    Write-Host 'v2 removed. Existing panels and macros were not touched.'
    return
}

Send-Xml 'Enable macros' '<Configuration><Macros><Mode>On</Mode><AutoStart>On</AutoStart></Macros></Configuration>'
Send-Xml "Upload macro '$MacroName'" "<Command><Macros><Macro><Save><Name>$name</Name><Overwrite>True</Overwrite><body>$code</body></Save></Macro></Macros></Command>"
Send-Xml 'Activate macro' "<Command><Macros><Macro><Activate><Name>$name</Name></Activate></Macro></Macros></Command>"
Send-Xml 'Restart macro runtime' '<Command><Macros><Runtime><Restart/></Runtime></Macros></Command>'

Write-Host ''
Write-Host "Done. Macro '$MacroName' is running next to any existing macros."
Write-Host 'If widget opc_status already exists it is reused; otherwise a hidden panel opc4_hb_v2_source is created.'
Write-Host 'Check: http(s)://<codec>/getxml?location=/Status/UserInterface/Extensions  should list WidgetId opc_status within a few seconds.'
