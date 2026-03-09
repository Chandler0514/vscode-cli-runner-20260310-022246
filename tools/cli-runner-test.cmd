@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "arg1=%~1"
set "arg2=%~2"

if /I "%arg1%"=="-h" goto :help
if /I "%arg1%"=="--help" goto :help
if /I "%arg1%"=="/?" goto :help
if "%arg1%"=="" goto :help

if /I "%arg1%"=="build" goto :build
if /I "%arg1%"=="test" goto :test
if /I "%arg1%"=="deploy" goto :deploy
if /I "%arg1%"=="longrun" goto :longrun
if /I "%arg1%"=="noisy" goto :noisy
if /I "%arg1%"=="flood" goto :flood
if /I "%arg1%"=="stderr-only" goto :stderr_only
if /I "%arg1%"=="exit-zero" goto :exit_zero
if /I "%arg1%"=="exit-fail" goto :exit_fail
if /I "%arg1% %arg2%"=="quotes demo" goto :quotes_demo

echo Unknown command: %* 1>&2
exit /b 1

:help
echo CLI Runner Test Tool
echo.
echo Usage:
echo   cli-runner-test ^<command^>
echo.
echo Commands:
echo   build         Build sample project with progress percent
echo   test - Run tests and emit warning/error on stderr
echo   deploy: Simulate deployment output and success
echo   quotes demo   Multi-token command to test splitArgs handling
echo   longrun       Long running task for cancellation test
echo   noisy         30 lines of mixed stdout/stderr
echo   flood         4205 lines to test output capture limit
echo   stderr-only   Emits only stderr and exits 0
echo   exit-zero     Exits with code 0 and no output
echo   exit-fail     Exits with code 7 and no output
echo.
echo Options:
echo   -h, --help    Show help
echo.
echo Examples:
echo   cli-runner-test build
echo   cli-runner-test quotes demo
exit /b 0

:build
echo Starting build...
echo progress 5%%
call :sleep1
echo progress 25%%
call :sleep1
echo progress 60%%
call :sleep1
echo progress 100%%
echo done: build complete
exit /b 0

:test
echo Running tests...
echo warn: flaky case on windows 1>&2
call :sleep1
echo error: 2 tests failed 1>&2
exit /b 2

:deploy
echo Deploy started
echo validate config
echo upload artifacts
echo success: deployment complete
exit /b 0

:quotes_demo
echo Running multi-token command: "%arg1% %arg2%"
echo output line with "quoted text" and 'single quotes'
echo finished quotes demo
exit /b 0

:longrun
echo longrun started
for /L %%i in (1,1,20) do (
  set /a pct=%%i*5
  echo step %%i/20 - !pct!%%
  call :sleep1
)
echo longrun complete
exit /b 0

:noisy
for /L %%i in (1,1,30) do (
  echo stdout line %%i
  if %%i==7 echo warn: line %%i has warning signal
  if %%i==18 echo error: simulated recoverable error 1>&2
)
echo noisy done
exit /b 0

:flood
for /L %%i in (1,1,4205) do (
  echo flood line %%i
)
echo flood done
exit /b 0

:stderr_only
echo stderr-only: this is stderr 1>&2
echo stderr-only: still fine 1>&2
exit /b 0

:exit_zero
exit /b 0

:exit_fail
exit /b 7

:sleep1
ping 127.0.0.1 -n 2 >nul
exit /b 0
