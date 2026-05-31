# kern/third_party — vendored fallback headers

These directories are used only when the FetchContent paths in CMakeLists.txt
are unavailable (e.g. air-gapped build, CI without git access).

The primary build path is FetchContent; this directory is a manual fallback.

## Eigen

Version: 3.4.0
License: MPL2 (header-only, no object-code link requirement)

Populate with:

    git clone --depth 1 --branch 3.4.0 https://gitlab.com/libeigen/eigen.git eigen-src
    cp -r eigen-src/Eigen kern/third_party/eigen/Eigen
    rm -rf eigen-src

Expected layout after copy:

    kern/third_party/eigen/Eigen/Core
    kern/third_party/eigen/Eigen/Dense
    ...

To use instead of FetchContent, add to CMakeLists.txt before the
FetchContent block:

    set(EIGEN3_INCLUDE_DIR ${CMAKE_SOURCE_DIR}/kern/third_party/eigen)
    include_directories(${EIGEN3_INCLUDE_DIR})

## nlohmann/json

Version: 3.11.3
License: MIT (single-header, no link requirement)

Populate with:

    curl -L https://github.com/nlohmann/json/releases/download/v3.11.3/json.hpp \
         -o kern/third_party/json/nlohmann/json.hpp

Expected layout after download:

    kern/third_party/json/nlohmann/json.hpp

To use instead of FetchContent, add to CMakeLists.txt:

    include_directories(${CMAKE_SOURCE_DIR}/kern/third_party/json)
