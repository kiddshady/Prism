# ═══════════════════════════════════════════════════════════════════════════
#  PRISM — arranque de la terminal
#  Corre DESPUÉS del $PROFILE de siempre (core-profile y el prompt de NTX
#  incluidos): Prism lanza pwsh con -NoExit -Command ". $env:PRISM_TERM_INIT".
#  No cambia nada de afuera: solo esta sesión.
#
#  · UTF-8 de punta a punta (sin esto, las cajas del prompt y los acentos
#    llegan como signos de pregunta).
#  · Los colores, en la escala de Prism: acromático, de blanco a gris. El rojo
#    queda para el error, que es lo único que dice que algo se rompió.
#  · El prompt avisa en qué carpeta está (OSC 7): la barra de abajo de la
#    terminal muestra la ruta y el branch sin preguntarle nada a la shell.
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
$global:__PrismDanger = "$([char]27)[38;2;212;103;107m"

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

# ── PSReadLine: lo que se tipea ────────────────────────────────────────────
if (Get-Module PSReadLine) {
    $colors = @{
        Default                = (__PrismGray 232)
        Command                = (__PrismGray 240 -Bold)
        Parameter              = (__PrismGray 150)
        String                 = (__PrismGray 196)
        Variable               = (__PrismGray 222)
        Number                 = (__PrismGray 222)
        Member                 = (__PrismGray 204)
        Type                   = (__PrismGray 176)
        Operator               = (__PrismGray 140)
        Keyword                = (__PrismGray 236)
        Comment                = (__PrismGray 112)
        Emphasis               = (__PrismGray 244 -Bold)
        ContinuationPrompt     = (__PrismGray 108)
        InlinePrediction       = (__PrismGray 104)
        ListPrediction         = (__PrismGray 150)
        ListPredictionSelected = "$([char]27)[48;2;46;46;50m"
        Selection              = "$([char]27)[48;2;64;65;68m"
        Error                  = $global:__PrismDanger
    }
    # De a una: una versión de PSReadLine que no conoce una clave tira error
    # por todo el lote.
    foreach ($k in $colors.Keys) {
        try { Set-PSReadLineOption -Colors @{ $k = $colors[$k] } } catch { }
    }
}

# ── $PSStyle: tablas, archivos, avisos ─────────────────────────────────────
if (Get-Variable -Name PSStyle -ErrorAction SilentlyContinue) {
    try {
        $PSStyle.Formatting.TableHeader = (__PrismGray 236 -Bold)
        $PSStyle.Formatting.CustomTableHeaderLabel = (__PrismGray 176)
        $PSStyle.Formatting.FormatAccent = (__PrismGray 236 -Bold)
        $PSStyle.Formatting.Warning = (__PrismGray 236 -Bold)
        $PSStyle.Formatting.Verbose = (__PrismGray 150)
        $PSStyle.Formatting.Debug = (__PrismGray 150)
        $PSStyle.Formatting.Error = $global:__PrismDanger
        $PSStyle.Formatting.ErrorAccent = "$([char]27)[1m$global:__PrismDanger"
        $PSStyle.Progress.Style = (__PrismGray 200)
        $PSStyle.FileInfo.Directory = (__PrismGray 240 -Bold)
        $PSStyle.FileInfo.SymbolicLink = (__PrismGray 176)
        $PSStyle.FileInfo.Executable = (__PrismGray 222)
        # Las extensiones vienen de color (los .zip en rojo, los .ps1 en amarillo).
        $PSStyle.FileInfo.Extension.Clear()
    } catch { }
}

# ── Dónde está (OSC 7) ─────────────────────────────────────────────────────
# Envuelve el prompt que ya hay (el de NTX) en vez de reemplazarlo. El aviso
# va con [Console]::Write y no en el string que devuelve el prompt: PSReadLine
# mide ese string para saber dónde empieza a escribir.
$global:__PrismInnerPrompt = $function:prompt
function global:prompt {
    $loc = $ExecutionContext.SessionState.Path.CurrentLocation
    if ($loc.Provider.Name -eq 'FileSystem') {
        $p = $loc.ProviderPath.Replace('\', '/').Replace('%', '%25').Replace(' ', '%20').Replace('#', '%23').Replace('?', '%3F')
        [Console]::Write("$([char]27)]7;file:///$p$([char]7)")
    }
    if ($global:__PrismInnerPrompt) { return (& $global:__PrismInnerPrompt) }
    return "PS $($loc.Path)> "
}

$env:TERM_PROGRAM = 'Prism'
