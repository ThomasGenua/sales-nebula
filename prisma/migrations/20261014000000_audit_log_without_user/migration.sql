-- An audit entry for a change no signed-in person made (a web form, inbound
-- mail, a job) has no user. The foreign key stays ON DELETE RESTRICT.
ALTER TABLE "AuditLog" ALTER COLUMN "userId" DROP NOT NULL;
