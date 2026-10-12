# Stop and report persistence

Accepted completion reports are protected in PostgreSQL. A stale client snapshot cannot remove or replace a receipt-backed report. Completion, report editing, and reopening use restricted server transactions with row-version checks. A failed transaction must leave all related rows unchanged.

## Compatibility

- Keep the full-snapshot completion RPC available for the previous server deployment.
- Install `20261012215154_stop_report_memory_bound.sql` before deploying an API that calls `sps_stop_completion_delta_cas`.
- The compact RPC receives one client, validates the exact permitted change under locks, and replaces that client in the stored roster. It preserves the historical JSON encoding depth.
- Generic writes from older apps still pass through the report-protection trigger.
- An older app can block a request locally before contacting the API. Server changes cannot retrieve or retry a report that exists only on that device. Build 43 removes the unrelated conflict gate and retains failed report drafts for retry.
- Do not reinstall an app to resolve a pending report. Its unsent draft may exist only on that device.

## Validation

Run the complete JavaScript suite with `SPS_SQL_TEST_PGLITE_PATH` pointing to a local PGlite installation. The SQL tests exercise the actual migrations, service-only grants, legacy requests, stale writers, exact version increments, retries, reopening, balance changes, and transactional rollback. Native PostgreSQL testing is also required for large existing rosters and concurrent connections. Small fixtures alone do not establish safe memory use.

The live roster measured during investigation contains 269 clients and about 19 MB of serialized data, including a client with about 3.7 MB of history. Stress fixtures must use comparable random photo data rather than highly compressible repeated characters.

## Missing report recovery

`scripts/run-stop-report-backup-recovery.mjs` generates SQL and does not connect to a database. It defaults to a dry run. Apply requires an exact backup key and one exact receipt ID. Install `20261012215738_stop_report_restore_cas.sql` before applying a recovery.

Recovery requires an unambiguous archived report, a matching currently active completion receipt, an existing unique client, and no current report with the same stop or receipt. It restores the original report without replaying completion, inventory, billing, or client delivery. Existing or ambiguous reports are skipped.

Apply one receipt per transaction. Re-read the restored report, row versions, and database health before applying the next. The first repair records an exact baseline; each repair also records its identity and undo metadata. A dry-run result is not proof of recovery.

## Release evidence

Record production migration status, deployment SHA and aliases, exact recovery results, and native upload status separately. An Xcode upload does not prove TestFlight availability or App Store approval. Browser fixtures do not prove a device-only report was uploaded.
