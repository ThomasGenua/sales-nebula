-- The last columns the routes read without a migration behind them.
--   User.lastLoginAt   the profile page's "Last Login", now stamped at sign-in
--   Product stock      quantityOnHand / reorderPoint / reorderQuantity for the
--                      inventory report; null means stock is not tracked
--   Invoice.subscriptionId  a subscription's invoice history
-- All nullable, so existing rows are untouched.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "subscriptionId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "quantityOnHand" INTEGER,
ADD COLUMN     "reorderPoint" INTEGER,
ADD COLUMN     "reorderQuantity" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastLoginAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Invoice_subscriptionId_idx" ON "Invoice"("subscriptionId");

