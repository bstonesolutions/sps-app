#!/usr/bin/env node
// Generates a single atomic SQL transaction; does not connect to any database.
// Usage: node scripts/run-stop-report-backup-recovery.mjs --backup EXACT_BACKUP_KEY [--apply]
// Default is dry run. Output uses anonymous DO, with no function/table DDL.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const literal = value => `'${String(value).replaceAll("'", "''")}'`;
export async function buildStopReportRecoverySQL({ sourceBackupKey, apply = false }) {
  if (typeof sourceBackupKey !== 'string' || !sourceBackupKey.trim() || sourceBackupKey.includes('\0')) throw new Error('An exact backup key is required');
  if (typeof apply !== 'boolean') throw new Error('Apply must be an explicit boolean');
  const source = await readFile(new URL('./recover-stop-reports-from-backup.sql', import.meta.url), 'utf8');
  const match = source.match(/as \$recovery\$([\s\S]+?)\$recovery\$;/);
  if (!match) throw new Error('Recovery body could not be located');
  let body = match[1].replace(/\bdeclare\b/, `declare
  p_source_backup_key text := current_setting('sps.recovery_backup_key');
  p_apply boolean := coalesce(nullif(current_setting('sps.recovery_apply',true),''),'false')::boolean;`);
  let returns = 0;
  body = body.replace(/return (jsonb_build_object\([\s\S]*?\));/g, (_, result) => {
    returns++;
    return `perform set_config('sps.recovery_result',(${result})::text,true);
    raise notice 'sps_stop_report_recovery %',current_setting('sps.recovery_result');
    return;`;
  });
  if (returns !== 2) throw new Error('Recovery return contract changed; review generator before use');
  return `-- Generated from the tested recovery body. ${apply ? 'APPLY' : 'DRY RUN'}
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.role','service_role',true);
select set_config('sps.recovery_backup_key',${literal(sourceBackupKey)},true);
select set_config('sps.recovery_apply','${apply}',true);
do $sps_report_recovery$${body}$sps_report_recovery$;
select current_setting('sps.recovery_result')::jsonb as report_recovery;
commit;
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const backupIndex = args.indexOf('--backup');
  if (backupIndex < 0 || !args[backupIndex + 1] || args.some((arg, index) => index !== backupIndex && index !== backupIndex + 1 && arg !== '--apply')) {
    throw new Error('Usage: node scripts/run-stop-report-backup-recovery.mjs --backup EXACT_BACKUP_KEY [--apply]');
  }
  process.stdout.write(await buildStopReportRecoverySQL({ sourceBackupKey: args[backupIndex + 1], apply: args.includes('--apply') }));
}
