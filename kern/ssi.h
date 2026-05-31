#pragma once
#include <vector>
#include <string>
#include <Eigen/Dense>
#include "brep.h"

namespace kern {

struct SsiOptions {
    double tolerance      = 1e-4;   // geometric tolerance, world units
    int    maxDepth       = 8;      // bbox subdivision depth per axis
    int    maxIter        = 50;     // Newton iterations per seed
    double marchStep      = 0.01;   // march distance, world units
    int    maxSteps       = 1000;   // safety cap per march half
    int    maxLeaves      = 50;     // cap on bbox-leaf Newton calls per face pair; degenerate identical faces hit 65536+, 50 is fast-fail while keeping real booleans viable (real overlaps typically need 10-30 leaves)
};

struct SsiCurve {
    std::vector<Eigen::Vector3d>              pts3d;
    std::vector<std::pair<double, double>>    paramsA;  // (u0, v0)
    std::vector<std::pair<double, double>>    paramsB;  // (u1, v1)
    bool closed     = false;
    bool degenerate = false;
};

struct SsiResult {
    bool                    ok = true;
    std::vector<SsiCurve>   curves;
    std::string             error;
};

SsiResult ssi(const NurbsSurface& a,
              const NurbsSurface& b,
              const SsiOptions&   opts = {});

} // namespace kern
