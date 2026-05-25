import { registerHandler, dispatch } from "../commands/dispatch";
import { listClusters, getClusterByName, listCanvasClusters, type SkillClusterStep } from "../skills/skill-store";
import { STARTER_LIBRARY } from "../skills/starter-library";

function _translateClusterStep(params: Record<string, unknown>, anchor: number[]): Record<string, unknown> {
  if (typeof params["hostUuid"] === "string" || typeof params["uuid"] === "string") {
    return params;
  }
  const [dx, dy, dz] = anchor;
  const out = { ...params };
  const POINT_KEYS = ["position", "origin", "point", "start", "end", "center", "anchor"];
  const POLYLINE_KEYS = ["points", "profile", "path", "spine"];
  for (const key of POINT_KEYS) {
    const v = out[key];
    if (Array.isArray(v) && v.length >= 2 && (v as unknown[]).every(x => typeof x === "number")) {
      out[key] = [(v[0] as number) + dx, (v[1] as number) + dy, v.length >= 3 ? (v[2] as number) + dz : 0];
    }
  }
  for (const key of POLYLINE_KEYS) {
    const v = out[key];
    if (Array.isArray(v) && v.length > 0 && Array.isArray(v[0])) {
      out[key] = (v as number[][]).map(pt => {
        if (!pt.every(x => typeof x === "number")) return pt;
        const translated: number[] = [(pt[0] ?? 0) + dx, (pt[1] ?? 0) + dy];
        if (pt.length >= 3) translated.push((pt[2] ?? 0) + dz);
        return translated;
      });
    }
  }
  return out;
}

export function registerSkillHandlers(): void {
  registerHandler("SdRunCluster", async (args) => {
    const name = args["name"] as string;
    const repeat = Math.max(1, typeof args["repeat"] === "number" ? (args["repeat"] as number) : 1);
    const anchorRaw = args["anchor"];
    const anchor = Array.isArray(anchorRaw) && anchorRaw.length >= 2
      ? (anchorRaw as number[])
      : null;
    const cluster = await getClusterByName(name);
    if (!cluster) return { ok: false, error: `No cluster named "${name}"` };
    const skipped: string[] = [];
    for (let r = 0; r < repeat; r++) {
      for (const step of cluster.steps as SkillClusterStep[]) {
        const rawParams = step.params as Record<string, unknown>;
        const params = anchor ? _translateClusterStep(rawParams, anchor) : rawParams;
        if (anchor && params === rawParams && (typeof rawParams["hostUuid"] === "string" || typeof rawParams["uuid"] === "string")) {
          skipped.push(step.verb);
        }
        await dispatch(step.verb, params);
        await new Promise(res => setTimeout(res, 50));
      }
    }
    return { ok: true, ran: cluster.steps.length * repeat, skipped };
  });

  registerHandler("SdListClusters", async () => {
    const clusters = await listClusters();
    return { clusters: clusters.map(c => ({ name: c.name, steps: c.steps.length, createdAt: c.createdAt })) };
  });

  registerHandler("SdInvokeSkill", async (args) => {
    const skillName = args["skill"] as string;
    const params = (args["params"] && typeof args["params"] === "object" && !Array.isArray(args["params"]))
      ? args["params"] as Record<string, unknown>
      : {};

    const starter = STARTER_LIBRARY.find(d => d.label === skillName || d.id === skillName);
    if (starter) {
      await dispatch(starter.verb, { ...starter.args, ...params });
      return { ok: true, source: "starter", verb: starter.verb };
    }

    const canvasClusters = await listCanvasClusters();
    const cluster = canvasClusters.find(c => c.name === skillName);
    if (cluster) {
      type CNode = { id: string; skillSteps: { verb: string; args: Record<string, unknown> }[]; inPorts: number; outPorts: number };
      type CEdge = { from: string; to: string };
      const { nodes, edges } = JSON.parse(cluster.graphJson) as { nodes: CNode[]; edges: CEdge[] };

      const inDegree = new Map<string, number>(nodes.map(n => [n.id, 0]));
      for (const e of edges) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
      const queue = nodes.filter(n => (inDegree.get(n.id) ?? 0) === 0).map(n => n.id);
      const order: string[] = [];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        order.push(cur);
        for (const e of edges) {
          if (e.from === cur) {
            const d = (inDegree.get(e.to) ?? 1) - 1;
            inDegree.set(e.to, d);
            if (d === 0) queue.push(e.to);
          }
        }
      }
      const nodeMap = new Map<string, CNode>(nodes.map(n => [n.id, n]));
      let fired = 0;
      for (const id of order) {
        const node = nodeMap.get(id);
        if (!node) continue;
        for (const step of node.skillSteps) {
          const mergedArgs = fired === 0 ? { ...step.args, ...params } : step.args;
          await dispatch(step.verb, mergedArgs);
          await new Promise(res => setTimeout(res, 50));
          fired++;
        }
      }
      return { ok: true, source: "canvas-cluster", fired };
    }

    return { ok: false, error: `No skill named "${skillName}" found in starter library or saved clusters` };
  });
}
