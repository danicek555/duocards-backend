CREATE TABLE "live_sessions" (
    "id" TEXT NOT NULL,
    "hostUserId" INTEGER NOT NULL,
    "roomCode" VARCHAR(8) NOT NULL,
    "modeId" VARCHAR(40) NOT NULL,
    "modeVersion" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(20) NOT NULL DEFAULT 'LOBBY',
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "settings" JSONB NOT NULL,
    "currentRoundId" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "live_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "live_participants" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "nickname" VARCHAR(40) NOT NULL,
    "role" VARCHAR(16) NOT NULL DEFAULT 'PLAYER',
    "score" INTEGER NOT NULL DEFAULT 0,
    "correct" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    CONSTRAINT "live_participants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "live_rounds" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "prompt" TEXT NOT NULL,
    "correctAnswer" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "timeLimitSeconds" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3),
    "locksAt" TIMESTAMP(3),
    "revealedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "live_rounds_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "live_answers" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "normalizedAnswer" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "responseTimeMs" INTEGER NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "live_answers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "live_sessions_roomCode_key" ON "live_sessions"("roomCode");
CREATE INDEX "live_sessions_hostUserId_createdAt_idx" ON "live_sessions"("hostUserId", "createdAt");
CREATE INDEX "live_sessions_status_expiresAt_idx" ON "live_sessions"("status", "expiresAt");
CREATE UNIQUE INDEX "live_participants_sessionId_nickname_key" ON "live_participants"("sessionId", "nickname");
CREATE INDEX "live_participants_sessionId_score_idx" ON "live_participants"("sessionId", "score");
CREATE UNIQUE INDEX "live_rounds_sessionId_sequence_key" ON "live_rounds"("sessionId", "sequence");
CREATE INDEX "live_rounds_sessionId_state_idx" ON "live_rounds"("sessionId", "state");
CREATE UNIQUE INDEX "live_answers_roundId_participantId_key" ON "live_answers"("roundId", "participantId");
CREATE UNIQUE INDEX "live_answers_participantId_idempotencyKey_key" ON "live_answers"("participantId", "idempotencyKey");
CREATE INDEX "live_answers_roundId_createdAt_idx" ON "live_answers"("roundId", "createdAt");

ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_hostUserId_fkey" FOREIGN KEY ("hostUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_participants" ADD CONSTRAINT "live_participants_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_rounds" ADD CONSTRAINT "live_rounds_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_answers" ADD CONSTRAINT "live_answers_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "live_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_answers" ADD CONSTRAINT "live_answers_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "live_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
