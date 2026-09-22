-- The bug workflow stamps a timestamp on each transition and the statistics
-- endpoint selects it, but neither column was ever created, so moving a bug to
-- Fixed or Verified returned 500 and the stats query threw.
ALTER TABLE "Bug" ADD COLUMN IF NOT EXISTS "fixedAt" TIMESTAMP(3);
ALTER TABLE "Bug" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
