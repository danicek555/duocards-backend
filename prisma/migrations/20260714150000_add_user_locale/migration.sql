-- Add locale preference for users and pending registrations
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locale" TEXT NOT NULL DEFAULT 'cs';
ALTER TABLE "pending_registrations" ADD COLUMN IF NOT EXISTS "locale" TEXT NOT NULL DEFAULT 'cs';
