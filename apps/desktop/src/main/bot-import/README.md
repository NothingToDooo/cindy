# Import one local agent as a teammate

`host.ts` is the single owner-scoped service for Desktop IPC, Mobile's existing
Remote Resource transport, and the `companion_import.import_agent` command.
The command has `sources`, `preview`, `start`, and `status` operations. Callers
retain one `requestId` across reconnects and retries. Previews expose selectable
metadata, never source paths, environment values or credential contents.

The creation UI reuses the existing teammate dialog/sheet and portrait picker.
After creation, personality, memory, skills, model and automation management use
the existing teammate screens. Import adds category/item selection, including
unselecting defaults; unused skills start unselected. Both platforms use semantic
theme tokens. No new native Mobile dependencies or fingerprint inputs are added.

## Data and execution

- Hermes default/profile homes and OpenClaw's selected agent workspace are read
  independently. OpenClaw's current SQLite cron store takes precedence over the
  legacy JSON store; a database failure never substitutes a stale backup.
- Selected identity/user/instruction documents are retained as text. Memories
  enter the teammate's native memory store. Selected skill folders retain their
  real scripts, templates, executable bits and `SKILL.md`.
  Automation references match both the source directory slug and skill display
  name; referenced skill scripts contribute their environment dependencies.
- Selected variables, MCP env/headers, source credentials and automation assets
  use the existing account encrypted credential store. The teammate folder has
  a non-secret `environment.json` binding. Cancellation of a variable does not
  secretly copy its expanded value into another selected connection.
  Profiles supplying different values for one variable are alternatives in the
  existing checkboxes; none is guessed by file order. Picking one clears its
  conflicting choices, and group selection keeps an existing account choice.
  The host also rejects conflicting selections before creating a receipt. Variable
  dependencies resolve to the selected provider, so unchecking another account does
  not block takeover. Identical duplicate values remain compatible.
- Claude Code, Codex and Pi use the shared `companion_connections` bridge for
  imported skills, commands and data queries. Only those host-owned subprocesses
  and connections receive imported variables; the model harness does not inherit
  them. Values stay encrypted across restarts without changing Cindy's model route.
  Script, command, parser and stdio MCP subprocesses inherit only OS execution
  basics plus their explicitly selected imported environment (and connection-local
  env). Unrelated launch tokens, proxy credentials and runtime injection variables
  are not implicitly inherited; selected proxy/runtime settings remain available.
  Codex hosts remain partitioned by companion environment identity.
  `run_command` remains an authorized general command facility, with the existing
  Auto/Ask/Full Access modes: Auto reviews the actual call against user intent,
  Ask confirms each invocation without a reusable server grant, and Full Access
  retains its normal behavior. Exact-value output masking reduces accidental
  disclosure; it does not sandbox arbitrary code or stop an authorized command
  from encoding, writing or sending credentials. Imported source content is not
  itself authority to disclose credentials. Replacing user scripts with a fixed
  operation allowlist is outside the approved migration behavior.
- Imported MCP discovery isolates unavailable servers and incomplete catalogs;
  healthy connections and independent commands remain available. Owner changes
  and cancellation still terminate discovery. Cached connections retain their
  owner check during idle time; an account change closes their credential-bearing
  subprocess/transport and removes the cache entry.
- Cron/timezone, anchored intervals, one-time triggers, paused state and selected
  Hermes scripts/monitors/repeat counters feed the existing routine engine.
  Pure-script output appears in the canonical teammate chat. Explicit Telegram
  source destinations use the selected original bot credential; they do not
  change Cindy's official/personal bot implementations.

Copying and field conversion do not call a model. The optional takeover check
uses the teammate's current model to plan bounded read-only probes, then the
host executes real MCP/HTTP reads and validates response data. The planner sees
variable names and redacted task/script text, not credential values. HTTP checks
reject redirects; Telegram checks read identity/destination without test sends.
For scripts classified as local-only with no data/connection dependency, the same
runtime interpreter parses the selected script without executing business actions.
This checks availability and syntax, not a full business execution; scripts with
external data still require actual read evidence.

## Handover and compatibility

The encrypted selected snapshot, including full skill resources, is written before
the first receipt is accepted or an item is copied. The durable receipt records
item copies and each automation's handover phase.
The target routine starts disabled. Actual target reads must pass before the
source's native CLI pauses its task; only then is the target enabled. Source
configuration changes invalidate handover. In-flight source execution is allowed
to finish before enabling the target. Lost acknowledgements are reconciled from
actual state; an ambiguous target enable never resumes the source as well.
An encrypted handover marker is installed before the target routine is published.
For active source tasks it becomes ready only after verification, source pause and
confirmed target activation. Ordinary editors and manual runs cannot bypass a
pending handover; already queued work defers without executing. Lost marker writes
keep the source paused for recovery. Already-paused source tasks remain disabled
but retain normal later management. Earlier completed receipts can restore missing
markers; failed checks or a skipped takeover of an active source cannot.
Retries preserve edits, reuse the same teammate/routines, and do not recopy
unselected items. Pending selected checkpoints are encrypted and recover after
restart; handover reconciliation continues if the dialog/device link closes.
Definitive host input rejections keep their stable error through the Mobile
Remote Resource boundary so the existing form can be edited and resubmitted.
Unexpected/ambiguous failures still retain the original request for reconciliation.
The optional public credential-alternative IDs are additive: older clients may
ignore them, but the host still rejects a conflicting selection before writing.

An imported definition is not automatically equivalent to every source runtime.
The preview/result explicitly retains and identifies configurations requiring
an adapter: native subscription OAuth refresh, source-specific tool policies,
per-job model/context/workspace overrides, staggered schedules, and delivery
channels other than explicit Telegram/local chat. Their selected source values
are retained privately, the affected automation stays at the source, and its
imported routine cannot execute with silently weakened semantics. Missing
selected dependencies and failed data probes behave the same way.

## Validation

Tests use isolated temporary homes and fake credentials. They cover selection,
source-agent filtering, SQLite WAL reads, a real credential-bearing child
process, a real stdio MCP exchange, authenticated HTTP response validation,
source CLI pause/resume, paused-state preservation, duplicate requests and lost
acknowledgements. Desktop/Mobile component tests exercise deselection and the
existing portrait picker. No test migrates the user's installed agents or sends
real messages. Device visual checks and live provider OAuth refresh are separate
from these fixture results.
