# Third-party notices

## house-plan-designer

- Upstream: https://github.com/ZWD11/house-plan-designer
- Revision: `dd5a61070ea0a251fb13a141cd9a282be36fd292`
- License: MIT; full original notice is in `vendor/HOUSE-PLAN-DESIGNER-LICENSE`.
- `vendor/designer.html` is an unmodified copy of upstream `assets/template.html`.
- `vendor/catalog.json` contains catalog defaults extracted from that editor.
- At runtime HouseDIY enables the editor's debug bridge, bypasses its browser
  plan cache in favor of the desktop project store, injects the current project,
  and adds `public/editor-bridge.js`. The underlying 2D/3D editor,
  furniture renderers, manual tools and check engine belong to the upstream
  project. They are not claimed as original HouseDIY work.

The new Electron shell, project storage, model adapters, conversational editing
and image-to-plan conversion are HouseDIY code. Aedifex, OpenPlan3D, Nestform and
New Era were evaluated as references; no source from those projects is included.

## Bundled rendering dependencies

The embedded editor identifies Three.js r160 (0.160.0). Its own README also
identifies three-bvh-csg and three-gpu-pathtracer; the bundle contains MeshBVH
implementation and diagnostic strings from three-mesh-bvh.

| Component            | License | Embedded version                               |
| -------------------- | ------- | ---------------------------------------------- |
| three                | MIT     | 0.160.0, identified by bundle                  |
| three-mesh-bvh       | MIT     | Unknown; upstream build manifest not published |
| three-bvh-csg        | MIT     | Unknown; upstream build manifest not published |
| three-gpu-pathtracer | MIT     | Unknown; upstream build manifest not published |

Full license texts, including each original copyright notice, are bundled in
`vendor/THIRD_PARTY_LICENSES.txt`. Their official package sources and integrity
hashes are recorded in `vendor/DEPENDENCIES.json`. Reference package versions
identify where the license text was retrieved; they do not identify the unknown
embedded versions. No rendering library was replaced or upgraded in this audit.

Upstream README at the pinned revision explicitly says its TypeScript/Vite
source project is not in the repository. The minified template has no source map
or build lockfile. This inventory remains partial in this public preview.
The unknown embedded versions and complete transitive license coverage remain
open provenance work. Do not describe this file or npm audit as a complete
audit of the embedded editor.

This desktop directory is the product scope. The parent workspace includes
private user plans and unrelated experiments, which must not be distributed.

## Interface icons and typography

The interface uses selected **Phosphor Icons 2.1.1**, Light weight, under MIT.
Source: https://github.com/phosphor-icons/core. The exact assets were retrieved
from the versioned `@phosphor-icons/core@2.1.1` package and are bundled in
`public/icons/`, with the original license in `public/icons/LICENSE`.

**Noto Sans SC** is bundled for offline Chinese UI text under the SIL Open Font
License 1.1. Source: https://github.com/google/fonts/tree/main/ofl/notosanssc.
`public/fonts/noto-sans-sc.ttf` is a weight-400 instance of the upstream variable
font, generated with fontTools; the license is `public/fonts/OFL.txt`.
Display headings use installed Chinese serif fonts, with system fallbacks.

## Electron and Chromium

Electron is MIT licensed. The packaged runtime includes Electron's `LICENSE.electron.txt`
and `LICENSES.chromium.html`, which contain its own and Chromium dependency
notices. Development and packaging dependencies are recorded in `package-lock.json`.

## Codex CLI

HouseDIY invokes a separately installed official Codex CLI. No CLI executable,
authentication files, account tokens or model weights are bundled. Codex CLI:
https://github.com/openai/codex (Apache-2.0). Model service access is provided by
the user's own account and is subject to that service's terms and limits.

HouseDIY is an independent project, not an official OpenAI or upstream editor product.
