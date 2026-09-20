@echo off
rem Launch the packaged ISA Bench desktop app with the lane data it needs.
rem
rem ISA_SIM_DATA_DIR points the embedded backend at the native corpus and job
rem database built under this repository instead of its own userData folder.
rem ISA_SIM_REPOSITORY_ROOT makes it read this repository's sources and
rem capability locks rather than the copies frozen into the package at build
rem time, so a regenerated lock takes effect without repackaging.

setlocal

set "ISA_SIM_REPOSITORY_ROOT=%~dp0"
if "%ISA_SIM_REPOSITORY_ROOT:~-1%"=="\" set "ISA_SIM_REPOSITORY_ROOT=%ISA_SIM_REPOSITORY_ROOT:~0,-1%"
set "ISA_SIM_DATA_DIR=%ISA_SIM_REPOSITORY_ROOT%\.isa-bench-data"

rem Inherited from an Electron parent (e.g. a VS Code terminal) this would make
rem the Electron binary run as plain Node and fail to start.
set "ELECTRON_RUN_AS_NODE="

set "ISA_BENCH_EXE=%ISA_SIM_REPOSITORY_ROOT%\release\win-unpacked\ISA Bench.exe"
if not exist "%ISA_BENCH_EXE%" (
  echo Could not find "%ISA_BENCH_EXE%".
  echo Build it first with: npm run desktop:pack:win
  exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo WARNING: the Docker daemon is not responding.
  echo Real toolchain validation and research simulators will stay unavailable
  echo until Docker Desktop is running. Start it, then run this again.
  echo.
)

cd /d "%ISA_SIM_REPOSITORY_ROOT%"
start "" "%ISA_BENCH_EXE%"
endlocal
