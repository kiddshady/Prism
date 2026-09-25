<#
.SYNOPSIS
  Captura la ventana de Prism tal como se ve (cromo + página) a un PNG.

.DESCRIPTION
  Usa PrintWindow con PW_RENDERFULLCONTENT: es lo que captura lo que compone
  Chromium con DirectComposition, incluidas las vistas de las páginas, que
  un capturePage() del renderer NO ve (esa foto es solo del cromo).
#>
param(
  [string]$Out = (Join-Path $PSScriptRoot '..\.shots\prism.png'),
  [string]$Title = 'Prism'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@

# Puede haber más de una ventana con ese título (popups de un sitio): gana la
# más grande, que es la del navegador.
$found = [IntPtr]::Zero
$best = 0
$cb = [Win+EnumProc]{
  param($h, $l)
  if (-not [Win]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][Win]::GetWindowText($h, $sb, 512)
  $t = $sb.ToString()
  if ($t -eq $Title -or $t.EndsWith(" — $Title")) {
    $rr = New-Object Win+RECT
    [void][Win]::GetWindowRect($h, [ref]$rr)
    $area = ($rr.R - $rr.L) * ($rr.B - $rr.T)
    if ($area -gt $script:best) { $script:best = $area; $script:found = $h }
  }
  return $true
}
[void][Win]::EnumWindows($cb, [IntPtr]::Zero)
if ($found -eq [IntPtr]::Zero) { throw "No encontré la ventana de $Title" }

$r = New-Object Win+RECT
[void][Win]::GetWindowRect($found, [ref]$r)
$w = $r.R - $r.L; $h = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[void][Win]::PrintWindow($found, $dc, 2)
$g.ReleaseHdc($dc)
$dir = Split-Path $Out -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "$Out ($w x $h)"
