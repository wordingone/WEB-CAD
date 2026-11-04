# Third-party notices

WEB-CAD's own code is under the repository [LICENSE](LICENSE). It uses the components below, each under
its own license. Versions are the installed versions at the time of writing (2026-11-04, from
`node_modules/*/package.json`, matching `package.json`/`bun.lock`); licenses are as declared in each
package's `package.json`. This file is a notice list, not legal advice. Entries marked `UNKNOWN` have not been verified.

## Runtime dependencies (`package.json` `dependencies`)

| Package | Version | License | URL |
|---|---|---|---|
| @huggingface/transformers | 4.2.0 | Apache-2.0 | https://github.com/huggingface/transformers.js |
| @sentry/browser | 10.53.1 | MIT | https://github.com/getsentry/sentry-javascript |
| jspdf | 4.2.1 | MIT | https://github.com/parallax/jsPDF |
| replicad | 0.20.5 | MIT | https://replicad.xyz (homepage field in package.json; author Steve Genoud) |
| replicad-opencascadejs | 0.20.2 | MIT as declared; bundles OpenCASCADE Technology, which is LGPL-2.1 with exception (https://dev.opencascade.org/resources/licensing) | https://replicad.xyz (no repository field in package.json) |
| rhino3dm | 8.17.0 | MIT | https://github.com/mcneel/rhino3dm |
| three | 0.162.0 | MIT | https://github.com/mrdoob/three.js |
| three-bvh-csg | 0.0.18 | MIT | https://github.com/gkjohnson/three-bvh-csg |
| verb-nurbs | 3.0.3 | MIT | https://github.com/pboyer/verb |
| web-ifc | 0.0.77 | MPL-2.0 | https://github.com/ThatOpen/engine_web-ifc |

## C++ kernel build dependencies (`CMakeLists.txt`, `kern/third_party/README.md`)

| Component | Version | License | Source |
|---|---|---|---|
| Eigen | 3.4.0 | MPL-2.0 (as stated in `kern/third_party/README.md`) | https://gitlab.com/libeigen/eigen |
| nlohmann/json | 3.11.3 | MIT | https://github.com/nlohmann/json |
| googletest (tests only) | v1.14.0 | BSD-3-Clause | https://github.com/google/googletest |

## Files committed in `web/public/`

| File | Origin | License |
|---|---|---|
| `coi-serviceworker.js` | coi-serviceworker v0.1.7, Guido Zuidhof and contributors (header line 1) | MIT |
| `kern.wasm`, `kern.mjs` | Built from this repository's `kern/` C++ sources with Emscripten (links Eigen and nlohmann/json above) | Repository LICENSE for own code; components above |
| `litert_lm_main.wasm`, `litert_lm_main.js` | Per `MTP_DECODE_CONTRACT.md`: built from the LiteRT-LM CMake tree with emsdk 3.1.50. Exact upstream commit, build command and license text: UNKNOWN (not recorded in the repo; the owner or a build agent must look this up, not guess). Upstream project: LiteRT-LM (Google AI Edge). | UNKNOWN (upstream is expected to be Apache-2.0; verify) |
| `wasm-llama.wasm`, `wasm-llama.js` | Emscripten build of a llama-style inference runtime. Upstream project, version and build command: UNKNOWN (not recorded in the repo). | UNKNOWN |

## Model weights (not committed; downloaded at runtime)

Gemma 4 models are loaded from Hugging Face by `web/src/agent/agent-harness.ts` (`MODEL_ID_CANDIDATES`):
`onnx-community/gemma-4-E2B-it-ONNX`, `onnx-community/gemma-4-E4B-it-ONNX`,
`onnx-community/gemma-4-E4B-it-qat-mobile-ONNX`. They are governed by the Gemma terms of use
(https://ai.google.dev/gemma/terms) and the licenses on each Hugging Face model page. Check the model cards for current terms.

## Sample IFC files

Sample building models and their sources and licenses are listed in `submission/SAMPLES.md`
(e.g. `Schultz_Residence.ifc` is CC BY-ND 4.0, from opensourceBIM/IFC-files; the KIT reference files are credited to Karlsruhe Institute of Technology). Refer to that file for each license.
