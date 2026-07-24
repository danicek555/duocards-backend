ALTER TABLE "words"
ADD COLUMN "reviewIntervalDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "reviewEase" INTEGER NOT NULL DEFAULT 220,
ADD COLUMN "reviewStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "reviewCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "correctReviewCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lapseCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastReviewedAt" TIMESTAMP(3),
ADD COLUMN "nextReviewAt" TIMESTAMP(3);

CREATE TABLE "study_sessions" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "flashcardSetId" INTEGER NOT NULL,
    "wordIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "totalWords" INTEGER NOT NULL,
    "isFullSet" BOOLEAN NOT NULL DEFAULT false,
    "isScheduledReview" BOOLEAN NOT NULL DEFAULT true,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "study_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "study_reviews" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "wordId" INTEGER NOT NULL,
    "flashcardSetId" INTEGER NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "rating" VARCHAR(12) NOT NULL,
    "intervalBeforeDays" INTEGER NOT NULL,
    "intervalAfterDays" INTEGER NOT NULL,
    "easeAfter" INTEGER NOT NULL,
    "nextReviewAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "study_reviews_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "completion_rewards" ADD COLUMN "studySessionId" UUID;

CREATE INDEX "words_userId_nextReviewAt_idx" ON "words"("userId", "nextReviewAt");
CREATE INDEX "words_flashcardSetId_nextReviewAt_idx" ON "words"("flashcardSetId", "nextReviewAt");
CREATE INDEX "study_sessions_userId_startedAt_idx" ON "study_sessions"("userId", "startedAt");
CREATE INDEX "study_sessions_flashcardSetId_startedAt_idx" ON "study_sessions"("flashcardSetId", "startedAt");
CREATE UNIQUE INDEX "study_reviews_idempotencyKey_key" ON "study_reviews"("idempotencyKey");
CREATE INDEX "study_reviews_sessionId_reviewedAt_idx" ON "study_reviews"("sessionId", "reviewedAt");
CREATE INDEX "study_reviews_userId_reviewedAt_idx" ON "study_reviews"("userId", "reviewedAt");
CREATE INDEX "study_reviews_wordId_reviewedAt_idx" ON "study_reviews"("wordId", "reviewedAt");
CREATE UNIQUE INDEX "completion_rewards_studySessionId_key" ON "completion_rewards"("studySessionId");

ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_flashcardSetId_fkey" FOREIGN KEY ("flashcardSetId") REFERENCES "flashcard_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "study_reviews" ADD CONSTRAINT "study_reviews_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "study_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "study_reviews" ADD CONSTRAINT "study_reviews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "study_reviews" ADD CONSTRAINT "study_reviews_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "words"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "study_reviews" ADD CONSTRAINT "study_reviews_flashcardSetId_fkey" FOREIGN KEY ("flashcardSetId") REFERENCES "flashcard_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "completion_rewards" ADD CONSTRAINT "completion_rewards_studySessionId_fkey" FOREIGN KEY ("studySessionId") REFERENCES "study_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
