import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInvoiceProjectionIntent, projectInvoiceAccountingAuthority, withoutLegacyAutomaticInvoiceFee } from '../invoiceAuthorityProjection.js';
import { mergeStoredState } from '../stateMerge.js';

const line = { id: 'work', desc: 'October maintenance', qty: '1', unitPrice: '350.00', amount: 350, taxable: false };
const original = { id: 'invoice', qbId: '52', qbCustomerId: '8', number: '2058', status: 'Overdue',
  total: 350, balance: 350, lineItems: [line], notes: 'Before', qbSyncStatus: 'synced' };
const fee = { id: 'lf_invoice_2026-10-22', desc: 'Late Fee', qty: '1', unitPrice: '17.50', amount: 17.5, taxable: false, isLateFee: true, kind: 'lateFee' };
const withFee = { ...original, lineItems: [line, fee], lateFeeAppliedAt: '2026-10-22' };
const paid = { ...original, status: 'Paid', balance: 0 };
const resolution = { resolvedAt: '2026-10-22T15:00:00Z', confirmedResultHash: 'verified-result' };

test('an exact automatic fee from a historical overdue base cannot reappear over a fresh payment', () => {
  const local = { ...withFee, notes: 'Real field note', locallyEdited: true, qbSyncStatus: 'dirty' };
  const normalized = normalizeInvoiceProjectionIntent([original], [local], [paid]);
  assert.equal(normalized[0].notes, 'Real field note'); assert.deepEqual(normalized[0].lineItems, [line]);
  assert.equal(normalized[0].lateFeeAppliedAt, undefined);
  const merged = JSON.parse(mergeStoredState('sps_invoices', [original], normalized, [paid], { prefer: 'local' }).value)[0];
  assert.equal(merged.status, 'Paid'); assert.equal(merged.balance, 0); assert.deepEqual(merged.lineItems, [line]);
  assert.equal(merged.qbSyncStatus, 'synced'); assert.notEqual(merged.locallyEdited, true);
  assert.equal(local.lineItems.length, 2, 'the original recovery source must remain untouched');
});

test('a real added charge or changed service amount is never silently discarded as an automatic fee', () => {
  const variants = [
    { ...withFee, total: 367.5 },
    { ...withFee, lineItems: [{ ...line, unitPrice: '400.00', amount: 400 }, fee] },
    { ...withFee, lineItems: [line, { ...fee, id: 'manual' }] },
    { ...withFee, lineItems: [line, { ...fee, qty: 1 }] },
    { ...withFee, lineItems: [line, { ...fee, unitPrice: 17.5 }] },
    { ...withFee, lineItems: [line, { ...fee, sourceVisitLineId: 'manual-visit-charge' }] },
    { ...withFee, lineItems: [fee, line] },
    { ...withFee, lineItems: [line, { ...fee, amount: 18 }] },
    { ...withFee, qbId: '' },
  ];
  for (const candidate of variants) assert.equal(withoutLegacyAutomaticInvoiceFee(candidate, [original, paid]), candidate);
  assert.equal(withoutLegacyAutomaticInvoiceFee(withFee, []), withFee, 'no known exact original means no removal');
});

test('newer confirmed accounting protects paid values and review receipts while preserving a real independent note', () => {
  const canonical = { ...paid, qbReviewResolution: resolution, qbSyncToken: '12', locallyEdited: false };
  const local = { ...withFee, notes: 'Keep this note', qbMadeUpLocalValue: true, sourceStopId: 'stop' };
  const [result] = projectInvoiceAccountingAuthority([original], [local], [canonical]);
  assert.equal(result.status, 'Paid'); assert.equal(result.balance, 0); assert.equal(result.total, 350);
  assert.deepEqual(result.lineItems, [line]); assert.equal(result.lateFeeAppliedAt, undefined);
  assert.equal(result.qbMadeUpLocalValue, undefined); assert.deepEqual(result.qbReviewResolution, resolution);
  assert.equal(result.notes, 'Keep this note'); assert.equal(result.sourceStopId, 'stop');
  assert.equal(local.lineItems.length, 2);
});

test('a server recovery marker protects finance but a deliberate edit made after that exact review remains pending', () => {
  const canonical = { ...paid, qbWriteReview: { candidateId: 'candidate-1', reason: 'different-finance', savedAt: '2026-10-22T16:00:00Z' } };
  const local = { ...original, total: 400, notes: 'Edited' };
  assert.equal(projectInvoiceAccountingAuthority([original], [local], [canonical])[0].total, 350);
  const later = { ...canonical, total: 450, qbWriteReview: undefined };
  const [result] = projectInvoiceAccountingAuthority([canonical], [later], [canonical]);
  assert.equal(result.total, 450, 'new finance after the reviewed baseline is genuine candidate work');
  assert.deepEqual(result.qbWriteReview, canonical.qbWriteReview, 'local editing cannot erase the server recovery link');
});

test('costing metadata survives when the entire accounting projection exactly matches canonical', () => {
  const canonical = { ...paid, qbReviewResolution: resolution };
  const local = { ...paid, lineItems: [{ ...line, unitCost: 50, sourceStopId: 'actual-stop' }] };
  const [result] = projectInvoiceAccountingAuthority([original], [local], [canonical]);
  assert.equal(result.lineItems[0].unitCost, 50); assert.equal(result.lineItems[0].sourceStopId, 'actual-stop');
  const [different] = projectInvoiceAccountingAuthority([original], [{ ...local, balance: 350 }], [canonical]);
  assert.deepEqual(different.lineItems, canonical.lineItems, 'a different service/accounting proposal stays in recovery instead of borrowing canonical approval');
});

test('authority does not transfer through a conflicting QuickBooks identity or ambiguous alias', () => {
  const canonical = { ...paid, qbReviewResolution: resolution };
  const wrong = { ...original, qbId: 'different' };
  assert.deepEqual(projectInvoiceAccountingAuthority([original], [wrong], [canonical]), [wrong]);
  const alias = { ...original, id: 'other-app-id' };
  assert.deepEqual(projectInvoiceAccountingAuthority([], [alias], [canonical, { ...canonical, id: 'duplicate' }]), [alias]);
  assert.equal(projectInvoiceAccountingAuthority([], [alias], [canonical])[0].balance, 0, 'a unique QB identity can join its import alias');
});

test('a resolved recovery marker is removed from display without altering the retained draft', () => {
  const local = { ...original, qbWriteReview: { candidateId: 'resolved' }, qbReviewResolution: { stale: true } };
  const [result] = projectInvoiceAccountingAuthority([original], [local], [paid]);
  assert.equal(result.qbWriteReview, undefined); assert.equal(result.qbReviewResolution, undefined);
  assert.equal(local.qbWriteReview.candidateId, 'resolved');
});
