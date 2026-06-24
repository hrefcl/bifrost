# Insight Extraction: Webmail 6.0

## Insight 1: The Postalsys Ecosystem as Accelerant
- **Insight**: The combination of imapflow + PostalMime + EmailEngine represents a battle-tested, compatible email processing stack from a single team. Using these three together dramatically reduces integration risk compared to mixing libraries from different authors.
- **Derived From**: wide02 (IMAP protocols), wide06 (backend stack), wide08 (testing)
- **Rationale**: imapflow is the only actively maintained IMAP library; PostalMime is its designated MIME parser successor; EmailEngine demonstrates production viability. This ecosystem alignment is unique in the Node.js email space.
- **Implications**: For Webmail 6.0, adopting the full postalsys stack (imapflow + PostalMime) for email processing minimizes compatibility issues and ensures consistent TypeScript support.
- **Confidence**: HIGH

## Insight 2: Security-First Architecture is Non-Negotiable
- **Insight**: Roundcube's 15+ CVEs in H1 2026, including nation-state exploitation (APT28), demonstrate that webmail security cannot be an afterthought. The combination of server-side HTML sanitization (DOMPurify), strict CSP headers, credential encryption (AES-256-GCM), and BFF authentication pattern must be architected from day one, not bolted on later.
- **Derived From**: wide01 (landscape), wide04 (security), wide08 (testing)
- **Rationale**: XSS via email HTML is the #1 attack vector against webmail clients. Roundcube's repeated XSS vulnerabilities stem from architectural decisions made years ago. Sanitizing at multiple layers (server-side DOMPurify + CSP + input validation) is the only viable defense.
- **Implications**: Webmail 6.0 must implement a defense-in-depth security strategy: DOMPurify server-side before storing/rendering, strict CSP headers, isolated iframe for HTML email preview, and encrypted credential storage.
- **Confidence**: HIGH

## Insight 3: JMAP as Future-Proofing Investment
- **Insight**: While IMAP remains dominant and must be supported for universal compatibility, JMAP represents the future of email protocols. Supporting both IMAP (for existing servers) and JMAP (for modern servers like Stalwart) positions Webmail 6.0 as forward-compatible while maintaining backward compatibility.
- **Derived From**: wide02 (IMAP protocols), wide05 (CalDAV/calendar)
- **Rationale**: JMAP offers 3-5x faster sync, 80-90% less bandwidth, native push via WebSocket, and unified support for email + contacts + calendars. Fastmail, Stalwart, and Thunderbird are all investing in JMAP. However, IMAP will remain necessary for legacy servers for years.
- **Implications**: The architecture should abstract the protocol layer so that both IMAP and JMAP can be supported through a unified internal API, with JMAP as a first-class citizen for supported servers.
- **Confidence**: HIGH

## Insight 4: CalDAV Integration Completes the Email Experience
- **Insight**: Calendar integration is not a "nice-to-have" but a competitive necessity. Gmail, Outlook, and every modern email client integrates calendar invitations (.ics) directly into the email workflow. Webmail 6.0 must handle .ics attachments, display event previews in emails, and sync calendars via CalDAV.
- **Derived From**: wide05 (CalDAV/calendar), wide01 (competitive landscape)
- **Rationale**: Roundcube's calendar plugin is described as "painful" to install. Nextcloud Mail auto-detects .ics invitations. Users expect to accept/decline meeting invites directly from their email client. The stack tsdav + ical.js + FullCalendar provides a complete solution.
- **Implications**: Calendar must be a core feature (not a plugin), with CalDAV sync, .ics parsing for email invitations, and a FullCalendar-based UI component.
- **Confidence**: HIGH

## Insight 5: Headers-First, Body-On-Demand is the Performance Key
- **Insight**: The single most important performance decision for Webmail 6.0 is the sync strategy: fetch headers only for inbox listing, load body on demand when user opens an email. This pattern, combined with MongoDB caching of headers and Redis for session/body cache, enables sub-second inbox loading even for large mailboxes.
- **Derived From**: wide02 (IMAP sync), wide06 (backend architecture)
- **Rationale**: IMAP BODY.PEEK for headers is fast; fetching full bodies for every email in a large inbox would be prohibitively slow. Gmail and every modern email client use this pattern. MongoDB acts as a local index; Redis caches hot bodies.
- **Implications**: The sync engine must implement headers-first fetching with incremental updates (CONDSTORE/QRESYNC for supporting servers, UID-based fallback for others), with body caching in Redis (TTL 1 hour).
- **Confidence**: HIGH

## Insight 6: Testing Strategy Must Cover the Full Email Pipeline
- **Insight**: Email applications have unique testing requirements that go beyond typical web apps: MIME parsing, HTML sanitization, IMAP protocol compliance, SMTP delivery, and attachment handling. A comprehensive testing strategy requires mock IMAP/SMTP servers, XSS payload fixtures, and real disposable inboxes for E2E flows.
- **Derived From**: wide08 (testing), wide04 (security)
- **Rationale**: CVE-2025-15599 (DOMPurify bypass) shows that even battle-tested libraries have vulnerabilities. Mocking sendEmail() only catches that it was called, not that the email renders correctly or links work. The testing pyramid must include: unit tests for sanitization with known XSS payloads, integration tests with mock IMAP, and E2E tests with real disposable inboxes.
- **Implications**: Webmail 6.0 testing stack: Vitest (unit) + fastify.inject (integration) + Playwright + MailSlurp/Ethereal (E2E), with dedicated XSS regression fixtures.
- **Confidence**: HIGH

## Insight 7: Docker Compose is Production-Viable for Self-Hosted Webmail
- **Insight**: For a self-hosted webmail targeting individuals and small organizations, Docker Compose with proper health checks, restart policies, and resource limits is production-ready and significantly simpler than Kubernetes. This aligns with the project's goal of being a transparent Roundcube replacement.
- **Derived From**: wide07 (DevOps), wide01 (competitive landscape)
- **Rationale**: Kubernetes adds significant operational complexity that most self-hosters don't need. Docker Compose with multi-stage builds, Nginx reverse proxy, and named volumes provides a complete deployment solution. The "Mailu/Mailcow" pattern demonstrates this works for email infrastructure.
- **Implications**: Primary deployment target: Docker Compose. Kubernetes manifests as optional for enterprise deployments. Include Nginx, health checks, log rotation, and secrets management in the default compose setup.
- **Confidence**: HIGH

## Insight 8: UI/UX Differentiation Through Gmail-Like Design
- **Insight**: The most impactful UX decision is adopting Gmail's three-pane layout with conversation threading, as this is what users expect from a modern email client. Virtual scrolling, keyboard shortcuts (Gmail-style), drag-and-drop, and auto-save drafts are not optional features but baseline expectations.
- **Derived From**: wide03 (frontend UI), wide01 (competitive landscape)
- **Rationale**: Roundcube users are migrating specifically because of UI/UX limitations. SnappyMail's 99% Lighthouse score shows performance is a competitive advantage. Gmail's conversation view, three-pane layout, and keyboard shortcuts are the de facto standard.
- **Implications**: Three-pane layout (sidebar + email list + reading pane), virtual scrolling for email lists, conversation threading with JWZ algorithm, keyboard shortcuts (G, C, R, F, etc.), auto-save drafts every 10 seconds, and drag-and-drop for folders/emails.
- **Confidence**: HIGH
