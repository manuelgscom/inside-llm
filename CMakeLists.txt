cmake_minimum_required(VERSION 3.24)
project(inside_llm VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Build options:
#   ILS_BACKEND  GPU backend of llama.cpp: CUDA (default), VULKAN or METAL (macOS).
#   ILS_DIST     portable binary for distribution: no -march=native (ggml's
#                x86-64 baseline instead: AVX2, FMA, F16C, BMI2) and no NCCL.
set(ILS_BACKEND CUDA CACHE STRING "GPU backend of llama.cpp: CUDA, VULKAN or METAL")
set_property(CACHE ILS_BACKEND PROPERTY STRINGS CUDA VULKAN METAL)
option(ILS_DIST "Portable build for distribution (no -march=native, no NCCL)" OFF)

# llama.cpp as a static library. Tools, examples, server and tests are
# already off when llama.cpp is not the top-level project.
if(ILS_BACKEND STREQUAL "CUDA")
    set(GGML_CUDA   ON  CACHE BOOL "" FORCE)
    set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
    set(GGML_METAL  OFF CACHE BOOL "" FORCE)
elseif(ILS_BACKEND STREQUAL "VULKAN")
    set(GGML_CUDA   OFF CACHE BOOL "" FORCE)
    set(GGML_VULKAN ON  CACHE BOOL "" FORCE)
    set(GGML_METAL  OFF CACHE BOOL "" FORCE)
elseif(ILS_BACKEND STREQUAL "METAL")
    if(NOT APPLE)
        message(FATAL_ERROR "ILS_BACKEND=METAL needs macOS")
    endif()
    set(GGML_CUDA   OFF CACHE BOOL "" FORCE)
    set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
    set(GGML_METAL  ON  CACHE BOOL "" FORCE)
    # The Metal shaders are embedded as source and compiled by the driver at
    # start-up, so the Metal toolchain of Xcode is not needed.
    set(GGML_METAL_EMBED_LIBRARY ON CACHE BOOL "" FORCE)
else()
    message(FATAL_ERROR "ILS_BACKEND must be CUDA, VULKAN or METAL, not '${ILS_BACKEND}'")
endif()
if(ILS_DIST)
    set(GGML_NATIVE    OFF CACHE BOOL "" FORCE)
    set(GGML_CUDA_NCCL OFF CACHE BOOL "" FORCE)  # multi-GPU only; would need libnccl at run time
endif()
set(BUILD_SHARED_LIBS  OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON ON  CACHE BOOL "" FORCE)  # chat templates (Jinja) and the cpp-httplib target
# HTTPS for the Hugging Face downloads (hf_download.cpp): LibreSSL fetched
# and built statically with cpp-httplib, so the binary needs no libssl or
# libcrypto at run time. LLAMA_OPENSSL stays off: no system OpenSSL.
set(LLAMA_OPENSSL        OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_LIBRESSL ON  CACHE BOOL "" FORCE)
# Where LibreSSL looks for the system's CA certificates (cert.pem and the
# hashed certs/ folder): /etc/ssl covers Debian, Ubuntu, Fedora, Arch,
# openSUSE and Alpine; its default would be /usr/local/etc/ssl, which no
# distribution fills. On Windows cpp-httplib reads the system store.
if(NOT WIN32)
    set(OPENSSLDIR /etc/ssl CACHE PATH "" FORCE)
endif()
add_subdirectory(third_party/llama.cpp llama.cpp EXCLUDE_FROM_ALL)

# Windows (MSVC): the default dynamic CRT (/MD), as llama.cpp and CUDA use.
# zlib comes from vcpkg with the x64-windows-static-md triplet (static
# library, dynamic CRT); a /MT triplet would not link with the rest.
if(MSVC AND VCPKG_TARGET_TRIPLET MATCHES "-static$")
    message(FATAL_ERROR "vcpkg triplet ${VCPKG_TARGET_TRIPLET} uses the static CRT (/MT); "
                        "use x64-windows-static-md")
endif()

find_package(Threads REQUIRED)
# libz.a: one dependency less at run time. Not on macOS: its SDK ships zlib
# only as a system dylib (libz.tbd), which every Mac has.
if(NOT WIN32 AND NOT APPLE)
    set(ZLIB_USE_STATIC_LIBS ON)
endif()
find_package(ZLIB REQUIRED)

# Only for the targets below, not for llama.cpp (added above).
if(WIN32)
    add_compile_definitions(NOMINMAX WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
endif()
if(MSVC)
    add_compile_options(/utf-8)
    # /W3 without the integer-narrowing noise that -Wall -Wextra does not report either.
    set(ILS_WARNINGS /W3 /wd4244 /wd4267)
else()
    set(ILS_WARNINGS -Wall -Wextra)
endif()

# ------------------------------------------------------------------ core
# Everything except llama.cpp: tree, metrics, frames, log, session, server.
# Tests link only this, so they need neither a model nor the GPU.
add_library(ils_core STATIC
    engine/src/app.cpp
    engine/src/catalog.cpp
    engine/src/frames.cpp
    engine/src/gates.cpp
    engine/src/gzip.cpp
    engine/src/hf.cpp
    engine/src/hub.cpp
    engine/src/lens.cpp
    engine/src/log.cpp
    engine/src/metrics.cpp
    engine/src/server.cpp
    engine/src/session.cpp
    engine/src/snapshots.cpp
    engine/src/tree.cpp)
target_include_directories(ils_core PUBLIC engine/src)
# ggml-base: only its GGUF reader (catalog.cpp); no backend, no GPU.
target_link_libraries(ils_core PUBLIC cpp-httplib vendor::nlohmann ggml-base ZLIB::ZLIB Threads::Threads)
target_compile_definitions(ils_core PUBLIC ILS_APP_VERSION="${PROJECT_VERSION}")
target_compile_options(ils_core PRIVATE ${ILS_WARNINGS})
if(WIN32)
    target_link_libraries(ils_core PUBLIC shell32)  # ShellExecuteW (open_browser)
endif()
# The lens projection is a dot-product loop over a 2 GB matrix: built for the
# same vector units as ggml itself, this CPU's with GGML_NATIVE or ggml's
# portable x86-64 baseline (AVX2, FMA, F16C) otherwise.
if(GGML_NATIVE AND NOT MSVC)
    set_source_files_properties(engine/src/lens.cpp PROPERTIES COMPILE_OPTIONS -march=native)
elseif(GGML_AVX2 AND CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|AMD64|amd64)$")
    if(MSVC)
        set_source_files_properties(engine/src/lens.cpp PROPERTIES COMPILE_OPTIONS /arch:AVX2)
    else()
        set_source_files_properties(engine/src/lens.cpp PROPERTIES COMPILE_OPTIONS "-mavx2;-mfma;-mf16c")
    endif()
endif()

# ------------------------------------------------------------ embedded web
# web/dist (built by `make web-build`) gzipped into C++ arrays.
set(ILS_WEB_DIST ${CMAKE_SOURCE_DIR}/web/dist)
set(ILS_WEB_CPP  ${CMAKE_BINARY_DIR}/web_assets.cpp)
# Every file, re-globbed on each build: Vite names the assets by their hash,
# so a new web build adds and removes files.
file(GLOB_RECURSE ILS_WEB_FILES CONFIGURE_DEPENDS ${ILS_WEB_DIST}/*)
add_custom_command(
    OUTPUT  ${ILS_WEB_CPP}
    COMMAND ${CMAKE_COMMAND} -DDIST=${ILS_WEB_DIST} -DOUT=${ILS_WEB_CPP}
            -P ${CMAKE_SOURCE_DIR}/cmake/embed_web.cmake
    DEPENDS ${ILS_WEB_DIST}/index.html ${ILS_WEB_FILES} ${CMAKE_SOURCE_DIR}/cmake/embed_web.cmake
    COMMENT "Embedding web/dist"
    VERBATIM)
add_library(ils_web STATIC ${ILS_WEB_CPP})
target_include_directories(ils_web PUBLIC engine/src)

# ---------------------------------------------------------------- binary
add_executable(inside-llm engine/src/main.cpp engine/src/model.cpp engine/src/llama_gates.cpp
                          engine/src/llama_lens.cpp engine/src/hf_download.cpp)
if(WIN32)
    # UTF-8 as the process code page: argv, fopen and std::filesystem take
    # non-ASCII paths as UTF-8, as ggml does.
    target_sources(inside-llm PRIVATE engine/win/inside-llm.manifest)
endif()
target_link_libraries(inside-llm PRIVATE ils_core ils_web llama llama-common)
target_compile_options(inside-llm PRIVATE ${ILS_WARNINGS})
if(ILS_DIST AND UNIX)
    # The Linux package carries libgomp and the CUDA libraries next to the
    # binary (packaging/linux/build.sh): look there, and nowhere else.
    set_target_properties(inside-llm PROPERTIES BUILD_WITH_INSTALL_RPATH ON INSTALL_RPATH "\$ORIGIN")
endif()

# ----------------------------------------------------------------- tests
enable_testing()
add_subdirectory(engine/tests)
