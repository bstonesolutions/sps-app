# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Standing rules (permanent)

These rules always apply and must not be relaxed or forgotten, regardless of the task:

1. **Never modify `supabaseClient.js` or anything in the storage/database layer** unless I explicitly ask. This includes Supabase client setup, queries, schema, and any data-persistence code.

2. **Never use real business data as a fallback default.** When a value is missing or empty, default to an empty array (`[]`) — never seed defaults with real client, invoice, or business data.

3. **Always show me the change before committing or pushing.** Present the diff/edits for review and wait for my go-ahead; do not commit or push on your own.

4. **After editing `App.jsx`, always run `npm run build`** to confirm it compiles successfully before committing.
