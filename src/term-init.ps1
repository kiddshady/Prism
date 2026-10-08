# ═══════════════════════════════════════════════════════════════════════════
#  PRISM — arranque de la terminal
#  Corre DESPUÉS del $PROFILE de siempre (core-profile y el prompt de NTX
#  incluidos): Prism lanza pwsh con -NoExit -Command ". $env:PRISM_TERM_INIT".
#  No cambia nada de afuera: solo esta sesión.
#
#  · UTF-8 de punta a punta (sin esto, las cajas del prompt y los acentos
#    llegan como signos de pregunta).
#  · El prompt de NTX en grises, acromático. Lo demás (PSReadLine, $PSStyle)
#    con sus colores de siempre, que la paleta de la terminal pone suaves.
#  · El prompt avisa en qué carpeta está (OSC 7): la barra de abajo de la
#    terminal muestra la ruta y el branch sin preguntarle nada a la shell.
#  · Y cuándo arranca y termina un comando (OSC 133): el «run» de la barra.
#
#  Tiene que andar con Set-StrictMode -Version Latest (lo prende el core-profile).
# ═══════════════════════════════════════════════════════════════════════════

if (Get-Variable -Name __PrismTermInit -Scope Global -ErrorAction SilentlyContinue) { return }
$global:__PrismTermInit = $true

$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8
$global:OutputEncoding = $utf8

# ── La escala ──────────────────────────────────────────────────────────────
# Grises en truecolor, así no dependen de la paleta de la terminal.
function global:__PrismGray([int]$v, [switch]$Bold) {
    $b = if ($Bold) { '1;' } else { '' }
    "$([char]27)[${b}38;2;$v;$v;${v}m"
}

# ── El prompt de NTX, en grises ────────────────────────────────────────────
# ntx-prompt.ps1 lee $global:NtxColors cada vez que dibuja: alcanza con
# pisarlo acá. Los nombres quedan los de NTX (Magenta, Yellow, Cyan): son las
# claves que él busca, no los colores que llevan ahora.
if (Get-Variable -Name NtxColors -Scope Global -ErrorAction SilentlyContinue) {
    $global:NtxColors = @{
        Reset   = "$([char]27)[0m"
        Magenta = (__PrismGray 214)   # el usuario y el branch
        Yellow  = (__PrismGray 158)   # el host
        Cyan    = (__PrismGray 240)   # la ruta: lo que más se mira
        Dim     = (__PrismGray 108)   # @ · in · on
    }
}

# ── Lo demás: los colores de siempre ───────────────────────────────────────
# PSReadLine (lo que se tipea) y $PSStyle (tablas, carpetas, avisos, errores)
# quedan con sus colores de fábrica. Son los 16 de ANSI, y esos los pone la
# paleta de la terminal (renderer/js/terminal.js): los de siempre, apagados
# al tono de Prism. Por eso acá no se tocan.

# ── Dónde está (OSC 7) y cuánto tardó (OSC 133) ────────────────────────────
# Envuelve el prompt que ya hay (el de NTX) en vez de reemplazarlo. Los avisos
# van con [Console]::Write y no en el string que devuelve el prompt: PSReadLine
# mide ese string para saber dónde empieza a escribir.
#
# El «run» de la barra de abajo: 133;C cuando se suelta un comando y 133;D
# cuando vuelve el prompt. La C la marca el lector de líneas, y PSReadLine
# define PSConsoleHostReadLine recién antes de la primera lectura (después de
# este archivo): se envuelve en el primer prompt que la encuentre.
$global:__PrismInnerPrompt = $function:prompt
function global:prompt {
    [Console]::Write("$([char]27)]133;D$([char]7)")
    if (-not (Test-Path variable:global:__PrismReadLine) -and (Test-Path function:global:PSConsoleHostReadLine)) {
        $global:__PrismReadLine = $function:PSConsoleHostReadLine
        function global:PSConsoleHostReadLine {
            $line = & $global:__PrismReadLine
            # Un Enter en vacío no arranca nada.
            if ($line -and $line.Trim()) { [Console]::Write("$([char]27)]133;C$([char]7)") }
            $line
        }
    }
    $loc = $ExecutionContext.SessionState.Path.CurrentLocation
    if ($loc.Provider.Name -eq 'FileSystem') {
        $p = $loc.ProviderPath.Replace('\', '/').Replace('%', '%25').Replace(' ', '%20').Replace('#', '%23').Replace('?', '%3F')
        [Console]::Write("$([char]27)]7;file:///$p$([char]7)")
    }
    if ($global:__PrismInnerPrompt) { return (& $global:__PrismInnerPrompt) }
    return "PS $($loc.Path)> "
}

$env:TERM_PROGRAM = 'Prism'
