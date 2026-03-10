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

## REST Services

- [x] Add CI/build/test/HIL/SIL REST actions.
- [x] Add traceability REST actions (requirement -> commits/tests/build links).

## Docs

- [x] Extend maintenance docs with automotive module guidance and config examples.
- [x] Update README with automotive quick-start settings example.
