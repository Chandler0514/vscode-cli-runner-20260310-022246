# Automotive Embedded Enhancements TODO

Target users: embedded automotive C developers.

## Foundation

- [x] Add automotive-oriented configuration schema and typed parsing.
- [x] Add scenario context injection (`project`, `ecu`, `board`, `toolchain`, etc.).
- [x] Add execution audit log (JSONL) for command/REST/workflow traceability.
- [x] Add compiler log diagnostic parsing and publish to VS Code Problems.
- [x] Add quality gate evaluation (error/warning thresholds).

## CLI / Tool Wrappers

- [x] Add toolchain preset wrappers (CMake/Ninja/Make/IAR/GHS/Tasking-friendly actions).
- [x] Add preflight checks (required env vars) before high-value actions.
- [x] Add static analysis wrappers (`clang-tidy`, `cppcheck`, `pclint`).
- [x] Add flash/debug wrappers (`openocd`, `JLinkExe` style actions).
- [x] Add binary size analysis action (`.map` parser with text/data/bss summary).

## Workflow Automation

- [x] Add scenario selector command and workflow action.
- [x] Add one-click pipeline workflow (format/check -> build -> analysis -> flash -> smoke).
- [x] Add variant matrix execution workflow and consolidated summary.
- [x] Add environment doctor workflow (env/tool/file readiness).
- [x] Add quality dashboard workflow (audit trend + hotspots).
- [x] Add size regression workflow (baseline compare + budget check).
- [x] Add flash + smoke chained workflow.
- [x] Add UDS diagnostics workflow (REST/CLI, DTC + DID operations).
- [x] Add DBC signal lookup workflow.
- [x] Add pipeline template apply workflow.
- [x] Add HIL/SIL orchestration workflow (mixed CLI/REST jobs).
- [x] Add traceability report and postmortem report workflows.

## REST Services

- [x] Add CI/build/test/HIL/SIL REST actions.
- [x] Add traceability REST actions (requirement -> commits/tests/build links).

## Docs

- [x] Extend maintenance docs with automotive module guidance and config examples.
- [x] Update README with automotive quick-start settings example.
- [x] Add dedicated automotive feature board (`docs/AUTOMOTIVE_FEATURES.md`).
- [x] Update quickstart guide to include v0.1.0 automotive workflow pack onboarding.
