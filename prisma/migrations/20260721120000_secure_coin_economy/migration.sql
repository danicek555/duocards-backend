-- Prevent legacy negative balances from blocking the new invariant.
UPDATE "users" SET "coins" = 0 WHERE "coins" < 0;

-- CreateTable
CREATE TABLE "coin_transactions" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "referenceId" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "coin_transactions_balanceAfter_check" CHECK ("balanceAfter" >= 0)
);

-- Existing accounts receive an opening snapshot; later rows represent real deltas.
INSERT INTO "coin_transactions" (
    "userId",
    "amount",
    "balanceAfter",
    "type"
)
SELECT "id", 0, "coins", 'OPENING_BALANCE'
FROM "users";

-- New claims always set claimDate. Keeping it nullable preserves legacy history
-- without deleting duplicate rows that may already exist.
ALTER TABLE "completion_rewards" ADD COLUMN "claimDate" DATE;

-- CreateIndex
CREATE INDEX "coin_transactions_userId_createdAt_idx"
ON "coin_transactions"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "completion_rewards_userId_flashcardSetId_claimDate_key"
ON "completion_rewards"("userId", "flashcardSetId", "claimDate");

-- AddConstraint
ALTER TABLE "users"
ADD CONSTRAINT "users_coins_nonnegative_check" CHECK ("coins" >= 0);

-- AddForeignKey
ALTER TABLE "coin_transactions"
ADD CONSTRAINT "coin_transactions_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
