# Facet: Testing Strategies for Email Applications

## Key Findings

### 1. Testing IMAP with Mock Servers
- **Mokapi** provides a declarative way to mock both SMTP and IMAP servers, enabling deterministic email workflow testing without external dependencies [^329^]. It supports inbox simulation, folder states, and message retrieval with a web dashboard for inspecting captured emails.
- **ImapFlow** combined with **Ethereal.email** (fake SMTP/IMAP service) allows testing real email flows: ImapFlow connects to the Ethereal IMAP server to fetch and parse emails using `mailparser`'s `simpleParser` [^300^]. This pattern enables end-to-end email receive testing.
- For Java-based projects, **GreenMail** is the established solution for embedded SMTP/POP3/IMAP testing with SSL support [^332^]. No direct equivalent exists for Node.js, making Mokapi or containerized mail servers the practical alternatives.

### 2. Vitest + Vue 3 Composition API Unit Testing
- Vitest is the de facto testing framework for Vue 3 projects using Vite, offering out-of-the-box TypeScript support, Vue Test Utils integration, and HMR for tests [^303^][^287^].
- Components using `<script setup>` and Composition API are tested via `@vue/test-utils`' `mount()` function [^303^]. Basic pattern: `const wrapper = mount(HelloWorld, { props: { name: 'Vitest' } })` [^285^].
- For **testing composables** that use lifecycle hooks (`onMounted`, `onBeforeMount`), a `withSetup` helper is required to wrap the composable inside a Vue component context [^298^][^296^]:
  ```js
  export function withSetup(hook) {
    let result;
    const app = createApp({ setup() { result = hook(); return () => {}; } });
    app.mount(document.createElement("div"));
    return [result, app];
  }
  ```
- For composables using `inject()`, a custom `useInjectedSetup` helper creates a provider hierarchy for testing [^296^].
- **Best practice**: Mock composables at the component level to maintain unit test encapsulation; test the composable itself separately [^306^].

### 3. Supertest + Fastify API Integration Testing
- **Supertest** remains a pragmatic choice for HTTP API testing with Fastify, though the Node.js testing best practices community recommends pure HTTP clients like axios to avoid binding tests to framework objects [^265^].
- **Fastify.inject** is the framework-native alternative that bypasses the HTTP layer entirely, passing requests as JS objects directly to route handlers. It's 2-5x faster than supertest and exercises the full plugin lifecycle, schema compilation, and error handling [^321^].
- The recommended 4-layer testing architecture for Node.js APIs: (A) Unit Tests for core behavior, (B) Service/Use-Case Tests with mocked boundaries, (C) API Integration Tests through supertest/app.inject, (D) Infrastructure Integration Tests with real dependencies [^259^].
- **Nock** is the standard tool for intercepting outbound HTTP requests in tests; `nock.disableNetConnect()` should be used to prevent accidental external calls [^265^].

### 4. Email HTML Sanitization Testing (DOMPurify)
- **DOMPurify** (7M weekly downloads) is the gold standard for DOM-based XSS sanitization. For server-side use with Node.js, it requires **jsdom** (latest version strongly recommended; `happy-dom` is not considered safe) [^283^]. **isomorphic-dompurify** simplifies dual client/server usage [^307^].
- **CVE-2025-15599** (Mar 2026): A critical XSS vulnerability in DOMPurify 3.1.3-3.2.6 allowed bypassing sanitization via `</textarea>` closing tags in attribute values. Patched in 3.2.7 [^281^][^282^]. This underscores the importance of keeping DOMPurify updated and having regression tests for sanitization.
- For server-side bulk processing, **sanitize-html** (~3M weekly downloads) outperforms jsdom/DOMPurify and offers `allowedStyles` for fine-grained CSS property control [^323^]. The two-layer pattern: DOMPurify in browser for preview, sanitize-html on server for storage.
- **Testing strategy**: Use known XSS payload fixtures (OWASP cheat sheet), test both client-side and server-side rendering contexts, verify that sanitized output placed in `innerHTML` doesn't execute scripts, and test edge cases like SVG-based XSS and nested HTML entities.

