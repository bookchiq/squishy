---
title: Serving a subfolder on GitHub Pages, and redeploying after a GITHUB_TOKEN commit
date: 2026-08-19
category: tooling-decisions
module: deployment
problem_type: tooling_decision
component: infrastructure
severity: high
applies_when:
  - "GitHub Pages must publish a subfolder (e.g. public/) rather than / or /docs"
  - "A scheduled job commits generated content that should redeploy the site"
tags: [github-pages, github-actions, workflow-run, github-token, ci-cd, static-site]
---

# Serving a subfolder on GitHub Pages, and redeploying after a GITHUB_TOKEN commit

## Context

squishy's deployable site lives in `public/`, and a scheduled Action regenerates
`public/videos.json` and commits it back so the site refreshes daily. Two GitHub
Pages behaviors made the "obvious" setup silently fail to deploy.

## Guidance

**1. "Deploy from a branch" can only serve `/` or `/docs` — nothing else.** The
folder dropdown offers exactly those two options; there is no way to point it at
an arbitrary `public/`. To publish any other directory, switch **Settings → Pages
→ Source → GitHub Actions** and deploy the folder as a Pages artifact:

```yaml
# .github/workflows/deploy-pages.yml
permissions:
  pages: write
  id-token: write
steps:
  - uses: actions/checkout@v4
  - uses: actions/configure-pages@v5
  - uses: actions/upload-pages-artifact@v3
    with:
      path: public          # <-- any directory
  - uses: actions/deploy-pages@v4
```

**2. A commit pushed with the built-in `GITHUB_TOKEN` does NOT trigger
`on: push` (or `on: pull_request`) workflows.** This is a deliberate GitHub guard
against recursive runs. So a scheduled job that commits `videos.json` cannot
trigger the Pages deploy via `on: push`. Chain the deploy to the *content*
workflow's completion instead:

```yaml
on:
  push:
    branches: [main]              # code changes (human pushes) still deploy
  workflow_run:
    workflows: ['Refresh feed']   # the content job's `name:`
    types: [completed]
  workflow_dispatch: {}
jobs:
  deploy:
    if: ${{ github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success' }}
```

`workflow_run` fires on another workflow finishing regardless of what triggered
it, so it is not subject to the `GITHUB_TOKEN` guard.

## Why This Matters

Both failures are silent: the site just serves stale content, green checkmarks
everywhere. In this project it also compounded with a merge-timing trap — the
`deploy-pages.yml` workflow was merged a beat *after* the PR that was supposed to
include it, so it was not even on `main` when the first deploy should have run
(see `vote-worker` and Pages PRs). Always confirm the deploy workflow is on the
default branch and that a run actually appears under Actions.

## When to Apply

- Any GitHub Pages site whose content is not at the repo root or `/docs`.
- Any Pages site whose content is regenerated and committed by a scheduled or
  bot-token workflow.

## Examples

- Verify a deploy actually happened, don't assume:
  `gh run list --workflow deploy-pages.yml --limit 1 --json status,conclusion,event`
- Confirm the workflow reached `main` after a merge:
  `git cat-file -e origin/main:.github/workflows/deploy-pages.yml && echo present`

## Related

- `.github/workflows/deploy-pages.yml`, `.github/workflows/refresh-feed.yml`
- Alternative: hosts like Netlify / Cloudflare Pages let you set the publish
  directory directly, sidestepping the deploy-from-branch limitation.
