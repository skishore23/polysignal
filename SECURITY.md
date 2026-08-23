# Security Policy

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities, exposed credentials, authentication bypasses, unsafe execution paths, or infrastructure disclosures.

Use GitHub private vulnerability reporting for this repository:

https://github.com/skishore23/polysignal/security/advisories/new

Include affected paths, reproduction steps, impact, and any suggested mitigation. Please avoid accessing data or systems that are not yours.

## Supported version

Security fixes target the current `main` branch. This is pre-1.0 research software; older commits and deployments are not supported.

## Deployment boundary

The worker is currently hard-wired to paper execution. The repository still contains dormant CLOB execution adapters, so changes around execution-mode configuration require heightened review.

For web deployments:

- Set `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` to protect the whole dashboard.
- Keep `.env`, SQLite databases, private keys, and logs outside version control.
- Terminate TLS at a trusted reverse proxy.
- Restrict SSH ingress and rotate any credential that may have appeared in logs.
- Do not expose a production deployment with mutating API routes enabled and no authentication.
