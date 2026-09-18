-- Activity.date, CaseComment.isInternal and Email.toName all forced callers to
-- supply a value the API never sent, so activity creation, every case comment
-- and email send failed at the database. Defaults make the columns optional
-- for writers without changing any existing row.

ALTER TABLE "Activity" ALTER COLUMN "date" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "CaseComment" ALTER COLUMN "isInternal" SET DEFAULT false;
ALTER TABLE "Email" ADD COLUMN IF NOT EXISTS "toName" TEXT;
