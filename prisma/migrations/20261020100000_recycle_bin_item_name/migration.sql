-- What a deleted record is listed and searched by. It lived only inside the
-- JSON snapshot, so the bin could not be searched. The entries already in
-- the bin are named here as services/recycleBin (binName) names new ones:
-- a person by their name, else their email; anything else by its name or
-- subject, else its number.
ALTER TABLE "RecycleBinItem" ADD COLUMN "name" TEXT;

UPDATE "RecycleBinItem" SET "name" = LEFT(COALESCE(
  CASE WHEN "module" IN ('contacts', 'leads', 'personAccounts', 'prospects') THEN NULLIF(CONCAT_WS(' ',
    NULLIF(BTRIM("recordData"->>'firstName'), ''), NULLIF(BTRIM("recordData"->>'lastName'), '')), '') END,
  NULLIF(BTRIM("recordData"->>'name'), ''),
  NULLIF(BTRIM("recordData"->>'subject'), ''),
  NULLIF(BTRIM("recordData"->>'number'), ''),
  NULLIF(BTRIM("recordData"->>'invoiceNumber'), ''),
  NULLIF(BTRIM("recordData"->>'quoteNumber'), ''),
  NULLIF(BTRIM("recordData"->>'orderNumber'), ''),
  NULLIF(BTRIM("recordData"->>'contractNumber'), ''),
  NULLIF(BTRIM("recordData"->>'caseNumber'), ''),
  NULLIF(BTRIM("recordData"->>'workOrderNumber'), ''),
  NULLIF(BTRIM("recordData"->>'subscriptionNumber'), ''),
  NULLIF(BTRIM("recordData"->>'email'), ''),
  NULLIF(BTRIM("recordData"->>'to'), '')
), 300);
