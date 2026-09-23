-- PriceBookEntry duplicated PricebookEntry: same purpose, no relation to a
-- price book, and nothing in the app reads or writes it (product pricing now
-- reads PricebookEntry). Price book data lives in PricebookEntry.
--
-- The table is dropped only if it is empty. If this migration fails with the
-- message below, copy the rows you need into "PricebookEntry", delete them
-- from "PriceBookEntry", run `prisma migrate resolve --rolled-back
-- 20260923100000_retire_duplicate_price_book_entry`, and deploy again.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PriceBookEntry" LIMIT 1) THEN
    RAISE EXCEPTION 'PriceBookEntry still holds rows. Move them into "PricebookEntry" before retiring the duplicate table.';
  END IF;
END $$;

-- DropTable
DROP TABLE "PriceBookEntry";
