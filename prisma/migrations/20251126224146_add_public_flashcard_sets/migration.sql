-- AlterTable
ALTER TABLE "flashcard_sets" ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publicCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "flashcard_sets_publicCode_key" ON "flashcard_sets"("publicCode");
