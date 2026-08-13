/**
 * Running many ops as one step.
 *
 * Building anything real — a room, a lit set, a prop with three children —
 * is a dozen or more calls. One at a time that means a dozen round trips
 * through the bridge, and, worse, a dozen separate entries on the undo stack:
 * the user who wants to reject the whole thing has to press Ctrl+Z twelve
 * times and guess when to stop. That is the "assistant built a Cornell box"
 * case, and it is bad enough to be a correctness problem rather than a
 * convenience one.
 *
 * ## Why this is not a `BatchCommand`
 *
 * The obvious implementation — collect the commands each op would push and wrap
 * them in the existing `BatchCommand` — does not work, because ops are not
 * commands. `entity.create` needs its entity to EXIST before `component.add`
 * can name it, so the steps have to execute in order against a live scene, not
 * be built up and run later. Several ops also do things the undo stack has no
 * opinion about (writing a file, moving the camera).
 *
 * So this executes ops normally and then COLLAPSES the undo entries they
 * produced into a single labelled step, by taking the command bus's undo stack
 * from the mark we set before starting. The visible result is what the user
 * wants — one "Undo Build room" — without pretending the ops are transactional.
 *
 * ## It is not atomic, and says so
 *
 * If step 7 of 12 fails, steps 1–6 have happened. Rolling them back
 * automatically would be a lie in the other direction: some ops have no inverse
 * (a file write), so a partial rollback could leave the project in a state
 * neither the caller nor the user asked for. Instead the result reports exactly
 * which steps ran, the error, and the fact that one undo will take the whole
 * partial batch back out. That is honest and recoverable.
 */
import { defineOp, callOp } from "../registry.js";
import { commandBus } from "../../commands/CommandBus.js";

defineOp({
  name: "batch",
  undoable: true,
  description:
    "Run several ops in order as a SINGLE undo step. Strongly preferred over issuing many calls when building anything multi-part: it is one round trip, and the user can reject the whole result with one Ctrl+Z instead of a dozen. Steps run in order against the live scene, so later steps can use ids returned by earlier ones via the $N reference below. Not atomic: if a step fails, earlier steps have already happened — the response says which, and one undo still removes all of them.",
  params: {
    label: {
      type: "string",
      default: "Batch",
      description: "What this appears as in the Edit menu, e.g. 'Build kitchen'. Write it for the user.",
    },
    steps: {
      type: "array",
      required: true,
      description:
        "[{ op, args }] in execution order. Inside args, the string \"$0\" is replaced by the id from step 0's result, \"$1\" by step 1's, and so on — that is how you attach a component to an entity you just created.",
      items: { type: "object" },
    },
    stopOnError: {
      type: "boolean",
      default: true,
      description:
        "Stop at the first failing step (default) rather than running the rest. With this off, `failures` lists every step that failed and why; `failure` is the first of them.",
    },
  },
  async run({ label = "Batch", steps, stopOnError = true }) {
    const mark = commandBus.markGroup();
    const results = [];
    const ids = [];
    // EVERY failure, not just the last one. With `stopOnError: false` this used
    // to be a single object that each new failure overwrote, so a batch with
    // three bad steps reported one error and two bare `null`s in `results` with
    // nothing to say why — the caller had to re-run the steps one at a time to
    // find out. `failure` stays as the FIRST failure for callers that read it
    // as a scalar (which is also the useful one: later steps often fail only
    // because an earlier one did).
    const failures = [];

    /** Substitutes "$N" references with ids produced by earlier steps. */
    const resolve = (value) => {
      if (typeof value === "string") {
        const match = /^\$(\d+)$/.exec(value);
        if (!match) return value;
        const index = Number(match[1]);
        if (index >= ids.length || ids[index] == null) {
          throw new Error(`"${value}" refers to step ${index}, which produced no id`);
        }
        return ids[index];
      }
      if (Array.isArray(value)) return value.map(resolve);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
      }
      return value;
    };

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] ?? {};
      const name = step.op ?? step.name ?? step.tool;
      if (!name) {
        failures.push({ step: i, error: 'Each step needs an "op" (e.g. "entity.create")' });
        if (stopOnError) break;
        results.push(null);
        ids.push(null);
        continue;
      }
      try {
        // Tool-style names (entity_create) are accepted too, since a caller
        // reading the MCP manifest sees those and would reasonably reuse them.
        const opName = name.includes("_") && !name.includes(".") ? name.replace(/_/g, ".") : name;
        const result = await callOp(opName, resolve(step.args ?? {}));
        results.push(result);
        ids.push(result?.id ?? null);
      } catch (err) {
        failures.push({ step: i, op: name, error: String(err?.message ?? err) });
        results.push(null);
        ids.push(null);
        if (stopOnError) break;
      }
    }

    const collapsed = commandBus.collapseFrom(mark, label);
    return {
      ran: results.length,
      requested: steps.length,
      undoSteps: collapsed,
      failure: failures[0] ?? null,
      failures,
      results,
    };
  },
});
