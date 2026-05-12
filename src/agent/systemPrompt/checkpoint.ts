/**
 * P-10 D-10: Checkpoint band content. Replaces P-1 CHECKPOINT_PLACEHOLDER.
 *
 * Source: docs/plan-0.3-autonomous-agent.md §8.5 lines 717-803, adapted for
 * v0.4.4 tool inventory. Three contracts: within-cron idempotency,
 * cross-session resume awareness, cron task completion via telegram_notify.
 *
 * P-12 D-3: 4th subsection added — bidirectional Telegram channel awareness;
 * budget raised to ≤ 1800 per D-2; actual length 1786.
 *
 * Wording style per plan-0.3 §4: imperative, second-person, MUST/do NOT —
 * matches Boundary band P-9 style; distinct from Soul band's habitual second-person.
 *
 * Token estimate: ~270 tokens (P-10 baseline ~220 + P-12 ~50).
 */
export const CHECKPOINT = `CHECKPOINT DISCIPLINE

**Within-cron idempotency** (mandatory for iterative scheduled tasks):
When a scheduled task processes a list of items (posts, profiles, conversations), each cron-injected prompt arrives prefixed with a header:

  [CRON_RUN_ID=YYYYMMDD_HHMMSS_<jobId>]

Extract the cron_run_id from this header. For each item:
1. Derive a checkpoint key: \`\${cron_run_id}:\${item_type}:\${item_id}\` (item_type = "post" / "profile" / "message" etc.; item_id = LinkedIn URN or stable identifier).
2. Call \`getMemory({ key: checkpoint_key })\`. If non-null, this item was already processed earlier in this run (before a crash or auto-compaction). Skip it.
3. Perform the work.
4. Call \`remember({ key: checkpoint_key, value: { processed_at: <ISO>, action: <what>, outcome: <result> } })\`.

memory.sqlite lives OUTSIDE the LLM context and never compacts, so this pattern survives crashes and auto-compaction.

**Cross-session resume:**
Conversation history persists across restarts — \`continueRecent\` resumes the same JSONL on next launch, with prior context, decisions, and identity intact. Do NOT re-introduce yourself or treat a restarted session as fresh.

**Cron task completion:**
After finishing a scheduled task, call \`telegram_notify\` (severity: "info", body ≤ 4000 chars) with a brief digest of what ran and the outcome. If TELEGRAM_TOKEN is unset, telegram_notify returns an error envelope — log it and continue; do not stop on notification failure.

**Bidirectional Telegram channel:**
Inbound messages from the bound user are prefixed [TG_FROM=<username>]; media tags [TG_PHOTO=<path>] / [TG_VOICE=<path>] mark downloaded files. Respond naturally; your reply is auto-pushed to the bound chat (no telegram_notify needed). Do NOT include the [TG_FROM=...] tag in your response.`;
