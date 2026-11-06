# Capture a specific window's own content, not whatever is on screen at those
# coordinates.
#
# Why PrintWindow and not CopyFromScreen: CopyFromScreen reads the visible
# desktop, so if any other window overlaps the target it captures that instead.
# The first attempt at this script grabbed the agent's own terminal, which looked
# like a successful screenshot of a window that had not rendered at all.
# PrintWindow asks the window to paint itself into a device context, so
# z-order and overlap are irrelevant.
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Cap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  // Without this the process stays DPI-unaware and every rectangle comes back in
  // virtualised coordinates. On a 200% display that means a 2534x1478 window
  // reports as 1280x800, and PrintWindow is handed a bitmap half the size of
  // the window it is asking to paint: the capture looks like a UI with its
  // content shoved off the right edge, which is indistinguishable from a real
  // layout bug and is not one.
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr ctx);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
# Must happen before any window call, so rectangles are physical pixels.
# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 when available, else the old flag.
$ctx = [IntPtr](-4)
if ([Cap]::SetProcessDpiAwarenessContext($ctx)) { } else { [void][Cap]::SetProcessDPIAware() }

$title = $args[1]
# The dev build runs as "electron"; the packaged build runs under its own
# product name. Hardcoding one of them means the script silently reports
# NO_WINDOW for the other, which reads as "the app has no window" rather than
# "this script is looking for the wrong process".
$candidates = if ($args.Count -gt 2 -and $args[2] -ne '') { @($args[2]) } else { @('electron', 'Openfield') }

$proc = $null
foreach ($name in $candidates) {
  $proc = Get-Process $name -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and ($title -eq '' -or $_.MainWindowTitle -like "*$title*") } |
    Select-Object -First 1
  if ($proc) { break }
}

if (-not $proc) {
  Write-Output "NO_WINDOW (looked for: $($candidates -join ', '); title like '*$title*')"
  $seen = @($candidates | ForEach-Object { Get-Process $_ -ErrorAction SilentlyContinue })
  if ($seen.Count -gt 0) {
    Write-Output ("processes running: " + (($seen | ForEach-Object { "$($_.ProcessName)#$($_.Id) handle=$($_.MainWindowHandle)" }) -join '; '))
  } else {
    Write-Output "no matching process is running at all"
  }
  exit 1
}

$h = $proc.MainWindowHandle
[void][Cap]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 700

$r = New-Object Cap+RECT
[void][Cap]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
if ($w -le 0 -or $ht -le 0) { Write-Output "BAD_RECT"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 0x2 = PW_RENDERFULLCONTENT, required for composited/GPU-backed windows.
$ok = [Cap]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()

$out = Join-Path (Get-Location) $args[0]
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "SAVED $out  ${w}x${ht}  printWindow=$ok  title='$($proc.MainWindowTitle)'"