### 5. Playwright/Cypress E2E Testing for Email Applications
- **Playwright** has overtaken Cypress in popularity, npm downloads, GitHub stars, and job postings as of early 2026 [^261^]. Playwright supports all major browsers (including WebKit/Safari), true parallelism, multi-tab/multi-origin, and built-in `APIRequestContext` for hybrid API+UI tests [^260^][^261^].
- **Playwright's async/await syntax** produces more reliable AI-generated code compared to Cypress's implicit command queue [^261^].
- **Email testing with Playwright**: Use fake SMTP servers (Mailhog, Mailpit, MailSlurp, or temporary email APIs like uncorreotemporal.com) to capture emails, then use Playwright to verify content, click links, and extract OTP codes [^266^][^320^][^324^]. Pattern: create inbox -> trigger email -> poll API for email -> extract data -> complete flow in browser [^320^].
- **Critical insight**: Mocking `sendEmail()` only catches that it was called; real inbox testing catches template render failures, broken links, wrong base URLs, expired SMTP credentials, and SPF/DKIM issues [^320^].

### 6. Mocking SMTP / Email Sending (Nodemailer)
- **Nodemailer-mock** (`nodemailer-mock`) provides a drop-in mock replacement for Nodemailer with `vi.mock("nodemailer")` in Vitest [^297^]. Supports verifying sent emails via `mock.getSentMail()` and testing error scenarios.
- **Ethereal.email** is a real (but fake) SMTP service by the Nodemailer author. Emails are never delivered but can be viewed via web UI or retrieved via IMAP. Ideal for integration testing real SMTP paths [^300^][^276^].
- **Mokapi** offers a mock SMTP server with dashboard for inspecting captured emails, supporting SSL/TLS and authentication testing [^274^].
- **MailSlurp** provides programmatic disposable inboxes with SMTP + REST API for testing email flows at scale in CI/CD [^324^].

### 7. MongoDB In-Memory / Container Testing
- **mongodb-memory-server** is the established in-memory MongoDB for testing, starting at ~7MB RAM. Good for basic CRUD but has limitations: change streams don't work (need replica set), transactions have subtle behavioral differences, and aggregation operators may diverge from real MongoDB [^275^][^278^].
- **Testcontainers + MongoDB** (`@testcontainers/mongodb`) runs real MongoDB in Docker, providing full support for transactions, change streams, and latest aggregation operators [^301^]. Vitest config needs `pool: 'forks'` for container isolation.
- **mongodb-memory-server** setup with Vitest + Supertest pattern: connect before tests, clear collections between tests, stop server after suite [^275^].
- For 2026, Testcontainers is the recommended default for any test touching MongoDB transactions or change streams; mongodb-memory-server remains viable for ultra-fast CRUD unit tests [^301^].

### 8. Redis Testcontainer Integration Testing
- **Testcontainers Redis** (`@testcontainers/redis`) spins up real Redis containers during tests and tears them down automatically [^267^]. No mocks, no shared state between runs.
- Pattern: start container in `beforeAll`, connect client, `flushDb()` between tests, stop in `afterAll` [^267^]. For faster suites, use shared container via Vitest `globalSetup`.
- Supports specific Redis versions (e.g., `redis:7.2-alpine`) and Redis Stack for RediSearch/RedisJSON testing [^267^].
- Also supports open-source alternatives like **Valkey** without changing test logic [^269^].

### 9. Email MIME Parsing and Fixtures
- **mailparser** (by Nodemailer author) provides `simpleParser()` to parse MIME messages into structured objects with `subject`, `text`, `html`, `attachments`, etc. [^300^][^67^]. Used in combination with ImapFlow to parse fetched email sources.
- **Test fixtures**: `.eml` files are the standard format for email test fixtures, containing full MIME structure [^326^][^334^]. Sample fixtures should include: plain text only, HTML only, multipart alternative, attachments (various types), nested MIME parts, encoded headers (RFC 2047), base64 and quoted-printable content.
- **Testing strategy**: Collect real-world `.eml` samples, store as test fixtures, parse with `simpleParser()`, assert on extracted fields. Test edge cases: empty body, very large attachments, malformed MIME boundaries, missing Content-Type headers.

