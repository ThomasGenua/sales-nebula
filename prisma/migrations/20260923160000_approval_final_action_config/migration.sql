-- The approve route read finalApprovalConfig, which never existed, so a
-- process's final approval action never ran; rejection had no action at all.
-- AlterTable
ALTER TABLE "ApprovalProcess" ADD COLUMN     "finalApprovalConfig" JSONB,
ADD COLUMN     "finalRejectionConfig" JSONB;
