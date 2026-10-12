#!/usr/bin/env node
// Generates a single atomic SQL transaction; does not connect to any database.
// Usage: node scripts/run-stop-report-backup-recovery.mjs --backup EXACT_BACKUP_KEY [--receipt EXACT_RECEIPT_ID --apply]
// Default is dry run. Output uses anonymous DO, with no function/table DDL.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const literal = value => `'${String(value).replaceAll("'", "''")}'`;
export async function buildStopReportRecoverySQL({ sourceBackupKey, receiptId = null, apply = false }) {
  if (typeof sourceBackupKey !== 'string' || !sourceBackupKey.trim() || sourceBackupKey.includes('\0')) throw new Error('An exact backup key is required');
  if (receiptId !== null && (typeof receiptId !== 'string' || !receiptId.trim() || receiptId.includes('\0') || receiptId.length > 320)) throw new Error('Receipt ID must be an exact nonempty identity');
  if (apply && !receiptId) throw new Error('Apply requires exactly one explicit receipt ID');
  if (typeof apply !== 'boolean') throw new Error('Apply must be an explicit boolean');
  const source = await readFile(new URL('./recover-stop-reports-from-backup.sql', import.meta.url), 'utf8');
  const match = source.match(/as \$recovery\$([\s\S]+?)\$recovery\$;/);
  if (!match) throw new Error('Recovery body could not be located');
  let body = match[1].replace(/\bdeclare\b/, `declare
  p_source_backup_key text := current_setting('sps.recovery_backup_key');
  p_receipt_id text := nullif(current_setting('sps.recovery_receipt_id',true),'');
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
select set_config('sps.recovery_receipt_id',${literal(receiptId || '')},true);
select set_config('sps.recovery_apply','${apply}',true);
do $sps_report_recovery$${body}$sps_report_recovery$;
select current_setting('sps.recovery_result')::jsonb as report_recovery;
commit;
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--apply' && !options.apply) options.apply = true;
    else if (['--backup','--receipt'].includes(flag) && args[index + 1] && !args[index + 1].startsWith('--')) {
      const key = flag === '--backup' ? 'sourceBackupKey' : 'receiptId';
      if (options[key]) throw new Error(`Duplicate option ${flag}`);
      options[key] = args[++index];
    } else throw new Error('Usage: node scripts/run-stop-report-backup-recovery.mjs --backup EXACT_BACKUP_KEY [--receipt EXACT_RECEIPT_ID --apply]');
  }
  process.stdout.write(await buildStopReportRecoverySQL(options));
}
