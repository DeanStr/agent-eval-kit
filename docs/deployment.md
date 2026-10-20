# Deployment and isolation

AEK runs evaluation scenarios, configured project commands, and provider CLIs.
Choose an execution environment according to who controls those inputs. AEK's
evidence contracts determine which results can be accepted; the surrounding
runtime must control which effects are possible.

## Trusted local projects

Run projects and evaluation configurations you trust under your normal development
account. Review setup, start, collector, and grader commands before running someone
else's configuration: these are executable project code. For an initial trial,
use the [packaged offline walkthrough](first-run.md), which needs no provider
credentials or browser installation.

Provider working directories, filtered environments, read-only workspace MCP
tools, and browser origin checks reduce unintended access. They do not isolate
every process or prevent project code from accessing resources available to the
account running AEK. Browser state isolation also does not reset a target database;
use dedicated test accounts and resettable test data.

Workspace MCP listing, search, and direct reads exclude `.env`, `.env.*`, `.envrc`,
`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.netrc`, `.pypirc`, `.git-credentials`, and the
`.ssh` and `.aws` directories at any project depth. This also applies to symbolic
link targets and files created after startup. Use a separate fixture containing
only non-secret sample data when a scenario needs to inspect configuration
examples. These filename checks supplement containment; keep other private files
outside the evaluation checkout.

## CI and untrusted submissions

Run each untrusted evaluation in a disposable environment whose restrictions are
enforced outside the submitted project and AEK configuration. This includes the
target's installation, setup, server, collectors, graders, provider tools, and MCP
servers. Placing only the target server in a container leaves other execution
paths on the host.

- Use a dedicated sandbox or VM for arbitrary submissions. If using containers,
  configure their isolation explicitly: avoid privileged execution, host runtime
  sockets, host networking, and broad host or home-directory mounts.
- Keep source and fixture mounts read-only where possible. Give each job separate
  writable scratch and artifact storage, and avoid sharing those directories
  between submissions.
- Supply only test credentials needed for that job. Keep production secrets,
  personal home directories, and unrelated CI tokens outside the environment.
  Provider credentials available inside it remain part of its exposure; AEK's
  environment filtering does not make mounted credential files inaccessible.
- Enforce network access outside the evaluated application. Allow only required
  provider and test-service destinations, and restrict access to internal services
  and cloud metadata endpoints. Browser origin checks do not constrain arbitrary
  shell commands or all application network traffic.
- Apply CPU, memory, process-count, disk, and wall-clock limits. Destroy the
  environment after collecting the required artifacts, including on failed or
  cancelled jobs. AEK process-group cleanup is not containment for processes that
  escape that group.

Keep CI acceptance rules and final evaluation definitions under trusted control.
An untrusted submission must not be able to weaken its own checker and obtain an
accepted result. Retained fingerprints and compatible comparisons help identify
changes; CI decides which definitions and baselines are authorized.

Raw logs and evidence may contain private application data. Restrict artifact
access and retention; use [public export](../README.md#public-export-and-privacy-lint)
when deliberately sharing results.

## Tool-policy monitoring

The Codex adapter records provider-native command, file-change, and web-search
events when workspace tools are disallowed. Those violations invalidate the
evaluation, but detection can happen after the action. Rejecting the result does
not reverse filesystem writes, network requests, or other effects.

The adapter's non-MCP path explicitly requests `--sandbox read-only`. Its MCP
path uses `--approve-for-me` to support non-interactive tool approvals. These
provider execution modes are distinct from AEK's event monitoring and from the
external isolation required for untrusted workloads. Do not treat a clean event
log or a rejected run as proof that no forbidden effects occurred.

## Subprocess output and resource limits

AEK pauses stdout and stderr independently while their log writers are backpressured.
Normal completion waits for both log streams to finish. Each returned capture
retains at most 12 × 1024 × 1024 UTF-16 code units from the end of its stream;
this is a string-length limit, not a total process-memory limit.

When a line callback consumes provider events, each line is limited to 12 MiB of
UTF-8 data, including any trailing carriage return but excluding the newline.
Oversized lines, callback errors, and log-write failures terminate the subprocess
and reject the invocation as an execution error. An oversized structured event is
never silently truncated into a valid result. Without a callback, AEK keeps no
line-framing buffer and accepts newline-free output beyond the capture limit.

Raw log files are not capped. Provision disk quotas and job limits for long-running
or untrusted workloads; bounded capture and backpressure do not impose a disk
budget. Logs from interrupted or failed invocations contain only the output
retained before termination.
