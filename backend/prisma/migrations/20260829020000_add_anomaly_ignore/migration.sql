-- Persist admin-dismissed anomalies (e.g. false-positive duplicate-artist
-- suggestions) so the Library Health detector stops surfacing them.
CREATE TABLE IF NOT EXISTS "AnomalyIgnore" (
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnomalyIgnore_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "AnomalyIgnore_type_idx" ON "AnomalyIgnore" ("type");
