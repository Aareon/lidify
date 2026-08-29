-- Store an optional, encrypted OpenRouter API key in system settings so it can
-- be configured at runtime from the admin UI. When set, it overrides the
-- OPENROUTER_API_KEY environment variable; when null, the env var is used.
ALTER TABLE "SystemSettings" ADD COLUMN "openrouterApiKey" TEXT;
