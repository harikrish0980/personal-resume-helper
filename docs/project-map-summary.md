# Project Map Summary

Generated with `graphifyy` in Codex/local mode on `career-ops-web/`.

The full generated graph is intentionally local-only and ignored by Git:

- `career-ops-web/graphify-out/graph.html`
- `career-ops-web/graphify-out/graph.json`
- `career-ops-web/graphify-out/GRAPH_REPORT.md`

The run used local AST/code extraction only:

- Files mapped: 9
- Nodes: 475
- Edges: 1080
- Communities: 28
- External LLM token cost: 0

## Core Hubs

Graphify identified these as the most connected project nodes:

1. `handleApi()`
2. `updateState()`
3. `runCareerOpsAnalysis()`
4. `normalizedText()`
5. `cleanDisplayText()`
6. `scoreJob()`
7. `loadAll()`
8. `renderResumeHtml()`
9. `renderOnePageResumeHtml()`
10. `normalizeJob()`

## Useful Architecture Areas

- API routing and state transitions live mostly in `server.mjs`.
- Discovery scoring, source fetching, dedupe, and matching live in `lib/discovery.mjs`.
- Resume generation, one-page/two-page rendering, ATS extraction, and Resume QA live in `lib/careerOpsAdapter.mjs`.
- Local JSON state normalization and atomic writes live in `lib/store.mjs`.
- Frontend route rendering and user actions live in `public/app.js`.
- Optional ScrapeGraph sidecar normalization lives in `tools/scrapegraph_discovery.py`.

## How To Regenerate

From `D:\Easy job apply\career-ops-web`:

```powershell
graphify update . --force
```

If `graphify` is not on PATH, call the installed executable directly:

```powershell
& "$env:LOCALAPPDATA\Packages\PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0\LocalCache\local-packages\Python311\Scripts\graphify.exe" update . --force
```

Keep Graphify runs scoped to `career-ops-web/` unless intentionally mapping private Career-Ops content.
