// kern/module.cpp — Emscripten entry point (embind).
// JSON in / JSON out at the WASM boundary; no C++ exceptions escape.
// All other kern/ sources compile cleanly without <emscripten/bind.h>.

#include <emscripten/bind.h>
#include <string>
#include <nlohmann/json.hpp>
#include "boolean.h"
#include "brep.h"

// Phase C ops — wired in C:Synth
#include "fillet.h"
#include "chamfer.h"
#include "loft.h"

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
// Phase C — fillet / chamfer / loft (real implementations)
// ---------------------------------------------------------------------------

// Helper: escape a string for embedding in a JSON string value.
static std::string jsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if      (c == '"')  out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else out += c;
    }
    return out;
}

// jsonRequest: { "brep": <BrepJson>, "radius": number, "edges": [index, ...] }
static std::string kern_fillet(const std::string& jsonRequest) noexcept {
    try {
        auto j = nlohmann::json::parse(jsonRequest);
        kern::Brep b = kern::brepFromJson(j.at("brep").dump());
        double radius = j.at("radius").get<double>();
        std::vector<int> edgeIndices;
        if (j.contains("edges")) {
            for (auto& idx : j["edges"]) edgeIndices.push_back(idx.get<int>());
        }
        kern::FilletOptions opts;
        opts.radius = radius;
        opts.edgeIndices = std::move(edgeIndices);
        auto r = kern::fillet(b, opts);
        if (!r.ok)
            return R"({"ok":false,"error":{"code":"FILLET_FAILED","message":")" + jsonEscape(r.error) + R"("}})";
        return R"({"ok":true,"result":)" + kern::brepToJson(r.brep) + "}";
    } catch (const std::exception& e) { return exceptionEnvelope(e.what()); }
    catch (...) { return R"({"ok":false,"error":{"code":"UNKNOWN","message":"unknown exception"}})"; }
}

// jsonRequest: { "brep": <BrepJson>, "distance": number, "edges": [index, ...] }
static std::string kern_chamfer(const std::string& jsonRequest) noexcept {
    try {
        auto j = nlohmann::json::parse(jsonRequest);
        kern::Brep b = kern::brepFromJson(j.at("brep").dump());
        double distance = j.at("distance").get<double>();
        std::vector<int> edgeIndices;
        if (j.contains("edges")) {
            for (auto& idx : j["edges"]) edgeIndices.push_back(idx.get<int>());
        }
        kern::ChamferOptions opts;
        opts.distance = distance;
        opts.edgeIndices = std::move(edgeIndices);
        auto r = kern::chamfer(b, opts);
        if (!r.ok)
            return R"({"ok":false,"error":{"code":"CHAMFER_FAILED","message":")" + jsonEscape(r.error) + R"("}})";
        return R"({"ok":true,"result":)" + kern::brepToJson(r.brep) + "}";
    } catch (const std::exception& e) { return exceptionEnvelope(e.what()); }
    catch (...) { return R"({"ok":false,"error":{"code":"UNKNOWN","message":"unknown exception"}})"; }
}

// jsonRequest: { "profiles": [ <NurbsCurveJson>, ... ], "degree": number }
// Each profile is a NurbsCurve (cvCount, degree, knots, cvs).
static std::string kern_loft(const std::string& jsonRequest) noexcept {
    try {
        auto j = nlohmann::json::parse(jsonRequest);
        std::vector<kern::NurbsCurve> profiles;
        for (auto& pj : j.at("profiles")) {
            kern::NurbsCurve c;
            c.degree   = pj.at("degree").get<int>();
            c.cvCount  = pj.at("cvCount").get<int>();
            for (auto& k : pj.at("knots"))  c.knots.push_back(k.get<double>());
            const auto& cvsArr = pj.at("cvs");
            for (size_t i = 0; i + 3 < cvsArr.size(); i += 4) {
                c.cvs.push_back({cvsArr[i].get<double>(),   cvsArr[i+1].get<double>(),
                                 cvsArr[i+2].get<double>(), cvsArr[i+3].get<double>()});
            }
            profiles.push_back(std::move(c));
        }
        int degree = j.value("degree", 3);
        kern::LoftOptions opts;
        opts.degree = degree;
        auto r = kern::loft(profiles, opts);
        if (!r.ok)
            return R"({"ok":false,"error":{"code":"LOFT_FAILED","message":")" + jsonEscape(r.error) + R"("}})";
        return R"({"ok":true,"result":)" + kern::brepToJson(r.brep) + "}";
    } catch (const std::exception& e) { return exceptionEnvelope(e.what()); }
    catch (...) { return R"({"ok":false,"error":{"code":"UNKNOWN","message":"unknown exception"}})"; }
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
