# WireViz GUI — TODO

Visual editor for [WireViz](https://github.com/wireviz/WireViz) wiring diagrams.
Architecture and research: see `RESEARCH.md`.

## Routines

- [x] r001 wireviz-gui site health check repeat:cron(*/15 * * * *) ~10s run:custom/scripts/wireviz-gui-health.sh
- [x] r002 wireviz-gui daily e2e regression repeat:cron(30 5 * * *) ~3m run:custom/scripts/wireviz-gui-e2e.sh

Routine notes:

- Scripts are versioned in `ops/` (this repo); `~/.aidevops/agents/custom/scripts/wireviz-gui-*.sh`
  are stable pointer wrappers that exec the worktree copies.
- `WIREVIZ_GUI_URL` overrides the default deployed URL
  (`https://schneiderwastaken.github.io/wireviz-gui/`).
- Logs: `~/.aidevops/.agent-workspace/work/wireviz-gui/{health.log,e2e-cron.log,e2e-last.log}`.
- The e2e routine skips cleanly (exit 0) while the site is not deployed yet.

## Next

- [x] Deploy: repo created, `v0` pushed to `main`, GitHub Pages enabled — live at https://schneiderwastaken.github.io/wireviz-gui/
- [x] After deploy: health check OK (all assets 200); e2e routine green against the live site (24/24)
- [ ] Phase 3 candidates: self-hosted Pyodide for full offline use, per-pin wire labels, splice auto-insert between cable ends
