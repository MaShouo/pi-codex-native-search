# Third-party notices

This package adapts portions of OpenAI Codex, Copyright 2025 OpenAI, licensed under Apache-2.0. The original license and NOTICE are included at `src/vendor/CODEX-LICENSE` and `src/vendor/CODEX-NOTICE`. New package-specific code is MIT licensed.

Pinned source: https://github.com/openai/codex/tree/cc7ba33601286a751477832b01de7b6f8de0dd9c

- `src/vendor/web_run_description.md`: unmodified copy of `codex-rs/ext/web-search/web_run_description.md`.
- `src/schema.ts`, `test/fixtures/commands-schema.json`: TypeScript/JSON adaptations of `codex-rs/codex-api/src/search.rs`, normalized following `ext/web-search/src/schema.rs` and `tools/src/json_schema/types.rs`. Runtime numeric bounds restrict Rust u64 inputs to JavaScript safe integers; the wire schema omits those bounds as Codex does.
- `src/history.ts`: TypeScript adaptation of `ext/web-search/src/history.rs`, `tools/src/response_history.rs`, and `utils/string/src/truncate.rs`, with Pi message/session projection as input.
- `src/client.ts`: new HTTP implementation following `codex-api/src/endpoint/search.rs`, `codex-client/src/retry.rs` and `model-provider-info/src/lib.rs`. Additional local safety limits are documented in README.md.
- `src/wire.ts` and `src/index.ts`: Pi adapters for the namespace/tool-output contracts in `ext/web-search/src/tool.rs` and `ext/web-search/src/output.rs`.

Existing Pi implementations were inspected as references, not copied: [pi-web-engine](https://github.com/WolfieLeader/pi-web-engine/tree/e580e2df0c2ef1abf0ed5d9c1601199c8405645c) and [pi-web-access](https://github.com/nicobailon/pi-web-access/tree/7e6e2386dc9a31d5e2a448172060dd1339c604f7).
