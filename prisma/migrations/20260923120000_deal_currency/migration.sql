-- Deals carry the currency their value is in. Totals convert each deal to the
-- default currency at the current rate (src/utils/currency.js).

-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "currency" TEXT;

-- Every deal written before this had its value in the default currency. Say
-- so explicitly, so a later change of default cannot re-denominate them. With
-- no default currency configured the column stays null, which counts as the
-- default.
UPDATE "Deal" SET "currency" = (SELECT "code" FROM "Currency" WHERE "isDefault" = true LIMIT 1)
WHERE "currency" IS NULL;
