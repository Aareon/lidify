-- Add columns that were introduced in schema.prisma over time without a matching
-- migration, leaving deployed databases drifted. Every query that selected one of
-- these columns failed with P2022 (e.g. Album.releaseDate broke the data-integrity
-- worker before it reached artist consolidation). Idempotent so it is safe on
-- databases that already have some of these (e.g. created via `prisma db push`).

ALTER TABLE "Album" ADD COLUMN IF NOT EXISTS "releaseDate" TIMESTAMP(3);

ALTER TABLE "PlaylistPendingTrack" ADD COLUMN IF NOT EXISTS "albumArt" TEXT;
ALTER TABLE "PlaylistPendingTrack" ADD COLUMN IF NOT EXISTS "duration" INTEGER;

ALTER TABLE "UserDiscoverConfig" ADD COLUMN IF NOT EXISTS "discoveryMode" TEXT NOT NULL DEFAULT 'mix';
ALTER TABLE "UserDiscoverConfig" ADD COLUMN IF NOT EXISTS "discoveryTimeframe" TEXT NOT NULL DEFAULT '28d';
ALTER TABLE "UserDiscoverConfig" ADD COLUMN IF NOT EXISTS "includeLibraryArtists" BOOLEAN NOT NULL DEFAULT false;
