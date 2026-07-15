CREATE TABLE "registration_attempts" (
    "id" SERIAL NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'cs',
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "registration_attempts_tokenHash_key"
ON "registration_attempts"("tokenHash");

CREATE INDEX "registration_attempts_email_idx"
ON "registration_attempts"("email");

CREATE INDEX "registration_attempts_expiresAt_idx"
ON "registration_attempts"("expiresAt");