### 10. Code Coverage with GitHub Actions + Vitest
- **Vitest coverage** uses `@vitest/coverage-v8` provider. Recommended reporters: `["text", "json", "json-summary", "html"]` [^216^].
- **`davelosert/vitest-coverage-report-action@v2`** is the go-to GitHub Action for posting coverage reports as PR comments [^216^][^272^]. Features: auto-discovers coverage files, compares against base branch, posts/updates PR comments, supports threshold-based failures.
- **Key features**: `file-coverage-mode: changes` scopes report to PR-modified files only; `reportOnFailure: true` generates coverage even when tests fail; supports monorepo with multiple named reports [^272^][^328^].
- **Alternative**: `getsentry/codecov-action` is a self-hosted option using GitHub Artifacts, requiring no external Codecov token [^270^].
- **CI workflow pattern**: Run tests with coverage -> upload artifacts -> report action posts PR comment with comparison to main branch -> branch protection rules enforce thresholds [^216^].

---

## Major Players & Sources

| Entity | Role / Relevance |
|--------|-----------------|
| **Vitest** | Next-gen testing framework powered by Vite; de facto for Vue 3 projects [^287^] |
| **@vue/test-utils** | Official Vue testing library; provides `mount()`, `shallowMount()`, component wrappers [^305^] |
| **Supertest** | HTTP assertion library for API integration testing with Express/Fastify [^259^][^265^] |
| **Fastify** | High-performance Node.js framework; `fastify.inject` enables fast integration tests [^321^] |
| **Playwright** | Microsoft's E2E testing framework; leader in 2026 with cross-browser support [^261^] |
| **Cypress** | E2E framework with superior developer experience; trailing in adoption vs Playwright [^261^] |
| **DOMPurify** | DOM-based XSS sanitizer; gold standard for client-side HTML sanitization [^283^] |
| **sanitize-html** | Server-side HTML sanitizer with configurable allowlists; preferred for bulk processing [^323^] |
| **Nodemailer** | The Node.js email sending library; ecosystem includes mailparser, ethereal.email [^297^][^300^] |
| **ImapFlow** | Modern IMAP client for Node.js; used to fetch emails in testing workflows [^300^] |
| **mailparser** | Nodemailer's MIME parser; `simpleParser()` for converting raw email to structured data [^300^] |
| **nodemailer-mock** | Drop-in Nodemailer mock for unit testing email sending without real transport [^297^] |
| **Mokapi** | Mock SMTP/IMAP server with dashboard; CI-friendly declarative configuration [^329^][^274^] |
| **MailSlurp** | Programmable disposable inboxes for automated email testing [^324^] |
| **Testcontainers** | Docker container management for integration testing; official Redis and MongoDB modules [^267^][^301^] |
| **mongodb-memory-server** | In-memory MongoDB for fast unit testing; has limitations with advanced features [^275^] |
| **Nock** | HTTP interceptor for mocking external API calls in tests [^265^] |
| **Ethereal.email** | Fake SMTP/IMAP service by Nodemailer author; real protocol testing without real delivery [^300^] |
| **vitest-coverage-report-action** | GitHub Action for posting Vitest coverage reports as PR comments [^216^][^328^] |

---

## Trends & Signals

- **Playwright dominance in E2E**: By early 2026, Playwright has overtaken Cypress in npm downloads, GitHub stars, and job postings. Its true parallelism, multi-browser support, and `APIRequestContext` make it ideal for hybrid email testing [^261^][^260^].
- **Framework-native API testing**: The shift from supertest to `fastify.inject` (and similar native tools) is accelerating, offering 2-5x speed improvements by bypassing the HTTP/TCP layer entirely [^321^].
- **Testcontainers replacing in-memory databases**: For MongoDB, Testcontainers is becoming the default over `mongodb-memory-server` due to full feature support (transactions, change streams, real aggregation behavior) [^301^].
- **Real-over-mock philosophy for email testing**: Industry consensus is moving toward testing email with real SMTP delivery (disposable inboxes) rather than mocking `sendEmail()`. Real inbox testing catches template failures, broken links, expired credentials, and SPF/DKIM issues that mocks miss [^320^].
- **DOMPurify server-side with jsdom**: The recommended server-side pattern uses `jsdom` as the DOM implementation for DOMPurify. `happy-dom` is explicitly not considered safe for this use case [^283^].
- **Zero-cost CI coverage reporting**: Tools like `vitest-coverage-report-action` enable PR-based coverage reporting without commercial services (SonarQube/SonarCloud), making quality gates accessible to open-source projects [^216^].
- **Composable testing patterns for Vue 3**: The community has established clear patterns (`withSetup`, `useInjectedSetup`) for testing Composition API code, moving away from the simpler Options API testing model [^298^][^296^].

