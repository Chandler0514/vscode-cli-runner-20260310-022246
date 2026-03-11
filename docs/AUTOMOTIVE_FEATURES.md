# Automotive Feature Board

This document records the automotive-focused capability set for CLI Runner.

## Positioning

Target user: embedded automotive software engineers who need one workspace for build, flash, diagnostics, and traceability.

## Implemented Workflow Features

All features below are implemented under:

- `Tool Wrappers -> Embedded -> Automotive Workflows`

### 1) Environment Doctor

- Workflow ID: `automotive.environmentDoctor`
- Purpose: check required env vars, executable availability, and required files before build/flash.
- Key settings:
  - `cliRunner.environmentRequiredEnvVars`
  - `cliRunner.environmentRequiredExecutables`
  - `cliRunner.environmentRequiredFiles`

### 2) Quality Gate Dashboard

- Workflow ID: `automotive.qualityDashboard`
- Purpose: aggregate recent audit records, pass-rate trend, failure hotspots, and gate thresholds.
- Key settings:
  - `cliRunner.qualityGateMaxErrors`
  - `cliRunner.qualityGateMaxWarnings`
  - `cliRunner.auditLogFile`

### 3) Size Regression Compare

- Workflow ID: `automotive.sizeRegression`
- Purpose: compare current map with baseline and validate configured size budgets.
- Key settings:
  - `cliRunner.sizeBaselineMapPath`
  - `cliRunner.sizeBudgetTotalBytes`
  - `cliRunner.sizeBudgetTextBytes`
  - `cliRunner.sizeBudgetDataBytes`
  - `cliRunner.sizeBudgetBssBytes`

### 4) Flash + Smoke Workflow

- Workflow ID: `automotive.flashAndSmoke`
- Purpose: flash image and run smoke tests in one orchestrated flow.
- Key settings:
  - `cliRunner.flashToolKey`
  - `cliRunner.flashArgsTemplate`
  - `cliRunner.smokeToolKey`
  - `cliRunner.smokeArgsTemplate`

### 5) UDS Diagnostics

- Workflow ID: `automotive.udsDiagnostics`
- Purpose: run common diagnostic operations (`Read DTC`, `Clear DTC`, `Read DID`) over REST or CLI.
- Key settings:
  - `cliRunner.udsTransport`
  - `cliRunner.udsRestBaseUrl`
  - `cliRunner.udsRestToken`
  - `cliRunner.udsExecutableKey`
  - `cliRunner.udsDefaultEcuAddress`

### 6) DBC Signal Lookup

- Workflow ID: `automotive.dbcLookup`
- Purpose: scan DBC files and return matched signal/message metadata.
- Key settings:
  - `cliRunner.dbcSearchRoots`

### 7) Pipeline Template Apply

- Workflow ID: `automotive.applyPipelineTemplate`
- Purpose: quickly apply built-in pipeline templates into `cliRunner.pipelineSteps`.
- Built-in templates:
  - `CMake + Static + UnitTest`
  - `IAR + Static`
  - `GHS + QEMU Smoke`

### 8) HIL/SIL Orchestrator

- Workflow ID: `automotive.runHilSil`
- Purpose: run mixed CLI/REST HIL-SIL jobs with stop/continue-on-error policy.
- Key settings:
  - `cliRunner.hilSilJobs`

### 9) Traceability Report

- Workflow ID: `automotive.traceabilityReport`
- Purpose: correlate requirements in commit messages with recent test/workflow records and generate Markdown report.
- Key settings:
  - `cliRunner.requirementIdPattern`
  - `cliRunner.traceabilityLookbackCommits`
  - `cliRunner.postmortemReportDir`

### 10) Postmortem Report

- Workflow ID: `automotive.postmortemReport`
- Purpose: collect failure timeline, git status, configured log snippets, and generate incident report.
- Key settings:
  - `cliRunner.postmortemReportDir`
  - `cliRunner.postmortemLogFiles`
  - `cliRunner.postmortemMaxLogLines`

## Notes

- All workflow runs append audit records to `cliRunner.auditLogFile`.
- Generated markdown reports are stored under `cliRunner.postmortemReportDir`.
