# Codex Conversation Dashboard Design

## Goal

Convert the existing Claude-focused dashboard into a Codex-only dashboard that ingests local Codex CLI logs and makes conversation search the primary workflow.

The product should let a user:

- search across Codex conversations quickly at message granularity
- inspect surrounding context immediately
- expand from a search hit into the full session narrative
- retain supporting views for timeline, usage/cost, and admin operations

## Scope

Included in this design:

- local log ingestion from Codex log directories and project session files
- normalized storage model for conversations, tools, agents, timeline events, and usage
- message-first full-text search with session expansion
- search-first information architecture
- preservation of timeline, cost, and admin capabilities as secondary views

Explicitly out of scope for this phase:

- Claude/Codex dual-source compatibility
- preserving Claude-specific schema semantics where they distort the Codex model
- redesigning the product into a generic multi-provider analytics platform

## Product Positioning

This is no longer a Claude usage dashboard with renamed labels. It becomes a Codex conversation dashboard. The top-level story shifts from "overview metrics first" to "find the exact conversation fragment, then recover its context."

Success means three behaviors feel connected:

- users can find the right message in seconds
- users can reconstruct the flow of a Codex work session
- users can compare work and usage across projects without leaving the same product

## Architecture

The system is organized into four layers.

### 1. Ingestion Layer

Watch two local input classes:

- global Codex log files under `~/.codex/...`
- project-level session files created by Codex

The existing watcher pattern remains useful, but file discovery and parsing move from Claude JSONL assumptions to Codex event streams. The ingestion layer is responsible for:

- finding relevant files
- tracking offsets/checkpoints
- detecting new or updated events
- feeding raw events to the normalization pipeline

### 2. Normalization Layer

Raw Codex events are transformed into a stable internal model instead of being exposed directly to the UI. This decouples product behavior from future Codex log format changes.

Normalization emits these internal entities:

- `project`
- `session`
- `message`
- `message_context`
- `tool_event`
- `agent_run`
- `timeline_event`
- `usage_rollup`

### 3. Search and Aggregation Layer

Search is centered on normalized messages. Message bodies are indexed with FTS, while filterable metadata remains in ordinary relational columns.

This layer provides:

- full-text message search
- faceted filtering by project/date/role/agent/tool/session
- context lookups for neighboring messages
- derived timeline and usage aggregations
- admin-facing ingestion and index health summaries

### 4. Presentation Layer

The UI is restructured around search as the default entry point. Search becomes the landing page. Timeline, cost, and admin remain available, but they are no longer the first story the product tells.

## Data Model

### Core Principle

The primary retrieval unit is `message`, not `session`. Sessions remain important as the container for reconstruction, but search results should land directly on the relevant message.

### Entities

#### `projects`

Represents a Codex project root or canonical project identifier. Stores:

- project id
- display name
- normalized path
- first seen / last seen timestamps

#### `sessions`

Represents a Codex work session. Stores:

- session id
- project id
- title or title candidate
- started at / ended at / last activity at
- summary fields for listing and sorting

#### `messages`

Search anchor table. Stores:

- message id
- session id
- project id
- role such as `user`, `assistant`, `system`, `tool`, `agent`
- plain text searchable body
- sequence index within session
- created timestamp

#### `message_context`

Captures the execution context around a message. Stores:

- message id
- agent id if present
- tool name
- tool call id
- parent message id
- thread depth
- context flags needed by the UI

#### `tool_events`

Stores tool invocation and result records in structured form so the UI can show tool context around search hits and reconstruct execution order.

#### `agent_runs`

Stores agent lifecycle information:

- agent id
- parent agent or parent session link
- start/end timestamps
- model if available
- status/outcome

#### `timeline_events`

Stores normalized temporal events for timeline rendering. Messages, tool calls, tool results, and agent lifecycle transitions all map into this shared event model.

#### `usage_rollups`

Stores or caches aggregated usage metrics such as token counts, cost, and request volume for overview widgets and time-bucketed analytics.

## Search Experience

### Retrieval Model

