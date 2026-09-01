-- Durable inbound-webhook store for crash-safe replay + de-dup (issue #1).
-- Idempotent (IF NOT EXISTS) to match the project's other additive migrations.
CREATE TABLE IF NOT EXISTS "WebhookEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "downloadId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WebhookEvent_dedupeKey_key" ON "WebhookEvent"("dedupeKey");
CREATE INDEX IF NOT EXISTS "WebhookEvent_status_idx" ON "WebhookEvent"("status");
CREATE INDEX IF NOT EXISTS "WebhookEvent_downloadId_idx" ON "WebhookEvent"("downloadId");
CREATE INDEX IF NOT EXISTS "WebhookEvent_receivedAt_idx" ON "WebhookEvent"("receivedAt");
