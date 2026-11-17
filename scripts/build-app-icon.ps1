param(
  [string]$InputPng = (Join-Path $PSScriptRoot '..\assets\asterium-icon.png'),
  [string]$OutputIco = (Join-Path $PSScriptRoot '..\assets\asterium.ico'),
  [ValidateRange(0, 0.1)][double]$InsetRatio = 0.025,
  [string]$OutputWindowPng = ([System.IO.Path]::ChangeExtension($OutputIco, '.window.png'))
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskImage = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $InputPng).Path)
try {
  # Trim the outer transparent margin before fitting the art into Windows icon slots.
  $taskInset = [int][Math]::Floor([Math]::Min($taskImage.Width, $taskImage.Height) * $InsetRatio)
  $taskSource = [Drawing.Rectangle]::new($taskInset, $taskInset, $taskImage.Width - 2 * $taskInset, $taskImage.Height - 2 * $taskInset)
  $taskSizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
  $taskFrames = @()
  foreach ($taskSize in $taskSizes) {
    $taskBitmap = [System.Drawing.Bitmap]::new($taskSize, $taskSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $taskGraphics = [System.Drawing.Graphics]::FromImage($taskBitmap)
    $taskStream = [System.IO.MemoryStream]::new()
    try {
      $taskGraphics.Clear([System.Drawing.Color]::Transparent)
      $taskGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $taskGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $taskDestination = [Drawing.Rectangle]::new(0, 0, $taskSize, $taskSize)
      $taskGraphics.DrawImage($taskImage, $taskDestination, $taskSource, [Drawing.GraphicsUnit]::Pixel)
      $taskBitmap.Save($taskStream, [System.Drawing.Imaging.ImageFormat]::Png)
      $taskFrames += ,$taskStream.ToArray()
    } finally { $taskGraphics.Dispose(); $taskBitmap.Dispose(); $taskStream.Dispose() }
  }
  # Electron's window and the Windows executable use the same icon artwork.
  [System.IO.File]::WriteAllBytes([System.IO.Path]::GetFullPath($OutputWindowPng), $taskFrames[-1])
  $taskOutput = [System.IO.MemoryStream]::new()
  $taskWriter = [System.IO.BinaryWriter]::new($taskOutput)
  try {
    $taskWriter.Write([uint16]0); $taskWriter.Write([uint16]1); $taskWriter.Write([uint16]$taskSizes.Length)
    $taskOffset = 6 + 16 * $taskSizes.Length
    for ($taskIndex = 0; $taskIndex -lt $taskSizes.Length; $taskIndex++) {
      $taskDimension = if ($taskSizes[$taskIndex] -eq 256) { 0 } else { $taskSizes[$taskIndex] }
      $taskWriter.Write([byte]$taskDimension); $taskWriter.Write([byte]$taskDimension)
      $taskWriter.Write([byte]0); $taskWriter.Write([byte]0)
      $taskWriter.Write([uint16]1); $taskWriter.Write([uint16]32)
      $taskWriter.Write([uint32]$taskFrames[$taskIndex].Length); $taskWriter.Write([uint32]$taskOffset)
      $taskOffset += $taskFrames[$taskIndex].Length
    }
    foreach ($taskFrame in $taskFrames) { $taskWriter.Write([byte[]]$taskFrame) }
    $taskWriter.Flush()
    [System.IO.File]::WriteAllBytes([System.IO.Path]::GetFullPath($OutputIco), $taskOutput.ToArray())
  } finally { $taskWriter.Dispose(); $taskOutput.Dispose() }
} finally { $taskImage.Dispose() }
Write-Output "Windows icon written: $OutputIco"
Write-Output "Window icon written: $OutputWindowPng"
