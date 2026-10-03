# Network report for streams through Sunshine: what the stream tunnel would face on this computer.
# Run: powershell -ExecutionPolicy Bypass -File astrum-diag.ps1
# Writes astrum-diag.txt to the desktop. It holds this computer's public IP: send it only to the person helping.

$out = Join-Path ([Environment]::GetFolderPath('Desktop')) 'astrum-diag.txt'
$r = New-Object System.Collections.Generic.List[string]
function Add($t, $v) { $r.Add("===== $t"); $r.Add(($v | Out-String -Width 220).TrimEnd()); $r.Add('') }

# the helper: next to the running app, at the installed place, or in the default folder
$exe = (Get-Process Astrum -ErrorAction SilentlyContinue | Select-Object -First 1).Path
if (-not $exe) {
  $u = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'Astrum*' } | Select-Object -First 1
  if ($u -and $u.InstallLocation) { $exe = Join-Path $u.InstallLocation 'Astrum.exe' }
}
if (-not $exe) { $exe = Join-Path $env:LOCALAPPDATA 'Programs\Astrum\Astrum.exe' }
$helper = Join-Path (Split-Path $exe) 'resources\Astrum-helper.exe'
Add 'app' ("exe: $exe", "version: $((Get-Item $exe -ErrorAction SilentlyContinue).VersionInfo.ProductVersion)", "helper found: $(Test-Path $helper)")

# the NAT in front of this computer, as the tunnel sees it (cone, symmetric, open or blocked), twice
$lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' }).IPAddress -join ','
if (Test-Path $helper) {
  Add 'nat probe 1' (& $helper tunnel probe $lan 2>&1)
  Add 'nat probe 2' (& $helper tunnel probe $lan 2>&1)
}

Add 'adapters' (Get-NetIPConfiguration -ErrorAction SilentlyContinue | Select-Object InterfaceAlias, InterfaceDescription,
  @{ n = 'IPv4'; e = { $_.IPv4Address.IPAddress -join ' ' } },
  @{ n = 'Gateway'; e = { $_.IPv4DefaultGateway.NextHop -join ' ' } },
  @{ n = 'IPv6'; e = { ($_.IPv6Address.IPAddress | Where-Object { $_ -notlike 'fe80*' }) -join ' ' } } | Format-List)
Add 'default routes (the lowest metric carries the traffic)' (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
  Select-Object InterfaceAlias, NextHop, RouteMetric, InterfaceMetric | Format-Table -AutoSize)
Add 'network profile' (Get-NetConnectionProfile -ErrorAction SilentlyContinue | Select-Object InterfaceAlias, NetworkCategory, IPv4Connectivity | Format-Table -AutoSize)
Add 'route to the internet (private hops are NAT layers: routers, the provider)' (tracert -d -h 4 -w 600 1.1.1.1 2>&1)

Add 'firewall profiles' (Get-NetFirewallProfile -ErrorAction SilentlyContinue | Select-Object Name, Enabled, DefaultInboundAction | Format-Table -AutoSize)
$apps = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -match 'Astrum|sunshine' }
Add 'firewall rules for Astrum and Sunshine' ($apps | ForEach-Object {
    $rule = $_ | Get-NetFirewallRule -ErrorAction SilentlyContinue
    "$($rule.DisplayName) | $($rule.Direction) $($rule.Action) | enabled $($rule.Enabled) | $($rule.Profile) | $($_.Program)"
  })

Add 'zapret, VPN and proxy programs' (Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -match 'winws|zapret|goodbyedpi|clash|verge|mihomo|v2ray|xray|sing-box|hiddify|nekoray|wireguard|openvpn|amnezia|outline|radmin|hamachi|zerotier|tailscale' } |
  Select-Object ProcessName, Path | Format-Table -AutoSize)
Add 'zapret service' (Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'zapret|winws|goodbyedpi' } | Select-Object Name, Status | Format-Table -AutoSize)

$streams = Join-Path $env:APPDATA 'Astrum\logs\streams.log'
if (Test-Path $streams) { Add 'stream log (last 300 lines)' (Get-Content $streams -Tail 300) }

$sunlog = Join-Path $env:APPDATA 'Astrum\sunshine\state\sunshine.log'
if (Test-Path $sunlog) {
  Add 'sunshine log: warnings, errors, sessions' (Select-String -Path $sunlog -Pattern 'Warning|Error|Fatal|session|CLIENT|Executing|encoder:' | Select-Object -Last 60 | ForEach-Object { $_.Line })
}

$r | Set-Content -Path $out -Encoding UTF8
Write-Host "Done: $out"
