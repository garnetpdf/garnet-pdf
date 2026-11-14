!include "nsDialogs.nsh"
!ifndef BUILD_UNINSTALLER
Var AssociatePDF
!macro customPageAfterChangeDir
  Page custom GarnetAssociationPage GarnetAssociationLeave
!macroend
Function GarnetAssociationPage
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateCheckbox} 0 12u 100% 12u "Add Garnet PDF to Open with for PDF files (optional)"
  Pop $AssociatePDF
  nsDialogs::Show
FunctionEnd
Function GarnetAssociationLeave
  ${NSD_GetState} $AssociatePDF $AssociatePDF
FunctionEnd
!macro customInstall
  ${If} $AssociatePDF == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Classes\GarnetPDF.Document" "" "Garnet PDF Document"
    WriteRegStr HKCU "Software\Classes\GarnetPDF.Document\DefaultIcon" "" "$INSTDIR\Garnet PDF.exe,0"
    WriteRegStr HKCU "Software\Classes\GarnetPDF.Document\shell\open\command" "" '$\"$INSTDIR\Garnet PDF.exe$\" $\"%1$\"'
    WriteRegNone HKCU "Software\Classes\.pdf\OpenWithProgids" "GarnetPDF.Document"
  ${EndIf}
!macroend
!endif
!macro customUnInstall
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "GarnetPDF.Document"
  DeleteRegKey HKCU "Software\Classes\GarnetPDF.Document"
!macroend
