Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 900, 520
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(236,229,221))
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(7,94,84))), 0, 0, 900, 70)
$f1 = New-Object System.Drawing.Font 'Segoe UI', 22, ([System.Drawing.FontStyle]::Bold)
$f2 = New-Object System.Drawing.Font 'Segoe UI', 20
$w = [System.Drawing.Brushes]::White; $k = [System.Drawing.Brushes]::Black
$g.DrawString('WhatsApp - Alice Tester', $f1, $w, 20, 15)
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), 40, 110, 560, 70)
$g.DrawString('Alice: Lunch at 1? Table 7 is booked.', $f2, $k, 52, 128)
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(220,248,198))), 300, 220, 560, 70)
$g.DrawString('Me: Yes, see you at 1 pm.', $f2, $k, 312, 238)
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), 40, 330, 560, 70)
$g.DrawString('Alice: Code word is PINEAPPLE-4417', $f2, $k, 52, 348)
$bmp.Save('D:\PandeshVisionTest\synthetic-whatsapp.png', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
