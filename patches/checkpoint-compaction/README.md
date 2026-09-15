# Checkpoint before compaction

Patch for `@deepseek-ai/dsh-compaction-basic@0.1.5-rc.2`, paired with
`dsh-context-guard` and the Local Robust 9B/27B policies.

`checkpointNow(agent, signal, budget)` reserves idle maintenance, summarizes all
balanced durable history with the session's routed model, flushes the summary
record before replacing the surface, then flushes the committed checkpoint.
It reuses one model-generated summary; it does not run a second summarization
request. The original event log stays available.

Before dispatch, the summary envelope (including instructions, tools and routed
image pricing) is priced against the smaller of preset and provider capacity.
The output cap shrinks to leave the configured safety margin. Insufficient room,
empty/truncated/non-text output, cancellation or failed persistence does not
replace the original history. Tool calls in summary output are rejected, never
executed. Arriving messages outside the selected span survive the replacement.

Native automatic compaction defers to the guard's policy service even before the
first agent step, preventing pruning/compaction from racing the closing phase.
Manual compaction keeps its public API and original behavior. The new guard
method fails closed when this runtime patch is absent.

Apply with `node apply-checkpoint-compaction.mjs --target PACKAGE_DIRECTORY`.
Use `--check` for read-only verification. The applicator validates the original
and patched hashes, backs up once, and refuses unknown runtime contents. The
repository restore script applies and verifies this patch.

Run tests with `node --test --test-isolation=none tests/checkpoint.test.mjs`.
Set `DSH_COMPACTION_TEST_TARGET` to an installed package's `lib/index.js` when
the default installation path is unavailable. Tests use real native Session,
TokenMeter and compaction transaction code with a deterministic LLM transport.
