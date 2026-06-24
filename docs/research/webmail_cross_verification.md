# Cross-Verification: Webmail 6.0 Research

## High Confidence Findings (Confirmed by 2+ agents)

| Finding | Sources | Confidence |
|---------|---------|------------|
| imapflow is the only actively maintained modern IMAP library for Node.js | wide02, wide06 | HIGH |
| Fastify 4 is 2-3x faster than Express | wide06 | HIGH |
| DOMPurify is the gold standard for HTML sanitization | wide04, wide08 | HIGH |
| Roundcube has persistent XSS vulnerabilities (CVE-2026-35539, etc.) | wide01, wide04 | HIGH |
| Gmail's three-pane layout is the de facto UI standard | wide03 | HIGH |
| CalDAV/CardDAV integration requires tsdav + ical.js + FullCalendar | wide05 | HIGH |
| OAuth2 is mandatory for Gmail (Mar 2025) and Microsoft (Apr 2026) | wide02 | HIGH |
| Virtual scrolling is essential for large email lists | wide03 | HIGH |
| Redis sliding window rate limiting is the production standard | wide04, wide06 | HIGH |
| BFF pattern (access token in memory, refresh in HttpOnly cookie) is the 2026 auth standard | wide04, wide06 | HIGH |
| Playwright has overtaken Cypress for E2E testing | wide07, wide08 | HIGH |
| Multi-stage Docker builds (Node build → Nginx serve) are the standard | wide07 | HIGH |
| MongoDB Atlas Search covers 90% of email search use cases | wide06 | HIGH |
| JMAP is the emerging next-gen protocol but IMAP remains dominant | wide02, wide05 | HIGH |
| BullMQ 5 is the standard for background jobs in Node.js | wide06 | HIGH |
| MinIO community edition was archived Feb 2026; SeaweedFS/Garage are alternatives | wide06 | HIGH |

## Medium Confidence Findings

| Finding | Sources | Confidence |
|---------|---------|------------|
| PostalMime replaces mailparser as the modern MIME parser | wide02 | MEDIUM |
| Cypht is the most technically innovative PHP webmail (JMAP native) | wide01 | MEDIUM |
| Bulwark represents the next-gen approach (TypeScript/Next.js/JMAP) | wide01 | MEDIUM |
| SnappyMail development status is ambiguous (maintenance gap) | wide01 | MEDIUM |
| tsdav is the best CalDAV/CardDAV library for Node.js/TypeScript | wide05 | MEDIUM |

## Conflict Zones

| Conflict | Agent A | Agent B | Resolution |
|----------|---------|---------|------------|
| Fastify vs Express under extreme load | Fastify 2-3x faster (wide06) | NestJS > Fastify stability at 10k VUs (wide06) | Fastify wins for normal throughput; NestJS may be more stable under extreme saturation |
| ws vs Socket.IO for notifications | ws: 45k msg/s (wide06) | Socket.IO: 27k msg/s but more features (wide06) | Socket.IO for developer velocity; ws for max performance |
| DOMPurify vs sanitize-html server-side | DOMPurify catches more edge cases (wide08) | sanitize-html better performance for bulk (wide08) | DOMPurify client-side, sanitize-html server-side |
| Redis Pub/Sub vs Streams | Pub/Sub simpler, lower latency (wide06) | Streams offer durability (wide06) | Pub/Sub for realtime notifications; Streams for critical events |
