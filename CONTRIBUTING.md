# Contributing

HouseDIY uses Node.js 24 and plain JavaScript. The shipped desktop target is Windows x64.

```sh
npm ci
npm test
npm run check
npm start
```

Run `npm run format` before submitting code. Unit/integration tests use a local mock model and do not consume model quota. `npm run test:ui` uses a locally installed Chrome or Edge; `npm run build` and `npm run test:package` require Windows.

Keep changes to project persistence, AI operations and editor synchronization covered by behavioral tests. Preserve manual edits, existing project IDs and the shared operation schema. Do not add arbitrary model-generated code execution.

Keep the pinned upstream editor unchanged unless the adaptation, revision, hashes and notices are updated together. See [third-party notices](THIRD_PARTY_NOTICES.md) for the current provenance limitation.

Do not commit personal floor plans, account credentials, API keys, local project stores, screenshots of private projects or `.qa` results. Use the synthetic example in `examples/demo-plan.json` for reproducible reports. Sanitize logs before attaching them to an issue.
