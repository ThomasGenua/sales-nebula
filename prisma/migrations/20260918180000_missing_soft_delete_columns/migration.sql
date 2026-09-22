-- Routes across the app filter on `deletedAt` for these models and, for five of
-- them, have a delete endpoint that writes it. The column was never created, so
-- Prisma rejected the argument and both halves answered 500. Deal is the only
-- core entity that was missed — Contact, Lead, Account, Case, Activity, Email,
-- Note, Document, Product, Quote, Invoice and Campaign all have it already.

ALTER TABLE "Deal"       ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "Tag"        ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "Macro"      ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "Survey"     ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "Attachment" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "AiAgent"    ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
