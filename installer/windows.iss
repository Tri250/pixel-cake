; ========================================================================
; Pixel Cake - Windows Installer (Inno Setup)
; ========================================================================
; This script creates a professional Windows installer (setup.exe)
; for the Pixel Cake AI photo editor application.
;
; Build: iscc installer/windows.iss
; Requires: Inno Setup 6.x (installed on windows-latest runner)
; ========================================================================

#define MyAppName "Pixel Cake"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Pixel Cake Team"
#define MyAppExeName "PixelCake.exe"
#define MyAppPublisherURL "https://github.com/Tri250/pixel-cake"
#define MyAppSupportURL "https://github.com/Tri250/pixel-cake/issues"
#define MyAppUpdatesURL "https://github.com/Tri250/pixel-cake/releases"
#define MyAppCopyright "Copyright (C) 2025 Pixel Cake Team"

[Setup]
; Basic
AppId={{B8E3F2A1-4D5C-6E7F-8A9B-0C1D2E3F4A5B}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppPublisherURL}
AppSupportURL={#MyAppSupportURL}
AppUpdatesURL={#MyAppUpdatesURL}
AppCopyright={#MyAppCopyright}

; Installation
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763

; Output
OutputDir=installer_output
OutputBaseFilename=PixelCake-Setup-{#MyAppVersion}-Windows
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}

; Flags
DisableProgramGroupPage=yes
DisableWelcomePage=no
DisableDirPage=no
AlwaysShowComponentsList=no

[Languages]
Name: "english"; MessagesFile: "English.isl"
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Messages]
; Custom messages
WelcomeLabel2=This wizard will install [name/ver]\n\nPixel Cake is an AI-powered photo editor that runs entirely on your machine.

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"; Flags: checkedonce
Name: "startupicon"; Description: "Add to Start Menu"; GroupDescription: "Additional icons:"; Flags: checkedonce
Name: "associate"; Description: "Associate .pixelcake project files"; GroupDescription: "File Associations:"; Flags: checkedonce

[Files]
; Main application - PyInstaller bundle
Source: "..\dist\PixelCake.exe"; DestDir: "{app}"; Flags: ignoreversion

; Frontend resources
Source: "..\frontend\dist\*"; DestDir: "{app}\frontend"; Flags: recursesubdirs createallsubdirs

; Backend services
Source: "..\backend\services\*"; DestDir: "{app}\backend\services"; Flags: recursesubdirs createallsubdirs
Source: "..\backend\utils\*"; DestDir: "{app}\backend\utils"; Flags: recursesubdirs createallsubdirs

; Models and cascades
Source: "..\backend\models\cascades\*.xml"; DestDir: "{app}\backend\models\cascades"; Flags: ignoreversion createallsubdirs
Source: "..\backend\models\*.tflite"; DestDir: "{app}\backend\models"; Flags: ignoreversion

; Launcher and setup
Source: "..\launcher.py"; DestDir: "{app}"
Source: "..\setup.py"; DestDir: "{app}"
Source: "..\pixel-cake.spec"; DestDir: "{app}"
Source: "..\build.bat"; DestDir: "{app}"
Source: "..\run.bat"; DestDir: "{app}"

; Python backend core for source-mode fallback
Source: "..\backend\requirements.txt"; DestDir: "{app}\backend"

; README
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

; Documentation
Source: "..\installer\install.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\installer\uninstall.bat"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{app}\uninstall.bat"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{group}\Documentation"; Filename: "{app}\README.md"; WorkingDir: "{app}"

[Run]
; Launch the application after installation (optional, user can uncheck)
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
// ========================================================================
// Code section - custom installation logic
// ========================================================================

function IsPythonInstalled(): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  Exec('cmd.exe', '/c python --version', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if ResultCode = 0 then
    Result := True;
end;

function GetPythonVersion(): string;
var
  ResultCode: Integer;
  Output: string;
begin
  Result := '';
  Exec('cmd.exe', '/c python --version 2>&1', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // Parse version if needed
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  DataDir: string;
  BatchPath: string;
begin
  if CurStep = ssPostInstall then
  begin
    // Create data directory in user's APPDATA
    DataDir := ExpandConstant('{userappdata}\PixelCake');
    ForceDirectories(DataDir + '\uploads');
    ForceDirectories(DataDir + '\outputs');
    ForceDirectories(DataDir + '\temp');

    // Create a proper start.bat that handles both EXE and source modes
    BatchPath := ExpandConstant('{app}\start.bat');
    SaveStringToFile(BatchPath,
      '@echo off' + #13#10 +
      'chcp 65001 >nul 2>&1' + #13#10 +
      'cd /d "%~dp0"' + #13#10 +
      'echo ================================================' + #13#10 +
      'echo   Pixel Cake v{#MyAppVersion} - AI Photo Editor' + #13#10 +
      'echo ================================================' + #13#10 +
      'echo.' + #13#10 +
      'if exist "PixelCake.exe" (' + #13#10 +
      '    echo Starting application...' + #13#10 +
      '    start "" PixelCake.exe' + #13#10 +
      ') else (' + #13#10 +
      '    echo Checking Python environment...' + #13#10 +
      '    where python >nul 2>&1' + #13#10 +
      '    if errorlevel 1 (' + #13#10 +
      '        echo [ERROR] Python not found!' + #13#10 +
      '        echo Please install Python 3.10+ from https://python.org' + #13#10 +
      '        pause' + #13#10 +
      '        exit /b 1' + #13#10 +
      '    )' + #13#10 +
      '    echo Installing dependencies...' + #13#10 +
      '    python -m pip install -r backend\requirements.txt -q' + #13#10 +
      '    echo Starting server...' + #13#10 +
      '    python launcher.py' + #13#10 +
      ')' + #13#10 +
      'pause',
      False);

    // Create uninstall helper that cleans APPDATA
    BatchPath := ExpandConstant('{app}\uninstall_data.bat');
    SaveStringToFile(BatchPath,
      '@echo off' + #13#10 +
      'chcp 65001 >nul 2>&1' + #13#10 +
      'echo Cleaning Pixel Cake data...' + #13#10 +
      'rd /s /q "%APPDATA%\PixelCake" 2>nul' + #13#10 +
      'if exist "%APPDATA%\PixelCake" (' + #13#10 +
      '    echo Some files could not be removed.' + #13#10 +
      '    echo Please manually delete: %APPDATA%\PixelCake' + #13#10 +
      ') else (' + #13#10 +
      '    echo Data removed successfully.' + #13#10 +
      ')' + #13#10 +
      'echo.' + #13#10 +
      'echo Please manually delete the Pixel Cake folder to complete uninstall.' + #13#10 +
      'pause',
      False);
  end;
end;

function UninstallNeedRest(): Boolean;
begin
  // Return True if we need a restart
  Result := False;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: string;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    // Offer to clean data directory
    DataDir := ExpandConstant('{userappdata}\PixelCake');
    if DirExists(DataDir) then
    begin
      if MsgBox('Do you want to remove Pixel Cake user data?' + #13#10 +
                '(This includes uploads, outputs, and temporary files)' + #13#10 + #13#10 +
                'Location: ' + DataDir,
                mbConfirmation, MB_YESNO) = IDYES then
      begin
        DelTree(DataDir, True, True, True);
      end;
    end;
  end;
end;

[UninstallDelete]
; Cleanup additional items
Type: filesandordirs; Name: "{userappdata}\PixelCake"
