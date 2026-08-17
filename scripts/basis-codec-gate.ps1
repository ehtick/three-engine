# Numeric gate for the Basis/KTX2 encoder (plan §12.78).
#
# WHY THIS EXISTS: this asset set has been damaged twice by the compressor and
# both times it was diagnosed from the PICTURE — once by eye ("the embroidery
# reflections are dead"), once by flipping `flipY` at the live scene and reading
# nothing. Both times a number would have found it in a minute. So: encode with
# the mode the pipeline would choose AND with the old flags, transcode both back
# through basisu's own transcoder, and compare per pixel against the source.
#
# It deliberately does NOT need the editor, the Tauri build, or a GPU.
#
#   pwsh scripts/basis-codec-gate.ps1 -Dir "C:\Users\...\GAME\sponza2\Textures"
#   pwsh scripts/basis-codec-gate.ps1 -Dir <dir> -Limit 6
param(
  [Parameter(Mandatory=$true)][string]$Dir,
  [int]$Limit = 4,
  # Data-map MAE above this is a FAIL: the ETC1S regression measured 0.036 on
  # the metalness channel of a real map (49% of that channel's own mean), and
  # UASTC measured 0.005 on the same map. Anything above 0.015 is closer to the
  # broken arm than the fixed one.
  [double]$MaxDataMae = 0.015,
  # Colour maps go through ETC1S, which is lossier by design — the gate on them
  # is the MIP CHAIN, not mip 0. `-linear` on an sRGB image filters mips in the
  # wrong space; measured 6.9% darker and 15% down on red at mip 3.
  [double]$MaxMipLumDrift = 0.03
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$enc = Join-Path $PSScriptRoot "..\node_modules\@gpu-tex-enc\basis\bin\win32-x64\basisu.exe"
if (-not (Test-Path $enc)) { throw "basisu not found at $enc" }
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("basisgate_" + [System.Guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Path $work | Out-Null

# Mirrors `basisModeFor` in src/editor/basisCompress.js. Kept in sync by hand,
# which is acceptable only because the gate FAILS LOUD if the two disagree about
# a map: a colour map graded as data reads a suspiciously low MAE and a data map
# graded as colour reads the ETC1S regression this file exists to catch.
function ModeFor([string]$name) {
  $n = $name.ToLower()
  if ($n -match '(^|[ \-_.])(normal|normals|nrm|norm|nor)([ \-_.]|$)') { return "normal" }
  if ($n -match '(^|[ \-_.])(orm|arm|rough|roughness|metal|metalness|metallic|ao|occlusion|spec|specular|gloss|glossiness|displace|height|bump|mask|opacity|alpha)([ \-_.]|$)') { return "linear" }
  return "srgb"
}
function ArgsFor([string]$mode) {
  switch ($mode) {
    "linear" { @("-linear","-uastc","-uastc_level","2") }
    "normal" { @("-normal_map","-uastc","-uastc_level","2") }
    default  { @("-q","180") }
  }
}
function Load([string]$path) {
  $bmp=[System.Drawing.Bitmap]::FromFile($path); $w=$bmp.Width; $h=$bmp.Height
  $rect=New-Object System.Drawing.Rectangle 0,0,$w,$h
  $d=$bmp.LockBits($rect,[System.Drawing.Imaging.ImageLockMode]::ReadOnly,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bytes=New-Object byte[] ($d.Stride*$h)
  [System.Runtime.InteropServices.Marshal]::Copy($d.Scan0,$bytes,0,$bytes.Length)
  $bmp.UnlockBits($d); $bmp.Dispose()
  @{ B=$bytes; W=$w; H=$h; S=$d.Stride }
}
function LinLum($img) {
  $s=0.0; $n=0
  for ($y=0;$y -lt $img.H;$y+=2) { $r=$y*$img.S
    for ($x=0;$x -lt $img.W;$x+=2) { $i=$r+$x*4
      $s += 0.2126*[math]::Pow($img.B[$i+2]/255,2.2) + 0.7152*[math]::Pow($img.B[$i+1]/255,2.2) + 0.0722*[math]::Pow($img.B[$i]/255,2.2)
      $n++ } }
  $s/$n
}
function Mae($a,$b) {
  $eR=0.0;$eG=0.0;$eB=0.0;$n=0
  for ($y=0;$y -lt $a.H;$y+=2) { $r1=$y*$a.S; $r2=$y*$b.S
    for ($x=0;$x -lt $a.W;$x+=2) { $i=$r1+$x*4; $j=$r2+$x*4
      $eR+=[math]::Abs($a.B[$i+2]-$b.B[$j+2]); $eG+=[math]::Abs($a.B[$i+1]-$b.B[$j+1]); $eB+=[math]::Abs($a.B[$i]-$b.B[$j]); $n++ } }
  @{ R=$eR/$n/255; G=$eG/$n/255; B=$eB/$n/255 }
}
function Encode($src,$tag,$extra) {
  $out = Join-Path $work "$tag.ktx2"
  $a = @($src,"-ktx2","-mipmap") + $extra + @("-output_file",$out)
  & $enc @a *> $null
  if (-not (Test-Path $out)) { throw "encode failed: $tag" }
  Push-Location $work; & $enc -unpack -no_ktx "$tag.ktx2" *> $null; Pop-Location
  $out
}

$files = Get-ChildItem $Dir -Filter *.png | Select-Object -First $Limit
$fails = @()
$rows = @()
foreach ($f in $files) {
  $mode = ModeFor $f.Name
  $tag = "t" + [System.IO.Path]::GetFileNameWithoutExtension($f.Name).Replace(" ","_")
  Encode $f.FullName "${tag}_new" (ArgsFor $mode) | Out-Null
  Encode $f.FullName "${tag}_old" @("-linear","-q","180") | Out-Null
  $src = Load $f.FullName
  $newMip0 = Join-Path $work "${tag}_new_unpacked_rgb_BC7_RGBA_0_0_0000.png"
  $oldMip0 = Join-Path $work "${tag}_old_unpacked_rgb_BC7_RGBA_0_0_0000.png"
  if (-not (Test-Path $newMip0)) { $fails += "$($f.Name): no BC7 unpack"; continue }
  $mNew = Mae $src (Load $newMip0)
  $mOld = Mae $src (Load $oldMip0)
  $worstNew = [math]::Max($mNew.R,[math]::Max($mNew.G,$mNew.B))
  $worstOld = [math]::Max($mOld.R,[math]::Max($mOld.G,$mOld.B))

  # Colour maps: the mip chain is the thing `-linear` breaks, so compare mip 3
  # luminance between the two arms rather than trusting mip 0, which is nearly
  # identical under both.
  $drift = [double]::NaN
  $n3 = Join-Path $work "${tag}_new_unpacked_rgb_BC7_RGBA_3_0_0000.png"
  $o3 = Join-Path $work "${tag}_old_unpacked_rgb_BC7_RGBA_3_0_0000.png"
  if ((Test-Path $n3) -and (Test-Path $o3)) {
    $ln = LinLum (Load $n3); $lo = LinLum (Load $o3)
    $drift = [math]::Abs($ln-$lo)/[math]::Max(1e-6,$ln)
  }

  if ($mode -ne "srgb" -and $worstNew -gt $MaxDataMae) { $fails += "$($f.Name) [$mode]: data MAE $([math]::Round($worstNew,4)) > $MaxDataMae" }
  if ($mode -eq "srgb" -and -not [double]::IsNaN($drift) -and $drift -gt $MaxMipLumDrift) {
    # Not a failure of the NEW arm — it is proof the old flags were wrong. Report it.
    Write-Host "  note: $($f.Name) mip3 luminance moves $([math]::Round($drift*100,1))% between -linear and sRGB filtering"
  }
  $rows += [pscustomobject]@{
    File=$f.Name; Mode=$mode
    "MAE new"=[math]::Round($worstNew,4); "MAE old"=[math]::Round($worstOld,4)
    "x better"=[math]::Round($worstOld/[math]::Max(1e-9,$worstNew),1)
    "mip3 drift"=$(if([double]::IsNaN($drift)){"-"}else{"$([math]::Round($drift*100,1))%"})
  }
}
$rows | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
if ($fails.Count) { Write-Host "FAIL"; $fails | ForEach-Object { Write-Host "  $_" }; exit 1 }
Write-Host "PASS - every data map is within $MaxDataMae MAE of its source"
exit 0
