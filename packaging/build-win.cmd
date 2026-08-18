@echo off
setlocal

REM ============================================================
REM  pi-studio Windows desktop build (double-click to run)
REM
REM  1) Redirect home dirs to avoid Windows user-dir junction /
REM     WindowsApps causing next build EPERM / EACCES
REM  2) Clean previous leftovers (.next / dist-desktop) so we
REM     always build from a clean state, ignoring any
REM     dist-desktop/win-unpacked intermediate artifacts
REM  3) pause at the end keeps the window open on success or
REM     failure so the log is always visible
REM
REM  No administrator required. Mirror config lives in the
REM  project-root .npmrc (cwd-level), unaffected by HOME redirect.
REM  The real data dir is re-injected by desktop/main.js at runtime.
REM ============================================================

REM Fake home dir (inside project, does not touch real user dir)
set "BH=%~dp0..\.buildhome"
if not exist "%BH%" mkdir "%BH%"

REM Core fix: redirect home-related env vars so next build no
REM longer scans the real user directory
set "USERPROFILE=%BH%"
set "HOMEDRIVE=%BH:~0,2%"
set "HOMEPATH=%BH:~2%"
set "HOME=%BH%"
set "APPDATA=%BH%\AppData\Roaming"
set "LOCALAPPDATA=%BH%\AppData\Local"
if not exist "%LOCALAPPDATA%" mkdir "%LOCALAPPDATA%"

REM Switch to project root (this file is in packaging\, parent is root)
cd /d "%~dp0.."

echo [1/3] Cleaning previous leftovers (.next / dist-desktop)...
if exist .next         rmdir /s /q .next
if exist dist-desktop  rmdir /s /q dist-desktop
echo        done

echo [2/3] Building: next build + runtime + electron-builder
echo       (first run downloads Node runtime and NSIS tools, please wait)
call npm run desktop:dist
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo [3/3] Build succeeded! Upload these two files to the update server:
  for %%f in (dist-desktop\pi-studio-Setup-*.exe) do echo        %CD%\%%f
  echo        %CD%\dist-desktop\latest.json
) else (
  echo [3/3] Build FAILED, exit code %RC%. See errors above.
)
echo.
echo Press any key to close this window...
pause >nul
endlocal
