# Codex Chain Conservative Recursion Design

## Goal

`/api/sessions/{session_id}/chain` must stop depending on legacy `sessions/messages` tables while preserving the existing response shape and avoiding invented parent-child links.

This route is one of the last blockers for removing the Claude-era runtime schema.

## Decision

Adopt a Codex-only, conservative recursive chain model.

- The root node is the requested Codex session.
- First-level children are `codex_messages` rows in that session where `role='agent'`.
- Deeper levels are included only when a parent-child relationship is explicitly provable from Codex-native data already stored in the database.
- If a deeper relationship cannot be proved, recursion stops at that branch.
- The route must not read legacy `sessions/messages` to recover or infer missing structure.
- The route must not fabricate children from description matching, text similarity, or timing-only guesses.

## Non-Goals

- Reconstructing the full historical Claude-era dispatch tree.
- Matching legacy chain depth by heuristic inference.
- Expanding schema in this slice unless a minimal Codex-native link field is already present and unused.

## Response Contract

The route keeps the current shape:

- `root`
- `nodes`
- `count`

Each node continues to expose the fields already expected by the frontend chain view.

## Node Semantics

### Root node

The root node comes from `codex_sessions`.

Required properties:

- `id`
- `agent_type`
- `agent_description`
- `cost_usd`
- `message_count`
- `parent_session_id`
- `project_path`
- `is_subagent`
- `level`

For the root:

- `id` is the session id
- `agent_type` is empty
- `agent_description` is `session_name` or session id
- `is_subagent` is `0`
- `level` is `0`

### Agent-run child nodes

Child nodes come from `codex_messages` rows where `role='agent'`.

Required properties:

- `id`
- `agent_type`
- `agent_description`
- `cost_usd`
- `message_count`
- `parent_session_id`
- `project_path`
- `is_subagent`
- `level`

For Codex child nodes:

- `id` uses the existing `agent-run-{message_id}` form
- `agent_type` comes from parsed payload `agent_name`, defaulting to `agent`
- `agent_description` comes from `content_preview`
- `parent_session_id` is the owning session id
- `is_subagent` is `1`
- `level` is assigned during traversal

## Traversal Rules

### Level 0 to Level 1

Load all `role='agent'` messages for the requested session, ordered by timestamp then id.

These become the direct children of the root node.

### Level 1+

Only descend when a child can be tied to another stored Codex session or agent-run through an explicit Codex-native link already available in runtime data.

Allowed evidence:

- an existing stored identifier field that directly names the child session or message
- an explicit parent pointer already persisted in Codex storage

Disallowed evidence:

- matching `agent_description`
- matching free-text payload content
- nearest-in-time assumptions
- project-level grouping alone
- model name or role similarity

If no explicit link exists for a node, recursion ends there.

## Ordering

- Root first
- Then depth-first traversal
- Siblings ordered by timestamp ASC, then message id ASC

This keeps the output deterministic and stable for tests.

## Error Handling

- If the root Codex session does not exist, return an empty chain payload with the existing not-found semantics used by the route today.
- If the root exists but has no provable descendants, return the root-only payload.
- Malformed `agent` payload JSON must not fail the route; missing fields degrade to defaults.

## Testing

Add or update tests to prove:

1. Legacy rows are not required for `/api/sessions/{id}/chain`.
2. The route returns the root plus direct Codex agent-run children.
3. Traversal does not invent deeper children when explicit links are missing.
4. Ordering is deterministic.
5. Response shape remains unchanged.

## Implementation Slice

This design only covers the route-level redefinition of `chain`.

After this slice lands, the next cleanup slice can remove more legacy schema creation logic from startup because `chain` will no longer require Claude-era runtime tables.
