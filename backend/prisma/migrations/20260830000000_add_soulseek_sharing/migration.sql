-- Soulseek Sharing scaffolding: config-only columns for a future upload/serve
-- feature. Idempotent (IF NOT EXISTS) to stay safe against schema drift, matching
-- the project's other additive migrations.
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "soulseekSharingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "soulseekSharePath" TEXT DEFAULT '/music';
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "soulseekUploadSlots" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "soulseekUploadSpeedLimitKbps" INTEGER NOT NULL DEFAULT 0;
