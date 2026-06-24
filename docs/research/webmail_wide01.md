## Facet: Webmail Open Source Landscape 2026

*Research conducted June 2026. All citations refer to web sources numbered by search results.*

---

### Key Findings

- **Roundcube remains the dominant open-source webmail client** by deployment count, with 7,100+ GitHub stars, 1,800 forks, 13,681 commits, and 294 contributors. It is estimated to be "58 times more popular than SnappyMail by deployment count" and is used by "thousands of hosting providers worldwide" [^62^][^126^]. In November 2023, Nextcloud acquired Roundcube, pledging to "invest in Roundcube, accelerate development and work with its community" [^310^].

- **Roundcube 1.7.0 was released on May 10, 2026** after "almost four years of development," introducing breaking changes (dropped PHP <8.1, IE, MS SQL/Oracle), mandatory `public_html/` entry-point, improved OAuth2/OIDC, Markdown mail rendering, quick actions menu, and advanced search syntax. The 1.6.x branch moved to LTS mode [^108^][^113^].

- **Roundcube faces persistent XSS vulnerabilities** as a systemic issue. CVE-2026-35539 (CVSS 6.1, March 2026) allowed XSS via insufficient HTML attachment sanitization in preview mode [^57^][^81^][^338^]. Multiple additional CVEs were patched in early 2026 including CVE-2026-48842 (SQL injection, CVSS 8.1), CVE-2026-48844 (code injection, CVSS 7.5), and CVE-2026-48848 (CSS injection via SVG, CVSS 7.2) [^56^][^340^]. A SonarSource analysis from 2024 called this a pattern: "A critical cross-site scripting vulnerability in Roundcube webmail allows attackers to execute malicious JavaScript in a victim's browser simply by sending them a crafted email" [^68^].

- **SnappyMail is the most recommended modern alternative** to Roundcube. It is a fork of RainLoop with 1,600 GitHub stars, 205 forks, and 7,184 commits. It claims "mobile booting with ~138 KB download (using Brotli) and up to 99% performance grade by Lighthouse" [^67^][^91^]. A direct comparison states SnappyMail "renders email significantly faster than Roundcube, uses less RAM, and has a cleaner default UI. PGP encryption is built in with no plugins needed" [^62^].

- **SnappyMail's development status is ambiguous.** The latest release is v2.38.2 from October 9, 2024, and there were no commits in early 2025, prompting a GitHub issue (#1911) asking "Is the project dead?" [^98^]. The maintainer responded that the project is not dead, and commits resumed with the latest on March 12, 2026 [^127^]. However, this slowdown raises concerns about long-term maintenance.

- **RainLoop is effectively abandoned.** Multiple sources confirm "RainLoop was abandoned a couple of years ago" and that SnappyMail "solves several security issues" [^85^]. The WikiSuite comparison page lists RainLoop as excluded due to "activity level is too low" [^71^].

- **Cypht is the most technically innovative contender**, being the first/only actively maintained open-source webmail client with native JMAP support [^84^]. It has 1,600 GitHub stars, 217 forks, 7,423 commits, and 92 contributors. The latest release v2.10.1 came out on June 17, 2026, with the last commit 16 hours ago at time of research, indicating very active development [^244^]. As of August 2025, Cypht surpassed SnappyMail as "the most active of the last 12 months" in code commits [^71^].

- **Bulwark represents the next-generation approach**, built from scratch in TypeScript/Next.js 16 with Tailwind CSS v4, speaking JMAP natively to Stalwart Mail Server. It bundles mail, calendar, contacts, and files with a web-based setup wizard, OAuth2/OIDC SSO, PWA support, and dark/light themes [^92^][^337^]. Its GitHub org (`bulwarkmail`) has the webmail repository actively maintained with releases through June 2026 [^336^][^337^].

- **AfterLogic WebMail Lite 8** has 359 GitHub stars, 75 forks, and 594 commits. The project is AGPL-licensed and actively maintained (latest commit June 17, 2026), though its GitHub releases lag (last tagged release 8.5.2 from October 2020) [^250^]. It offers a dual-licensing model (AGPL or commercial).

- **Nextcloud Mail remains a secondary option** for users already in the Nextcloud ecosystem. A February 2026 GitHub issue highlights serious limitations: "large inbox usability degrades quickly," composer UX is "restrictive," and PGP workflows are "unreliable" [^245^]. Nextcloud offers SnappyMail and Roundcube as alternative mail apps [^258^][^313^].

- **Mailpile is effectively halted.** The GitHub README states "Development on this codebase has halted, until the Python3 rewrite has completed" [^94^]. The last release was 1.0.0rc6 over a year ago, though the lead developer reportedly returned to work on the project at "60-80% full time capacity" in summer 2023 [^87^].

