; ═══════════════════════════════════════════════════════════════════════════
; PRISM — lo propio del instalador (electron-builder lo incluye solo).
;
; Prism se anota como navegador de Windows al arrancar (src/default-browser.cjs).
; Al desinstalarlo de verdad, eso se borra: si no, quedaría en Aplicaciones
; predeterminadas apuntando a un Prism.exe que ya no existe.
;
; Una actualización también corre el desinstalador de la versión vieja, con
; --updated: ahí no se toca nada, y la nueva se vuelve a anotar sola al abrir.
; Lo que se borra es lo mismo que removal() de default-browser.cjs (npm test
; vigila que coincidan).
; ═══════════════════════════════════════════════════════════════════════════

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Prism"
    DeleteRegKey HKCU "Software\Classes\PrismHTML"
    DeleteRegValue HKCU "Software\RegisteredApplications" "Prism"
    DeleteRegValue HKCU "Software\Classes\.htm\OpenWithProgids" "PrismHTML"
    DeleteRegValue HKCU "Software\Classes\.html\OpenWithProgids" "PrismHTML"
    DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "PrismHTML"
    DeleteRegValue HKCU "Software\Classes\.shtml\OpenWithProgids" "PrismHTML"
    DeleteRegValue HKCU "Software\Classes\.svg\OpenWithProgids" "PrismHTML"
    DeleteRegValue HKCU "Software\Classes\.webp\OpenWithProgids" "PrismHTML"
    DeleteRegValue HKCU "Software\Classes\.xht\OpenWithProgids" "PrismHTML"
    DeleteRegValue HKCU "Software\Classes\.xhtml\OpenWithProgids" "PrismHTML"
  ${endIf}
!macroend
