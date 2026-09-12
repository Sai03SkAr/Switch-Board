-- Fixes a real bug found while testing Phase 2 (see PROGRESS.md and ledger.ts's
-- IdempotencyKeyConflictError doc comment): capture()'s idempotency-replay path looked up
-- an existing transaction by idempotency_key alone, with no check that it was actually
-- the transaction for THIS hold. A key reused across two different holds would silently
-- return the wrong hold's charged amount. This column makes that check possible and exact.

ALTER TABLE transactions ADD COLUMN hold_id UUID REFERENCES holds(id);
CREATE INDEX transactions_hold_id_idx ON transactions (hold_id) WHERE hold_id IS NOT NULL;