---

## Controversies & Conflicting Claims

- **Supertest vs. framework-native inject**: While some best practices guides recommend pure HTTP clients (axios) over supertest to avoid framework coupling [^265^], others continue recommending supertest for its developer familiarity and cookie-persistent agents [^321^]. For Fastify specifically, `inject()` is now considered the idiomatic choice [^321^].
- **Mocking vs. real dependencies in integration tests**: The Node.js testing best practices repo advocates mocking external HTTP calls with Nock [^265^], while the Testcontainers community argues for real services: "Mocking is fast but typically limited by a developer's understanding of the underlying technology. Incorrect assumptions can lead to unforeseen errors in production" [^271^]. The pragmatic balance: mock for fast feedback, testcontainers for critical path validation.
- **DOMPurify vs. sanitize-html for server-side**: DOMPurify proponents argue DOM-based parsing catches edge cases that regex-based sanitizers miss [^323^]. sanitize-html advocates point to better performance for bulk processing and `allowedStyles` granularity [^323^]. Consensus: use DOMPurify client-side, sanitize-html server-side for rich text.
- **Cypress vs. Playwright for E2E**: While Playwright leads in raw metrics, Cypress retains a loyal following due to its interactive test runner, time-travel debugging, and gentler learning curve [^261^]. For email E2E testing specifically, both can work with fake SMTP APIs; Playwright's `APIRequestContext` gives it an edge for hybrid API+UI flows [^260^].
- **mongodb-memory-server vs. Testcontainers**: mongodb-memory-server is faster (in-process) but incomplete (no change streams, limited transactions). Testcontainers is slower to start but provides real MongoDB behavior [^301^]. The choice depends on whether you're testing basic CRUD or advanced MongoDB features.
- **How many E2E tests?**: Industry recommendations converge on the testing pyramid (70% unit / 20% integration / 10% E2E) [^295^], with total E2E tests kept under 20-30, covering only critical user journeys [^293^]. Some teams argue for even fewer E2E tests, moving coverage to integration tests for faster feedback [^293^].

---

## Recommended Deep-Dive Areas

| Area | Why It Deserves Depth |
|------|----------------------|
| **Mock IMAP server for Node.js** | No mature equivalent to Java's GreenMail exists for Node.js. Mokapi is promising but less established. A custom IMAP mock or Docker-based mail server (Dovecot in Testcontainers) may be needed for comprehensive IMAP client testing. |
| **Email sanitization regression suite** | Given CVE-2025-15599 and the history of DOMPurify bypasses, a dedicated test suite with known XSS payload fixtures (OWASP, CVE-specific) should be maintained. Test both DOMPurify output and the rendered result in browser-like environments. |
| **MIME parsing edge cases** | Real-world email is notoriously messy. A fixture library covering malformed MIME, exotic encodings (RFC 2047, RFC 2231), oversized attachments, and nested multipart structures would improve robustness of email parsing tests significantly. |
| **Composable testing patterns for email Vue components** | Email-specific Vue components (composer, viewer, attachment list) need testing patterns that cover: rich text editor integration, file attachment handling, DOMPurify integration in component lifecycle, and async email loading states. |
| **Fastify email API integration testing** | Testing email send/receive endpoints with Supertest/Fastify.inject requires patterns for: multipart form data (attachments), JWT auth middleware, request validation (schemas), and async background job triggering. |
| **E2E email flow testing with Playwright** | Deep-dive into: Playwright fixtures for disposable inboxes, parallel test isolation (each test gets own inbox), email content assertions (HTML rendering verification), link extraction and navigation, and CI/CD integration with API keys. |
| **Testcontainers for mail server dependencies** | Using Testcontainers to spin up real Dovecot/Postfix containers for integration testing would provide the highest-confidence IMAP/SMTP testing. Research containerized mail server images and their API compatibility. |
| **Coverage-gated CI pipeline** | Implementing the full pipeline: Vitest coverage thresholds -> GitHub Actions workflow -> PR comments with coverage diff -> branch protection rules blocking merges below threshold. The `vitest-coverage-report-action` v2 has extensive configuration options. |