Default search returns message-level matches. Each result includes:

- highlighted text hit
- session title or best title candidate
- project name
- timestamp
- agent/tool badges
- quick link into the full session

### Context Rules

Every result must surface enough context to avoid a blind click. The detail panel should show:

- surrounding messages
- related agent or tool execution context
- exact session and project metadata
- mini timeline position for the selected hit

### Session Expansion

From any result, the user can expand into a session narrative view that reconstructs the full flow of messages, tool activity, and agent transitions in chronological order.

## Information Architecture

### Search Landing Page

The landing page is a two-column search-first layout.

Left column:

- global search bar
- result list
- filters for project/date/role/agent/tool

Right column:

- context inspector
- neighboring messages
- session metadata
- agent/tool context
- mini timeline

This is effectively "Layout A with selected context-panel ideas from Layout C."

### Session View

The session view is a reconstruction screen, not just a raw transcript. It should present:

- time-ordered message flow
- tool call/result boundaries
- agent parent-child transitions
- clear jumps back to search results

### Secondary Views

Retained but demoted from the landing experience:

- `Timeline`: project/session exploration over time
- `Usage/Cost`: token and cost analytics
- `Admin`: ingestion status, index health, retention, backup, and operational controls

## Data Flow

1. File watcher discovers or updates Codex log sources.
2. Parser reads raw Codex events.
3. Normalizer maps raw events into internal entities.
4. Database persists normalized rows and updates FTS indexes.
5. Search queries return message hits plus metadata joins.
6. Context queries fetch surrounding messages and related tool/agent state.
7. Timeline and usage views read from normalized/aggregated tables rather than raw logs.

## Migration Strategy

The application should be treated as a Codex-only product after the migration. Existing Claude-specific assumptions should be removed rather than wrapped in compatibility layers unless a specific piece of infrastructure is still useful without semantic distortion.

Recommended migration shape:

1. keep the app shell, auth model, watcher infrastructure, and general operational scaffolding
2. replace Claude-specific parsing and normalization with Codex-aware ingestion
3. introduce a Codex-native schema where current schema assumptions are too Claude-specific
4. rework the frontend so search is the default route and primary interaction
5. reconnect timeline, usage, and admin screens to the new normalized model

## Error Handling

The system should degrade cleanly when Codex logs are incomplete or malformed.

Requirements:

- ingestion failures must be recorded without crashing the app
- malformed raw events should be quarantined or skipped with diagnostics
- partial session reconstruction should still produce usable message search results
- UI detail panels must handle missing tool/agent context without blank-screen failures
- admin screens should expose ingestion health, parse error counts, and index lag

## Testing Strategy

Testing needs to prove both correctness and recoverability.

### Parser and Normalization

- fixture-based tests for representative Codex raw event samples
- edge-case coverage for missing fields, reordered events, partial sessions, and unknown event types

### Storage and Search

- integration tests for FTS indexing at message granularity
- context lookup tests for neighboring messages and agent/tool joins
- migration tests for schema bootstrap and incremental updates

### UI Behavior

- search landing page tests for message-first results
- session expansion tests
- timeline and usage smoke tests against normalized Codex fixtures

### Operational Behavior

- watcher resume/checkpoint tests
- ingestion error visibility tests in admin views
- backup/retention regression coverage if schema changes affect those flows

## Open Design Decisions Deferred to Planning

The following items should be pinned in the implementation plan, not left ambiguous during coding:

- exact Codex raw file discovery patterns under `~/.codex/...`
- precise event taxonomy from real sample logs
- title derivation rules for sessions
- token/cost derivation logic from Codex records
- whether migration reuses or replaces the current schema version chain
- route-by-route frontend cutover sequence

## Implementation Guidance

The implementation plan should be split into bounded workstreams:

- raw log discovery and sample capture
- parser and normalization model
- database schema and indexing
- search-first frontend restructuring
- timeline/usage/admin reconnection
- test and migration hardening

That decomposition keeps search delivery on the critical path while preventing timeline/admin work from blocking parser and schema progress.
