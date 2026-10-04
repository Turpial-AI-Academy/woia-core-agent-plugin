# S4 host acceptance scenarios

Status: **READY FOR HOST EXECUTION, NOT YET EXECUTED**.

These scenarios are intentionally deferred until a supported ChatGPT/Codex host can exercise real plugin/runtime behavior. Deterministic source fixtures live in `assets/acceptance/s4-core-scenarios.json` and `tests/s4-acceptance.test.mjs`.

## 1. Project bootstrap and persistent root binding

1. Start from a Project with unrelated root `AGENTS.md` instructions.
2. Explicitly select one WOIA department orchestrator.
3. Run Core Project bootstrap once, then resume the same Project in a fresh host session.
4. Verify one managed WOIA block exists, unrelated instructions remain, `.woia/project.json` keeps the same Project identity, and existing provider/custom-agent/runtime state is reconciled rather than reset.

Expected: the Project operating contract and durable logical state survive host restart without duplicating the managed block or making conversational state authoritative. Native runtime bindings are session-local and must be replaced lazily in the new root session.

## 2. Runtime generation boundary

1. Materialize provider/custom-role generation N and load it.
2. Change plugin/config/role inputs so materialized generation becomes N+1.
3. Attempt provider-owned execution before the host reloads N+1.
4. Reload the host and retry.

Expected: execution is blocked while `loaded_generation != materialized_generation`; it becomes eligible only in the fresh loaded generation.

## 3. Overlay preservation and in-flight snapshot pinning

1. Start a Task pinned to base v0.5.0 plus Project overlays.
2. Make a compatible base update candidate available for new work.
3. Verify the existing Task retains its original EffectiveCapabilitySnapshot and snapshot file.
4. Compose a separate snapshot for a new/rebound Task.

Expected: no installed base file or existing snapshot is overwritten; overlays survive and new Tasks may use the reconciled candidate.

## 4. Unknown external effect recovery

1. Create a communication/external-write effect whose outcome becomes `unknown`.
2. Persist the receipt and a blocked checkpoint with `next_action=reconcile`.
3. Resume the Task.
4. Reconcile the prior effect before any retry, persist the reconciliation effect, then resume from the next pending unit.

Expected: no duplicate side effect is attempted while prior effect state is unknown.

## 5. Proportional OPEA-H

Exercise one case for each profile: direct-service, task-execution, planned-execution, audited-execution, and opea-h-full. Verify only justified phases are materialized and Software is not wrapped in redundant OPEA-H.

## 6. Native custom-agent continuity

Use the immutable component graph recorded by the latest Programme production handoff. In S1 execute one AgentInstance three times: observe one binding/thread and three distinct run IDs/receipt IDs. Run an independent Auditor twice: its thread differs from Executor's and is reused for both audits. Repeat with Software Development refinement, then independent Code Review/Testing (Security/Release QA when applicable).

Close S1 and reopen the same Project in S2. Preserve Project/Task/AgentInstance identities and checkpoints, retire S1's active references, and observe a fresh binding/thread on first activation with reuse on the second S2 run. A generation mismatch must still block provider execution on a reused thread.

If safely observable, make the singleton unusable or observe host capacity failure: require a persisted blocker/checkpoint/continuation and a fresh root session, with no sibling creation. If the host cannot safely induce this case, report `NOT_RUN_HOST_LIMITATION` with its concrete reason. Do not infer native behavior from `tests/thread-continuity.test.mjs`; those tests prove the source contract only.
