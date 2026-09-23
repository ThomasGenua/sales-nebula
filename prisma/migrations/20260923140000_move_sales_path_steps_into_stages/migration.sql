-- SalesPathStep held the stages the seed wrote, but the API has only ever read
-- SalesPathStage, so those stages never appeared anywhere. Copy every step
-- across (skipping any stage already there by the same name), then drop the
-- table nothing reads. No row is lost: each one is copied before the drop.
INSERT INTO "SalesPathStage" ("id", "salesPathId", "name", "position", "guidance", "fields", "successCriteria", "createdAt", "updatedAt")
SELECT s."id", s."pathId", s."stageName", s."stepOrder", s."guidance", s."keyFields",
       CASE WHEN s."successCriteria" IS NULL THEN NULL ELSE to_jsonb(s."successCriteria") END,
       now(), now()
FROM "SalesPathStep" s
WHERE NOT EXISTS (
  SELECT 1 FROM "SalesPathStage" t WHERE t."salesPathId" = s."pathId" AND t."name" = s."stageName"
);

-- DropForeignKey
ALTER TABLE "SalesPathStep" DROP CONSTRAINT "SalesPathStep_pathId_fkey";

-- DropTable
DROP TABLE "SalesPathStep";
