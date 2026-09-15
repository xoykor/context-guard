# dsh-context-guard

Deterministic context-budget and loop guard for DeepSeek Harness (DSH), maintained by **xoykor**. Unofficial and not affiliated with or endorsed by DeepSeek.

Context Guard is designed for long-running local-model agent sessions. It monitors context pressure and execution behavior at the harness level rather than relying only on instructions to the model.

## Features

- Context-pressure thresholds for economy, checkpoint and compaction stages.
- Repeated-action and no-progress detection.
- Equivalent-failure detection.
- Per-turn limits for steps, tool calls, elapsed time and optionally tokens.
- Reduced diagnostic budget after command timeouts.
- Preset-specific policies for models with different context windows.
- Checkpoint reserve validation.
- Managed-job observation support when the host exposes the required capability.
- Deterministic enforcement through DSH/Cordis services rather than model prompting.

Default execution ceilings are 48 steps, 48 tool calls and 900000 ms. Explicit `null` can disable supported ceilings while retaining loop/failure safeguards.

## Installation

```sh
git clone https://github.com/xoykor/dsh-context-guard.git
cd dsh-context-guard
dsh plugin --profile web add "$(pwd)"
```

Inspect `cordis.patch.yml` and your effective profile configuration before restarting DSH.

## Configuration

For sustained productive work, supported execution ceilings can be disabled explicitly:

```yaml
config:
  maxTurnSteps: null
  maxTurnToolCalls: null
  maxTurnMs: null
```

Unlimited execution can consume substantial time and model/provider resources. Loop detection, failure detection, cancellation and permission controls remain important.

Context thresholds should be configured for the model's actual usable context window. The plugin supports preset-specific policies so different models can use different thresholds and reserve budgets.

## Compatibility

The base plugin injects DSH's `tools`, `tokenMeter` and `compaction` services.

Some advanced paths in the implementation depend on host/runtime capabilities that are not part of every upstream DSH release, including the custom checkpoint and managed-job observation interfaces used by the original local setup. Those runtime patches are not bundled in this repository. Unsupported advanced configurations are intended to fail closed rather than silently bypass safeguards.

When upgrading DSH, verify the plugin copy actually installed in the target profile; changing the source checkout alone may leave an older installed copy in the profile's `node_modules`.

## Tests

With a recent Node.js version:

```sh
node --test tests/*.test.mjs
```

The included tests exercise execution budgets, loop detection, job observation, preset isolation, checkpoint behavior, cancellation and repeated compaction cycles. They use simulated DSH services and do not constitute a real-model endurance certification.

## Provenance

Extracted from xoykor's DSH configuration/backup and published as a standalone plugin. Maintained with AI-assisted development and review.
