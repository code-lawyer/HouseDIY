# Changelog

## 0.1.7-rc.4 — 2026-11-24 (Windows prerelease)

- Store imported images as separate workspace attachments so ordinary edits do not rewrite the image bytes. Back up the entire workspace before opening projects with this version. To return to rc.3, restore the pre-upgrade backup.
- Keep completed chat turns together, retain the detected CLI status when saving its settings, and accept design JSON surrounded by explanatory text.
- Preserve wall identities when dropping tiny split segments. Scope the editor's script nonce to its inline scripts and keep it out of offline exports.

## 0.1.7-rc.3 — 2026-11-22 (Windows prerelease)

- Connect through an existing local Codex, Claude Code or Gemini CLI login, or use an OpenAI-compatible API. Remote API URLs require HTTPS. Loopback HTTP remains available.
- Preserve the imported floor-plan file locally and let the user download it. Recognition receives a resized copy.
- Keep the first usable walls, openings and scale when retrying furniture layouts. Mark doors and windows whose detected wall is too far away. Count physically distinct furnished layouts.
- Keep wall protection and notices in standalone HTML and limit it to assets used by the shared plan. Store reusable shapes in the workspace.
- Present the PDF drawing as a draft, label room area as approximate and use the dimension lines for measured lengths.
- Add confirmed permanent deletion and empty-trash actions. Preserve shared GLB files and report incomplete project deletions.
- Update Electron, remove privileged debugging features from the portable build and attach the tested EXE hash to Windows CI.

## 0.1.7-rc.2 — 2026-11-21 (Windows prerelease)

- Save the imported reference image before recognition. The same project opens for tracing or another recognition attempt when the provider stops or returns no usable walls.
- Build valid walls, openings and furniture independently. Mark unresolved openings on the drawing so the user can choose a wall, check the dimensions and place or undo the opening.
- Keep editable 3D drafts with design conflicts. Merge matching findings in the editor and apply explicitly registered blocking rules to new or worsened AI edits.

## 0.1.7-rc.1 — 2026-11-18 (local Windows release candidate)

- Calibrate floor-plan images to the supplied span between the outer wall centerlines. Require the requested number of physically distinct layouts and explain scale disagreements.
- Protect structural walls of unknown status, their openings and shared endpoints. Screen low furniture in door paths and narrow passages, and reduce repeated geometry work on large plans.
- Keep custom GLB assets across restarts. Include referenced assets in single-plan JSON, and support restoring missing or damaged originals. Isolate invalid projects with a file-specific diagnostic while the rest of the library stays usable.
- Export standalone share files with the current calibrated underlay and referenced models. Chrome and Edge can open and navigate these files offline.
- Load home previews in a single request. Keep the project name visible on common laptop screens and give the drawing, panels and tools dedicated space in 2D and split views.
- Verify two real Codex tasks on synthetic or public inputs, the Windows portable build, browser interactions, model recovery and drawing exports. See the [release assessment](docs/releases/0.1.7-rc.1-local.md) for scope and outstanding stable-release checks.

## 0.1.6 — 2026-11-17 (local build)

- Review AI edits on a candidate plan before applying or saving: screen oversized ordinary doors, inaccessible or unexplained enclosed rooms, blocked door approaches, misplaced tall storage, collisions and implausibly small appliances. Both model adapters receive correction feedback.
- Persist an explicit project layout lock and an opt-in for freestanding tall storage. Preserve site notes, services, structural objects and furniture configuration in AI context; retain recognized door handing and flag unknown handing.
- Add project deletion to a local recycle bin and restoration of all variants, conversations, history and embedded source data. Cancel active project requests and reject stale writes after deletion or restoration. Clearing the project library no longer recreates the demo on restart.
- Add deterministic rule tests, provider correction tests, lifecycle race coverage and an isolated browser acceptance suite (`npm run test:first-fixes`).

Rules are conservative product checks, not construction-code certification. Room analysis uses a bounded raster, original missing-site information remains unresolved, and the upstream editor's broader checks remain available. No public release has been published by this change.

## 0.1.5 — 2026-11-16

Warm atelier interface and review fixes for the Windows x64 portable build.

- Cream and sage design tokens, Chinese typography and bundled offline icons/fonts across the home, editor and settings.
- Compact tool rail and contextual panels that retain the original editor's tools.
- Furniture color swatches with saving, undo and protection against stale selections; clicking the current color no longer creates a false modification record.
- Independently scrolling conversation content keeps the composer visible with furniture colors, structural confirmations and multiline input.
- Larger small-screen status text and expanded behavior coverage for the new controls and crowded layouts.

The Windows portable executable is unsigned.

## 0.1.4 — 2026-11-16

First public HouseDIY preview, renamed from the local MyHouse prototype.

- HouseDIY branding in the desktop window, interface, assistant and executable.
- Existing MyHouse workspaces remain usable in place; no automatic copying or merging.
- Original 2D/3D editor with in-app conversational furniture and wall changes.
- Codex CLI account integration and configurable OpenAI-compatible model APIs.
- Floor-plan image recognition, multiple editable variants, local saving, undo and JSON export.
- Public synthetic example, portable verification scripts, contributor guidance and Windows/Linux test CI.
- Documented upstream attribution, bundled license texts and the remaining incomplete dependency inventory.

The Windows portable executable is unsigned. This 0.1.x release is a preview; image recognition produces a design draft and needs dimensional review.

## Earlier local iterations

0.1.1–0.1.3 fixed queued saving, stale AI results, wall demolition semantics, transparent image conversion, startup styling and build dependency vulnerabilities. These iterations were local MyHouse builds, not prior HouseDIY GitHub releases.
