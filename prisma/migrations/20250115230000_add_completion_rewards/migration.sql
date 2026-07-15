-- CreateTable
CREATE TABLE "completion_rewards" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "flashcardSetId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "completion_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "completion_rewards_userId_createdAt_idx" ON "completion_rewards"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "completion_rewards" ADD CONSTRAINT "completion_rewards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;





