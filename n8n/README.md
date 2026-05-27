# n8n SEO Trigger

Ersetzt den GitHub Actions Cron-Trigger durch n8n.
Die Pipeline selbst läuft weiterhin als GitHub Actions Workflow (`seo.yml` → `seo-reusable.yml`).

## Problem

GitHub Actions deaktiviert Cron-Jobs auf Repos ohne kürzliche Aktivität.
n8n löst das durch einen externen `workflow_dispatch` Trigger.

## Repos

| Node | Repo | Workflow |
|------|------|----------|
| Trigger portfolio-2025 | `raaaf/portfolio-2025` | `seo.yml` |
| Trigger events | `rafaelalex-dev/events` | `seo.yml` |
| Trigger zeit | `rafaelalex-dev/zeit` | `seo.yml` |

## Setup

### 1. GitHub Token Credential in n8n anlegen

- Typ: HTTP Header Auth
- Header Name: `Authorization`
- Header Value: `Bearer <github-token-mit-repo-scope>`
- Der Token braucht Zugriff auf alle drei Repos/Orgs

### 2. Workflow importieren

1. n8n UI > Menu > Import from File > `seo-trigger.json`
2. In allen drei HTTP-Nodes die GitHub Token Credential zuweisen
3. Workflow aktivieren

### 3. Testen

Manual Execute im n8n UI. Erfolg = drei HTTP 204 (No Content).
Danach in GitHub Actions prüfen ob die Workflows gestartet wurden.

## Wie es funktioniert

```
n8n Schedule (Mi 09:00 UTC)
    |
    +---> POST /repos/raaaf/portfolio-2025/actions/workflows/seo.yml/dispatches
    +---> POST /repos/rafaelalex-dev/events/actions/workflows/seo.yml/dispatches
    +---> POST /repos/rafaelalex-dev/zeit/actions/workflows/seo.yml/dispatches
    |
    v
GitHub Actions: seo.yml → seo-reusable.yml (pro Repo)
    |
    v
Discover → Generate → Validate → PR → Track
```

4 Nodes. Kein Secret außer dem GitHub Token.
