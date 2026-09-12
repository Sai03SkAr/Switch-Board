-- Supports the SSRF guard added to packages/core/src/upstream.ts (plan/09-risks.md R6).
-- The guard blocks private/loopback/link-local hosts by default — but LibreTranslate is
-- DELIBERATELY self-hosted at http://localhost:5000 (plan/12-provider-shortlist.md: "if
-- you run it yourself, there is no third-party ToS to violate"). A blanket block would
-- silently break the one provider that's supposed to run locally. This is an explicit,
-- reviewed exception per provider, not a way to bypass the guard generally — it defaults
-- to false, and every provider needs a human to flip it, the same discipline as
-- resale_allowed.

ALTER TABLE providers ADD COLUMN allow_local_target BOOLEAN NOT NULL DEFAULT false;
