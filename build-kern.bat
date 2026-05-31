@echo off
set EMBASE=C:\Program Files\Unity\Hub\Editor\6000.2.6f2\Editor\Data\PlaybackEngines\WebGLSupport\BuildTools\Emscripten
set EMSDK_PYTHON=%EMBASE%\python\python.exe
set EM_CONFIG=C:\Users\Admin\.emscripten
set PATH=%EMBASE%\emscripten;%EMBASE%\node\20.18.0_64bit;%EMBASE%\python;%PATH%

set SRC=B:\M\WEB-CAD-archie
set BDIR=B:\M\WEB-CAD-archie\kern-build-em2

if "%1"=="configure" goto CONFIGURE
if "%1"=="build" goto BUILD
echo Usage: build-kern.bat [configure|build]
exit /b 1

:CONFIGURE
echo Configuring with emcmake...
set SYSROOT=C:/Program Files/Unity/Hub/Editor/6000.2.6f2/Editor/Data/PlaybackEngines/WebGLSupport/BuildTools/Emscripten/emscripten/cache/sysroot
emcmake cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="%SYSROOT%" -S "%SRC%" -B "%BDIR%"
exit /b %ERRORLEVEL%

:BUILD
echo Building kern target...
cmake --build "%BDIR%" --target kern --parallel
exit /b %ERRORLEVEL%
