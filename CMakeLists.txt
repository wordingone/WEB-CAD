cmake_minimum_required(VERSION 3.25)
project(kern LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---------------------------------------------------------------------------
# Dependencies — FetchContent (header-only; no dynamic libs)
# ---------------------------------------------------------------------------

include(FetchContent)

# Eigen 3.4.0 — linear algebra
# Short-circuit when vendored sources are present (avoids emcc compiler-feature
# test overhead in FetchContent_MakeAvailable which runs Eigen's CMakeLists.txt).
set(_eigen_vendor "${CMAKE_CURRENT_SOURCE_DIR}/kern/third_party/eigen-src")
if(EXISTS "${_eigen_vendor}/Eigen/Core")
    set(eigen_SOURCE_DIR "${_eigen_vendor}")
    message(STATUS "Eigen: using vendored sources at ${eigen_SOURCE_DIR}")
else()
    FetchContent_Declare(eigen
        GIT_REPOSITORY https://gitlab.com/libeigen/eigen.git
        GIT_TAG        3.4.0
        GIT_SHALLOW    TRUE)
    set(EIGEN_BUILD_DOC OFF CACHE BOOL "" FORCE)
    set(EIGEN_BUILD_TESTING OFF CACHE BOOL "" FORCE)
    set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
    FetchContent_MakeAvailable(eigen)
endif()

# nlohmann/json 3.11.3 — WASM boundary serialization
set(_json_vendor "${CMAKE_CURRENT_SOURCE_DIR}/kern/third_party/json-src")
if(EXISTS "${_json_vendor}/include/nlohmann/json.hpp")
    set(json_SOURCE_DIR "${_json_vendor}")
    message(STATUS "nlohmann/json: using vendored sources at ${json_SOURCE_DIR}")
else()
    FetchContent_Declare(json
        GIT_REPOSITORY https://github.com/nlohmann/json.git
        GIT_TAG        v3.11.3
        GIT_SHALLOW    TRUE)
    set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
    set(JSON_Install OFF CACHE BOOL "" FORCE)
    FetchContent_MakeAvailable(json)
endif()

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
        --bind
        -sEXPORT_ES6=1
        -sMODULARIZE=1
        -sSINGLE_FILE=0
        -sALLOW_MEMORY_GROWTH=1
        -sMAXIMUM_MEMORY=1gb
        -O3
        -msimd128)

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
