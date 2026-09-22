# Security Policy

## Supported versions

Dejavue is developed on `main`, and the hosted instance at [dejavue.app](https://dejavue.app) always
runs the latest commit. Security fixes land on `main`; there are no maintained release branches.

If you self-host, pull `main` to get fixes.

## Reporting a vulnerability

**Please don't open a public issue for a security problem.**

Report it privately in either of these ways:

- **GitHub** — open a
  [private security advisory](https://github.com/lkaesberg/Dejavue/security/advisories/new)
  (preferred; it keeps the discussion attached to the repo)
- **Email** — [contact@wksolutions.de](mailto:contact@wksolutions.de)

Please include:

- what the issue is and roughly how severe you think it is
- steps to reproduce, or a proof of concept
- whether it affects the hosted instance, self-hosted instances, or both

You'll get an acknowledgement within a few days. Since Dejavue is maintained by one person in their
spare time, please allow reasonable time for a fix before disclosing publicly. Credit in the advisory
is yours if you want it.

## Things that are especially worth reporting

Given what Dejavue does, these areas matter most:

- **Cross-tenant data leaks** — one server's knowledge base content reachable from another's
  subdomain, custom domain, search, or MCP endpoint
- **Publishing bypasses** — content appearing on a public page for a server that never opted in
- **De-anonymization** — a way to recover Discord usernames, display names or avatars from published
  pages, where only aliases should appear
- **Passphrase bypasses** on private knowledge bases, including the unlock cookie
- **Permission bypasses** in the bot — resolving or editing a thread without being the OP, a
  moderator or an admin
- **Entitlement bypasses** — unlocking a paid tier or spending another server's AI credits
- **Prompt injection** that makes the AI features leak data across servers or exfiltrate secrets
- Anything reachable **without authentication** on the web app or the MCP endpoint

## Out of scope

- Missing rate limits on endpoints that are already rate-limited upstream
- Reports generated solely by automated scanners with no demonstrated impact
- Vulnerabilities in Discord itself, or in a third-party service (report those to that vendor)
- Anything requiring a compromised server administrator account — an admin can already publish their
  own server's content

## A note on self-hosting

Self-hosted instances are your own responsibility: keep `.env` out of version control, put the web
app behind TLS, and don't expose Postgres to the internet. The bundled `docker-compose.yml` uses a
well-known development password for Postgres — change it before running it anywhere real.