- **JMAP adoption remains the key protocol differentiator for 2026.** Cypht is the pioneer among PHP-based webmail clients. Bulwark is the first major JMAP-native webmail built on modern web stack (Next.js/TypeScript). Stalwart Mail Server plans to build its own webmail SPA using Rust and Dioxus framework post-v1.0, "most likely sometime in 2026" [^95^].

---

### Major Players & Sources

| Entity | Role / Relevance | GitHub Stars | Latest Version | License |
|--------|-----------------|--------------|----------------|---------|
| **Roundcube** | The incumbent; most deployed self-hosted webmail; acquired by Nextcloud (2023) | 7.1k [^126^] | 1.7.1 (May 2026) [^113^] | GPLv3+ |
| **SnappyMail** | Modern RainLoop fork; fastest/lightweight alternative | 1.6k [^127^] | v2.38.2 (Oct 2024) [^127^] | AGPL-3.0 |
| **Cypht** | Lightweight aggregator; first JMAP-supporting webmail; very active dev | 1.6k [^244^] | v2.10.1 (Jun 2026) [^244^] | LGPL-2.1 |
| **Bulwark** | Next-gen JMAP-native webmail; TypeScript/Next.js; pairs with Stalwart | ~660 [^92^] | 1.6.4 (Jun 2026) [^337^] | AGPL-3.0 |
| **AfterLogic WebMail Lite 8** | Commercial-friendly dual-license option | 359 [^250^] | 9.8.5 (Jun 2026)* [^250^] | AGPL-3.0 |
| **RainLoop** | Original project; effectively abandoned | N/A (deprecated) | N/A | AGPL-3.0 |
| **Nextcloud Mail** | Integrated option for Nextcloud users; not standalone | N/A (NC app) | N/A | AGPL-3.0 |
| **SOGo** | Full groupware suite; not standalone webmail | N/A | N/A | GPL |
| **Mailpile** | Privacy-focused; development halted for Python 3 rewrite | ~3k [^94^] | 1.0.0rc6 (stale) [^87^] | AGPL-3.0 |
| **Stalwart Mail Server** | Mail server (not webmail); building native webmail for 2026 | N/A | v0.16.10 (Jun 2026) [^110^] | AGPL-3.0 |

*AfterLogic's GitHub releases show 8.5.2 (Oct 2020) but commits continue to v9.8.5.

---

### Trends & Signals

- **Consolidation around Nextcloud:** Since acquiring Roundcube in November 2023, Nextcloud has positioned Roundcube as "the most popular on-premises webmail" and offers enterprise subscriptions bundling Roundcube + Stalwart/Dovecot + Mailvelope [^310^][^311^]. This creates a "Nextcloud + Roundcube" stack competing with all-in-one alternatives.

- **JMAP as the emerging protocol differentiator:** The 2019 JMAP standardization (RFC 8620) is finally translating into client adoption in 2026. Cypht pioneered JMAP support; Bulwark is the first built JMAP-native from the ground up; Stalwart plans its own JMAP webmail [^84^][^92^][^95^]. IMAP remains dominant but JMAP offers "push, not polling" and "one round-trip per click" [^92^].

- **Performance becoming a key decision factor:** SnappyMail's Lighthouse 99% performance grade and 138KB mobile boot highlight a shift away from heavy PHP frameworks [^67^]. Bulwark's TypeScript/Next.js stack represents the modern approach to webmail performance [^337^].

- **Security scrutiny intensifying on Roundcube:** The sheer volume of 2026 CVEs (15+ patched) suggests Roundcube's PHP codebase and HTML sanitization pipeline face structural security challenges. SonarSource's 2024 report noted government emails were at risk due to Roundcube XSS [^68^].

- **UI/UX modernization as competitive moat:** Roundcube's Elastic skin (introduced 2020) still receives user complaints about being "hard to read," lacking column customization, and wasting screen space with the three-pane layout [^40^][^96^]. SnappyMail, Bulwark, and Cypht all differentiate on cleaner, more modern UIs [^62^][^92^].

- **Shift from PHP to modern JavaScript/TypeScript stacks:** Bulwark (Next.js/TypeScript) represents the vanguard of a potential technology transition in webmail, similar to what happened in other web application categories. Roundcube, SnappyMail, and Cypht remain PHP-based [^337^].

---

### Controversies & Conflicting Claims

