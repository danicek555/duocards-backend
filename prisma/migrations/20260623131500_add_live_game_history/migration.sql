-- CreateTable
CREATE TABLE "live_games" (
    "id" SERIAL NOT NULL,
    "hostUserId" INTEGER NOT NULL,
    "roomCode" TEXT NOT NULL,
    "setName" TEXT,
    "totalPlayers" INTEGER NOT NULL DEFAULT 0,
    "winnerName" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_game_players" (
    "id" SERIAL NOT NULL,
    "liveGameId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "correct" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "live_game_players_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "live_games_hostUserId_createdAt_idx" ON "live_games"("hostUserId", "createdAt");

-- CreateIndex
CREATE INDEX "live_game_players_liveGameId_idx" ON "live_game_players"("liveGameId");

-- AddForeignKey
ALTER TABLE "live_games" ADD CONSTRAINT "live_games_hostUserId_fkey" FOREIGN KEY ("hostUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_game_players" ADD CONSTRAINT "live_game_players_liveGameId_fkey" FOREIGN KEY ("liveGameId") REFERENCES "live_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
