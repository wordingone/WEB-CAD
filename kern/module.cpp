// kern/module.cpp — Emscripten entry point (embind).
// JSON in / JSON out at the WASM boundary; no C++ exceptions escape.
// All other kern/ sources compile cleanly without <emscripten/bind.h>.

#include <emscripten/bind.h>
#include <string>
#include "boolean.h"
#include "brep.h"

// Phase C ops — stubs; will be replaced in C:Synth
// #include "fillet.h"
// #include "chamfer.h"
// #include "loft.h"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Wrap a BooleanResult into the standard { ok, result } or { ok, error } envelope.
static std::string boolResultToJson(const kern::BooleanResult& r) {
    if (!r.ok) {
        // Escape any double-quotes in the error string so the JSON stays valid.
        std::string msg = r.error;
        std::string escaped;
        escaped.reserve(msg.size());
        for (char c : msg) {
            if (c == '"')  escaped += "\\\"";
            else if (c == '\\') escaped += "\\\\";
            else escaped += c;
        }
        return R"({"ok":false,"error":{"code":"BOOLEAN_FAILED","message":")" + escaped + R"("}})";
    }
    return R"({"ok":true,"result":)" + kern::brepToJson(r.brep) + "}";
}

// Serialize a caught exception message into the error envelope.
static std::string exceptionEnvelope(const char* what) {
    std::string msg(what);
    std::string escaped;
    escaped.reserve(msg.size());
    for (char c : msg) {
        if (c == '"')  escaped += "\\\"";
        else if (c == '\\') escaped += "\\\\";
        else escaped += c;
    }
    return R"({"ok":false,"error":{"code":"EXCEPTION","message":")" + escaped + R"("}})";
}

// ---------------------------------------------------------------------------
// Boolean operations
// ---------------------------------------------------------------------------

// Single-dispatch entry point used by the TypeScript WasmBooleanBackend.
// jsonRequest shape:
//   { "op": "union"|"difference"|"intersection"|"section",
//     "a": <BrepJson>, "b": <BrepJson> }
// Response shape:
//   { "ok": true,  "result": <BrepJson> }
//   { "ok": false, "error": { "code": string, "message": string } }
static std::string kern_boolean(const std::string& jsonRequest) noexcept {
    try {
        auto req  = kern::parseJsonRequest(jsonRequest);  // throws on malformed JSON
        auto a    = kern::brepFromJson(req.aJson);
        auto b    = kern::brepFromJson(req.bJson);

        kern::BooleanResult r;
        if      (req.op == "union")        r = kern::boolUnion(a, b);
        else if (req.op == "difference")   r = kern::boolDifference(a, b);
        else if (req.op == "intersection") r = kern::boolIntersection(a, b);
        else if (req.op == "section")      r = kern::boolSection(a, b);
        else return R"({"ok":false,"error":{"code":"UNKNOWN_OP","message":"unknown op: )" + req.op + R"("}})";

        return boolResultToJson(r);
    } catch (const std::exception& e) {
        return exceptionEnvelope(e.what());
    } catch (...) {
        return R"({"ok":false,"error":{"code":"UNKNOWN","message":"unknown exception"}})";
    }
}

// Convenience per-op wrappers (retained for direct embind exposure + unit tests).

static std::string js_boolUnion(const std::string& aJson, const std::string& bJson) noexcept {
    try {
        kern::Brep a = kern::brepFromJson(aJson);
        kern::Brep b = kern::brepFromJson(bJson);
        return boolResultToJson(kern::boolUnion(a, b));
    } catch (const std::exception& e) { return exceptionEnvelope(e.what()); }
    catch (...) { return R"({"ok":false,"error":{"code":"UNKNOWN","message":"unknown exception"}})"; }
}

static std::string js_boolDifference(const std::string& aJson, const std::string& bJson) noexcept {
    try {
        kern::Brep a = kern::brepFromJson(aJson);
        kern::Brep b = kern::brepFromJson(bJson);
        return boolResultToJson(kern::boolDifference(a, b));
    } catch (const std::exception& e) { return exceptionEnvelope(e.what()); }
    catch (...) { return R"({"ok":false,"error":{"code":"UNKNOWN","message":"unknown exception"}})"; }
}

static std::string js_boolIntersection(const std::string& aJson, const std::string& bJson) noexcept {
    try {
        kern::Brep a = kern::brepFromJson(aJson);
        kern::Brep b = kern::brepFromJson(bJson);
        return boolResultToJson(kern::boolIntersection(a, b));
    } catch (const std::exception& e) { return exceptionEnvelope(e.what()); }
    catch (...) { return R"({"ok":false,"error":{"code":"UNKNOWN","message":"unknown exception"}})"; }
}

// ---------------------------------------------------------------------------
// Phase C stubs — fillet / chamfer / loft
// These return a not-implemented envelope until C:Synth fills them in.
// ---------------------------------------------------------------------------

// jsonRequest: { "brep": <BrepJson>, "radius": number, "edges": [index, ...] }
static std::string kern_fillet(const std::string& /*jsonRequest*/) noexcept {
    return R"({"ok":false,"error":{"code":"NOT_IMPLEMENTED","message":"fillet not yet implemented"}})";
}

// jsonRequest: { "brep": <BrepJson>, "distance": number, "edges": [index, ...] }
static std::string kern_chamfer(const std::string& /*jsonRequest*/) noexcept {
    return R"({"ok":false,"error":{"code":"NOT_IMPLEMENTED","message":"chamfer not yet implemented"}})";
}

// jsonRequest: { "profiles": [<BrepJson>, ...] }
static std::string kern_loft(const std::string& /*jsonRequest*/) noexcept {
    return R"({"ok":false,"error":{"code":"NOT_IMPLEMENTED","message":"loft not yet implemented"}})";
}

// ---------------------------------------------------------------------------
// SSI (surface-surface intersection) — thin pass-through to ssi.h
// ---------------------------------------------------------------------------

// jsonRequest: { "surfA": <NurbsSurfaceJson>, "surfB": <NurbsSurfaceJson>,
//                "options": { "tolerance": number } }
static std::string kern_ssi(const std::string& jsonRequest) noexcept {
    try {
        auto result = kern::ssi(jsonRequest);  // ssi() accepts raw JSON request
        return result;
    } catch (const std::exception& e) { return exceptionEnvelope(e.what()); }
    catch (...) { return R"({"ok":false,"error":{"code":"UNKNOWN","message":"unknown exception"}})"; }
}

// ---------------------------------------------------------------------------
// Emscripten bindings
// ---------------------------------------------------------------------------

EMSCRIPTEN_BINDINGS(kern) {
    // Primary single-dispatch entry point (preferred by wasm-backend.ts)
    emscripten::function("kern_boolean",      &kern_boolean);
    emscripten::function("kern_ssi",          &kern_ssi);
    emscripten::function("kern_fillet",       &kern_fillet);
    emscripten::function("kern_chamfer",      &kern_chamfer);
    emscripten::function("kern_loft",         &kern_loft);

    // Per-op convenience wrappers (two-arg form; kept for direct callers)
    emscripten::function("boolUnion",         &js_boolUnion);
    emscripten::function("boolDifference",    &js_boolDifference);
    emscripten::function("boolIntersection",  &js_boolIntersection);
}
