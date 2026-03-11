# Mock Workspace for CLI Runner

This folder is used as the default workspace when debugging the extension.

Included executable:
- `tools/cli-runner-test.cmd`

Quick test commands in CLI Runner view:
- `build` (success with progress)
- `test` (stderr + non-zero exit)
- `longrun` (use cancel in progress notification)
- `flood` (large output)

Quick test options in CLI Runner view:
- `-k` and `--k` (prefix-preserving option parsing)
- `--pair <key> <value>` (required multi-argument option prompting)
- `--files <file...>` (variadic argument prompting)
- `--tag [name]` (optional argument prompting)
