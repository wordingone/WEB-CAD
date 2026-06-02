// agent-instance.ts — isolated AgentInstance sessions for N>1 parallel agents (#1122).
//
// Each instance owns its own conversation history; all instances share the same
// loaded model weights via the injected runner (runAgentTurn in production).
// No second model load occurs — VRAM delta for N=2 instances is effectively zero
// (only CPU-RAM history arrays are added per instance).
//
// Usage (production):
//   import { createAgentInstance } from "./agent-harness";
//   const a = createAgentInstance("agent-A");
//   const b = createAgentInstance("agent-B");
//   await a.ask("draw a 5m wall");
//   await b.ask("draw a 3m wall");
//   // a.history and b.history are completely isolated

import type { AgentRequest, AgentResponse } from "./agent-harness";
import { selectAgentRole, type AgentRole } from "./agent-roles";

export type AgentTurn = { role: "user" | "assistant"; content: string };

export type AgentInstance = {
  readonly id: string;
  readonly name: string;
  readonly role: AgentRole | undefined;
  readonly history: AgentTurn[];
  ask(prompt: string, options?: Partial<AgentRequest>): Promise<AgentResponse>;
  reset(): void;
};

type AgentRunner = (req: AgentRequest) => Promise<AgentResponse>;

/** Returns a `createAgentInstance` factory bound to the given runner.
 *  Production code uses `makeAgentInstanceFactory(runAgentTurn)`.
 *  Tests inject a mock runner to avoid loading WebGPU/ONNX deps. */
export function makeAgentInstanceFactory(runner: AgentRunner) {
  return function createAgentInstance(name: string, role?: AgentRole): AgentInstance {
    const id = `agent-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const _history: AgentTurn[] = [];
    return {
      get id() { return id; },
      get name() { return name; },
      get role() { return role; },
      // Returns the live array — callers may read but should not mutate externally.
      get history() { return _history; },
      async ask(prompt: string, options?: Partial<AgentRequest>): Promise<AgentResponse> {
        const prior = _history.slice(); // snapshot before appending
        // Priority: per-call options.role > baked-in role > classifier > undefined (all-verbs).
        const effectiveRole = role ?? selectAgentRole(prompt);
        const response = await runner({ role: effectiveRole, ...options, prompt, history: prior });
        _history.push({ role: "user", content: prompt });
        _history.push({ role: "assistant", content: response.text });
        return response;
      },
      reset(): void {
        _history.length = 0;
      },
    };
  };
}
