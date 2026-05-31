cmake_minimum_required(VERSION 3.25)
project(kern LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---------------------------------------------------------------------------
# Dependencies — FetchContent (header-only; no dynamic libs)
# ---------------------------------------------------------------------------

include(FetchContent)

# Eigen 3.4.0 — linear algebra
FetchContent_Declare(eigen
    GIT_REPOSITORY https://gitlab.com/libeigen/eigen.git
    GIT_TAG        3.4.0
    GIT_SHALLOW    TRUE)
FetchContent_MakeAvailable(eigen)

# nlohmann/json 3.11.3 — WASM boundary serialization
FetchContent_Declare(json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG        v3.11.3
    GIT_SHALLOW    TRUE)
FetchContent_MakeAvailable(json)

# ---------------------------------------------------------------------------
# kern_lib — compiles cleanly under GCC/Clang AND Emscripten.
# module.cpp is excluded here; it is added only in the EMSCRIPTEN target.
# ---------------------------------------------------------------------------

add_library(kern_lib STATIC
    kern/brep.cpp
    kern/ssi.cpp
    kern/boolean.cpp
    kern/fillet.cpp
    kern/chamfer.cpp
    kern/loft.cpp)

target_include_directories(kern_lib PUBLIC
    kern/
    ${eigen_SOURCE_DIR}
    ${json_SOURCE_DIR}/include)

# ---------------------------------------------------------------------------
# EMSCRIPTEN target — produces kern.mjs + kern.wasm
# ---------------------------------------------------------------------------

if(EMSCRIPTEN)
    add_executable(kern kern/module.cpp)
    target_link_libraries(kern PRIVATE kern_lib)
    set_target_properties(kern PROPERTIES SUFFIX ".mjs")

    target_link_options(kern PRIVATE
        -sEXPORT_ES6=1
        -sMODULARIZE=1
        -sSINGLE_FILE=0
        -sEXPORTED_FUNCTIONS=["_kern_boolean","_kern_ssi","_kern_fillet","_kern_chamfer","_kern_loft"]
        -sEXPORTED_RUNTIME_METHODS=["UTF8ToString","stringToUTF8","lengthBytesUTF8"]
        -sALLOW_MEMORY_GROWTH=1
        -sMAXIMUM_MEMORY=1gb
        -O3
        -msimd128
        --closure 1)

# ---------------------------------------------------------------------------
# Native target — unit tests via Google Test
# ---------------------------------------------------------------------------

else()
    enable_testing()

    FetchContent_Declare(googletest
        GIT_REPOSITORY https://github.com/google/googletest.git
        GIT_TAG        v1.14.0
        GIT_SHALLOW    TRUE)
    FetchContent_MakeAvailable(googletest)

    add_subdirectory(kern/test)
endif()