- **Is SnappyMail actively maintained or dying?** The project went without commits in early 2025, prompting issue #1911 "Is the project dead?" [^98^]. While the maintainer denied this and commits resumed in late 2025/early 2026, the 8-month gap between v2.38.2 (Oct 2024) and any visible activity, combined with 150 open issues and 28 pending PRs, suggests a bus factor risk [^127^]. Contrast with Cypht's consistent activity and 92 contributors.

- **Roundcube's security track record:** Despite Nextcloud's investment and regular security patches, Roundcube accumulated 15+ CVEs in the first half of 2026 alone, many being XSS variants [^56^][^340^]. Critics argue this is a fundamental architecture issue with PHP-based HTML sanitization; defenders note that Roundcube's massive deployment base makes it a higher-value target, and patches are prompt.

- **Nextcloud Mail vs Roundcube within Nextcloud:** After acquiring Roundcube, Nextcloud stated "there are no short-term plans for merging" and "Roundcube will not replace Nextcloud Mail" [^312^]. Yet the Nextcloud app store offers both SnappyMail and a Roundcube integration app [^258^][^316^], creating confusion about recommended paths. A 2023 forum post noted: "So now we have the choice between three email clients" [^258^].

- **JMAP: real innovation or ecosystem lock-in?** Bulwark only works with JMAP servers (primarily Stalwart), requiring either a Stalwart deployment or their legacy IMAP/SMTP proxy [^92^]. This creates a stack dependency. Conversely, Cypht supports JMAP, IMAP, SMTP, POP3, and EWS simultaneously, offering more flexibility [^244^].

- **Cypht's "Bootstrap 1.0" aesthetics vs functional design:** A Cloudron forum user noted "most open source webmail apps work and look like mid-2000s crap" and that "Cypht looks like something out of Bootstrap 1.0" [^39^]. Others praise its functional minimalism and combined inbox approach. The project has been improving its UI steadily.

---

### Recommended Deep-Dive Areas

1. **Bulwark's adoption trajectory:** As the only JMAP-native, TypeScript/Next.js webmail client, Bulwark represents a potential paradigm shift. Worth tracking: GitHub star growth, Stalwart co-installation rates, plugin ecosystem development, and whether it expands beyond Stalwart-only support.

2. **Roundcube 1.7 enterprise adoption under Nextcloud:** The 1.7 release is a major milestone. Deep-diving into hosting provider migration timelines, Nextcloud integration app usage, and whether the Nextcloud investment translates to faster feature delivery or just security maintenance would be valuable.

3. **JMAP ecosystem maturation:** With Cypht, Bulwark, and Stalwart's future webmail all betting on JMAP, tracking JMAP server adoption (Stalwart, Cyrus, Fastmail), client library availability, and whether Thunderbird/major clients add JMAP support is critical for predicting 2027-2028 landscape shifts.

4. **SnappyMail's sustainability:** Given the maintenance gap and single-maintainer risk (the-djmaze), assessing whether the project receives enough sponsorship, whether community contributions are being merged promptly, and whether hosting providers are migrating to or from SnappyMail.

5. **Security comparison across sanitization engines:** Roundcube's XSS issues stem from its HTML/CSS sanitization pipeline. A detailed technical comparison of how Roundcube, SnappyMail, Cypht, and Bulwark handle HTML email rendering, SVG filtering, CSS sanitization, and CSP policies would reveal structural security differences.

6. **Cypht's community governance transition:** Cypht moved from a single maintainer (jasonmunro) to a cypht-org with monthly community meetings and 92 contributors. Understanding whether this governance model sustains its current velocity could reveal a template for other projects.

---

### GitHub Activity Summary (as of June 2026)

| Project | Stars | Forks | Commits | Contributors | Last Commit | Latest Release |
|---------|-------|-------|---------|--------------|-------------|----------------|
| roundcube/roundcubemail | 7.1k | 1.8k | 13,681 | 294 | 8 hours ago | 1.7.1 (May 24, 2026) |
| the-djmaze/snappymail | 1.6k | 205 | 7,184 | ~1 | 3 months ago | v2.38.2 (Oct 9, 2024) |
| cypht-org/cypht | 1.6k | 217 | 7,423 | 92 | 16 hours ago | v2.10.1 (Jun 17, 2026) |
| afterlogic/webmail-lite-8 | 359 | 75 | 594 | 8 | 1 week ago | 8.5.2 (Oct 14, 2020)* |
| bulwarkmail/webmail | ~660** | N/A | N/A | N/A | 10 hours ago | 1.6.4 (Jun 2026) |

*AfterLogic commits continue but GitHub releases are not consistently tagged.
**Approximate from bulwarkmail.org website; GitHub org-level star count not directly available.

---

*Research compiled from 25+ web sources, 4 GitHub repository verifications, CVE databases, and official project documentation. All citations use source numbering from search results.*
