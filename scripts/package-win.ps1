# Builds a self-contained portable Windows bundle of Movni Cockpit.
# Output: a folder + zip containing a portable node.exe, the compiled app,
# its node_modules, the .env, and a double-click start.cmd. The target machine
# needs NOTHING installed -- just extract and run start.cmd.
#
# Usage (from anywhere):  powershell -ExecutionPolicy Bypass -File scripts\package-win.ps1

$ErrorActionPreference = 'Stop'

# Junction-safe, long-path-safe recursive delete. /MIR mirrors an empty dir onto
# the target (so it copes with >260-char paths); /XJ means we NEVER follow a
# junction (e.g. a "file:.." self-dependency) whose target we must not touch.
function Remove-TreeSafe($path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $empty = Join-Path $env:TEMP ('empty_' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $empty | Out-Null
  robocopy $empty $path /MIR /XJ /NFL /NDL /NJH /NJS /NP /R:0 /W:0 | Out-Null
  Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
}

# --- paths -----------------------------------------------------------------
$root = Split-Path -Parent $PSScriptRoot           # project root
$out = Join-Path $root 'dist-portable'             # staging + zip live here
$app = Join-Path $out 'movni-cockpit'              # the bundled "app root"
$zip = Join-Path $root 'movni-cockpit-portable-win64.zip'

Write-Host "Project root: $root"

# --- 1. build client + server ---------------------------------------------
Write-Host "`n[1/5] Building client..."
npm --prefix (Join-Path $root 'client') run build | Out-Null

Write-Host "[2/5] Compiling server..."
$serverDir = Join-Path $root 'server'
Remove-TreeSafe (Join-Path $serverDir 'dist')
npm --prefix $serverDir run build | Out-Null

# --- 2. fresh staging ------------------------------------------------------
Write-Host "[3/5] Assembling bundle..."
Remove-TreeSafe $out
$null = New-Item -ItemType Directory -Force -Path `
  (Join-Path $app 'server'), `
  (Join-Path $app 'client\dist'), `
  (Join-Path $app 'templates'), `
  (Join-Path $app 'storage\contracts'), `
  (Join-Path $app 'node')

# --- 3. copy app payload ---------------------------------------------------
# server: compiled dist + node_modules + package.json (robocopy for speed)
robocopy (Join-Path $serverDir 'dist') (Join-Path $app 'server\dist') /E /NFL /NDL /NJH /NJS /NP | Out-Null
robocopy (Join-Path $serverDir 'node_modules') (Join-Path $app 'server\node_modules') /E /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
Copy-Item (Join-Path $serverDir 'package.json') (Join-Path $app 'server\package.json')
# client build
robocopy (Join-Path $root 'client\dist') (Join-Path $app 'client\dist') /E /NFL /NDL /NJH /NJS /NP | Out-Null
# templates (include the real .docx if present)
robocopy (Join-Path $root 'templates') (Join-Path $app 'templates') /E /NFL /NDL /NJH /NJS /NP | Out-Null
# .env (contains the DB connection string -- keep the zip private!)
Copy-Item (Join-Path $root '.env') (Join-Path $app '.env')
# keep the contracts folder present + writable
Set-Content (Join-Path $app 'storage\contracts\.gitkeep') ''
# portable node runtime
Copy-Item (Get-Command node).Source (Join-Path $app 'node\node.exe')

# --- 4. launcher + instructions -------------------------------------------
Write-Host "[4/5] Writing launcher..."
$startCmd = @'
@echo off
title Movni Cockpit
cd /d "%~dp0server"
set OPEN_BROWSER=1
echo Iniciando o Movni Cockpit...
echo O navegador abrira automaticamente. Se nao abrir, acesse: http://localhost:5178
echo (Para encerrar, feche esta janela.)
echo.
"%~dp0node\node.exe" dist\index.js
pause
'@
Set-Content -Path (Join-Path $app 'start.cmd') -Value $startCmd -Encoding ASCII

$readme = @'
MOVNI COCKPIT - Instalacao portatil (Windows 64-bit)
=====================================================

Nao precisa instalar nada. Passos:

1) Extraia TODA esta pasta para um local com permissao de escrita,
   por exemplo:  C:\Users\SEU_USUARIO\movni-cockpit
   (Nao rode de dentro do arquivo .zip -- extraia primeiro.)

2) De um duplo clique em  start.cmd
   O navegador abre automaticamente em  http://localhost:5178
   Se nao abrir, digite esse endereco no navegador.

3) FACA LOGIN com o usuario e a senha do banco de dados (fornecidos
   separadamente). O programa so abre apos conectar ao banco.
   Se aparecer erro de conexao, verifique a internet.

Para encerrar: feche a janela preta do start.cmd.

Observacao: o usuario e a senha NAO ficam salvos no computador --
sao pedidos a cada vez que o programa e aberto.

Observacao (PDF): para baixar documentos em PDF, instale o LibreOffice
(gratuito, em libreoffice.org). Sem ele, os documentos ainda podem ser
baixados em Word (.docx) normalmente.
'@
Set-Content -Path (Join-Path $app 'COMO-INSTALAR.txt') -Value $readme -Encoding UTF8

# --- 5. zip ----------------------------------------------------------------
Write-Host "[5/5] Zipping..."
if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($app, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)

$zipMB = "{0:N1}" -f ((Get-Item $zip).Length / 1MB)
Write-Host "`nDONE. Bundle: $zip  ($zipMB MB)"
