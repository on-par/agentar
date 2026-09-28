@echo off
rem Double-click to start Agentar: the bridge starts and the avatar opens in your browser.
rem In a checkout of this repo this installs and builds when needed, then runs `npm start`.
rem Copied anywhere else, it runs the released package: npx agentar@0.1.0 start
setlocal
cd /d "%~dp0.."
where node >nul 2>nul || (echo Agentar needs Node.js 24 or newer. Install it from https://nodejs.org and try again.& goto :fail)
if not exist package.json goto :release
if not exist packages\cli goto :release
if not exist node_modules\.package-lock.json (
  echo Installing dependencies ^(first run only^)...
  call npm install || goto :fail
)
set NEEDS_BUILD=
if not exist packages\cli\dist\index.js set NEEDS_BUILD=1
if not exist apps\web\dist\index.html set NEEDS_BUILD=1
if defined NEEDS_BUILD (
  echo Building Agentar...
  call npm run build || goto :fail
)
echo Starting Agentar. Your browser opens in a moment: click the page once so it may play sound, then use the Talk tab.
call npm start || goto :fail
goto :eof
:release
echo Starting agentar@0.1.0...
call npx --yes agentar@0.1.0 start || goto :fail
goto :eof
:fail
echo.
pause
exit /b 1
