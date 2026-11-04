@echo off
rem Required environment variables (no defaults; paths are machine-specific):
rem   EMBASE     Emscripten toolchain root (contains emscripten\, node\, python\)
rem   EM_CONFIG  path to the .emscripten config file (e.g. %USERPROFILE%\.emscripten)
rem Optional: SRC (repo root, default %~dp0), BDIR (build dir, default %SRC%\kern-build-em2)
if "%EMBASE%"=="" (
  echo ERROR: set EMBASE to your Emscripten toolchain root, and EM_CONFIG to your .emscripten file.
  exit /b 1
)
if "%EM_CONFIG%"=="" (
  echo ERROR: set EM_CONFIG to your .emscripten config file.
  exit /b 1
)
set EMSDK_PYTHON=%EMBASE%\python\python.exe
set PATH=%EMBASE%\emscripten;%EMBASE%\node\20.18.0_64bit;%EMBASE%\python;%PATH%

if "%SRC%"=="" set SRC=%~dp0
if "%BDIR%"=="" set BDIR=%SRC%\kern-build-em2

if "%1"=="configure" goto CONFIGURE
if "%1"=="build" goto BUILD
echo Usage: build-kern.bat [configure|build]
exit /b 1

:CONFIGURE
echo Configuring with emcmake...
set SYSROOT=%EMBASE%\emscripten\cache\sysroot
emcmake cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="%SYSROOT%" -S "%SRC%" -B "%BDIR%"
exit /b %ERRORLEVEL%

:BUILD
echo Building kern target...
cmake --build "%BDIR%" --target kern --parallel
exit /b %ERRORLEVEL%
