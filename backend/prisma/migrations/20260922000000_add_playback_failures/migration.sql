-- Client-reported playback failures for local-file tracks (Library Health).
-- Idempotent (IF NOT EXISTS) to match the project's other additive migrations.
CREATE TABLE IF NOT EXISTS "PlaybackFailure" (
    "trackId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "error" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "lastUserId" TEXT,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlaybackFailure_pkey" PRIMARY KEY ("trackId")
);

CREATE INDEX IF NOT EXISTS "PlaybackFailure_lastAt_idx" ON "PlaybackFailure"("lastAt");
