Add-Type -AssemblyName System.Drawing
$icoPath = (Resolve-Path "Logo CR.ico").Path
$buildPng = (Join-Path (Get-Location) "build\icon.png")
$rootPng = (Join-Path (Get-Location) "icon.png")
$publicPng = (Join-Path (Get-Location) "frontend\public\icon.png")

$ico = New-Object System.Drawing.Icon($icoPath)
$bmp = $ico.ToBitmap()
$bmp.Save($buildPng, [System.Drawing.Imaging.ImageFormat]::Png)

Copy-Item $buildPng $rootPng -Force
Copy-Item $buildPng $publicPng -Force
Copy-Item $icoPath (Join-Path (Get-Location) "build\icon.ico") -Force
Copy-Item $icoPath (Join-Path (Get-Location) "icon.ico") -Force
Copy-Item $icoPath (Join-Path (Get-Location) "frontend\public\favicon.ico") -Force

Write-Host "✅ Logo CR.ico convertido e copiado para todas as pastas com sucesso!"
