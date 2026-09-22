-- Per-user display preferences: an IANA time zone and a BCP 47 locale.
-- Null means the browser's own, which is how every date was shown before.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "locale" TEXT,
ADD COLUMN     "timezone" TEXT;

