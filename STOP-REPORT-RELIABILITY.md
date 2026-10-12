# Stop and report persistence

Accepted completion reports are protected in PostgreSQL. A stale client snapshot cannot remove or replace a receipt-backed report. Completion, report editing, and reopening use restricted server transactions with row-version checks. A failed transaction must leave all related rows unchanged.

## Compatibility

- Keep the full-snapshot completion RPC available for the previous server deployment.
- Install `20261012215154_stop_report_memory_bound.sql` before deploying an API that calls `sps_stop_completion_delta_cas`.
- Install `20261012222135_stop_report_linear_replace.sql` as well. It replaces repeated UTF-8 prefix scans with one ordered JSON aggregation; clients late in a large roster must be part of performance checks.
- The compact RPC receives one client, validates the exact permitted change under locks, and replaces that client in the stored roster. It preserves the historical JSON encoding depth.
- Generic writes from older apps still pass through the report-protection trigger.
- An older app can block a request locally before contacting the API. Server changes cannot retrieve or retry a report that exists only on that device. Build 43 removes the unrelated conflict gate and retains failed report drafts for retry.
- Build 44 keeps a timeout during the successful response body retryable. Build 45 also retries interrupted or truncated successful response bodies. The original completion key is retained so retrying cannot duplicate the completion.
- Staff stop endpoints return a retryable service-unavailable response for temporary auth-service failures. Invalid tokens still require sign-in; a transient auth outage must not strand a report in manual review.
- Build 46 fences a conflict choice to its captured durable operation instead of waiting for every future unrelated autosave. Repeated identical pending edits keep their original operation identity and do not rewrite the full local queue. A newer real edit or account switch still supersedes the choice.
- Build 46 merges independent receipt-backed report additions around exact unchanged unique legacy visits. Changed, removed, duplicate, or ambiguous legacy visits still require review.
- Do not reinstall an app to resolve a pending report. Its unsent draft may exist only on that device.

## Validation

Run the complete JavaScript suite with `SPS_SQL_TEST_PGLITE_PATH` pointing to a local PGlite installation. The SQL tests exercise the actual migrations, service-only grants, legacy requests, stale writers, exact version increments, retries, reopening, balance changes, and transactional rollback. Native PostgreSQL testing is also required for large existing rosters and concurrent connections. Small fixtures alone do not establish safe memory use.

The live roster measured during investigation contains 269 clients and about 19 MB of serialized data, including a client with about 3.7 MB of history. Stress fixtures must use comparable random photo data rather than highly compressible repeated characters.

The native benchmark defaults to putting the large target client last. Use `scripts/benchmark-stop-report-memory.mjs` only against its explicitly isolated local cluster. Its allocator label is diagnostic metadata, not a hosted-database setting. Notes-only report edit confirmations exclude unchanged photos; full report storage remains intact.

## Missing report recovery

`scripts/run-stop-report-backup-recovery.mjs` generates SQL and does not connect to a database. It defaults to a dry run. Apply requires an exact backup key and one exact receipt ID. Install `20261012215738_stop_report_restore_cas.sql` before applying a recovery.

Recovery requires an unambiguous archived report, a matching currently active completion receipt, an existing unique client, and no current report with the same stop or receipt. It restores the original report without replaying completion, inventory, billing, or client delivery. Existing or ambiguous reports are skipped.

Apply one receipt per transaction. Re-read the restored report, row versions, and database health before applying the next. The first repair records an exact baseline; each repair also records its identity and undo metadata. A dry-run result is not proof of recovery.

## Release evidence

Record production migration status, deployment SHA and aliases, exact recovery results, and native upload status separately. An Xcode upload does not prove TestFlight availability or App Store approval. Browser fixtures do not prove a device-only report was uploaded.

## Clients review verification and remaining storage limits

The build 46 browser fixture uses the actual review component, review handler, store, and IndexedDB with synthetic clients. With continuing unrelated writes, build 45 remains on Saving without starting a client CAS. Build 46 completes both choices, retains independent fields from both devices, and removes the review. This proves the reproduced queue defect, not the contents of a physical device's private pending queue.

Large-roster SQL checks must include the JSON request-body parsing used by PostgREST, not only direct function calls. A 269-client, 173-report, 19.3 MB synthetic roster with clustered photo histories peaked near 440 MiB for one generic writer and 647 MiB across two concurrent writers in the local test. Both reports and concurrency fences remained correct. The live database restarted at 2026-10-12 22:47:30 UTC; no available log establishes its cause. These measurements identify memory-pressure risk but do not prove an out-of-memory restart. The generic snapshot path still carries the full roster; compact stop endpoints do not eliminate that older-client cost.

Rachael Switalski's stop 1791379462959-0 was confirmed present at 22:48 UTC with one accepted receipt, one report, one photo, and notes. The current Clients review is not evidence that this report is still device-only.
