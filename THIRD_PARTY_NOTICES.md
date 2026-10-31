# Third-party notices

The standalone Studio Wake Adapter SDK bundles `zod` 4.5.4 (MIT, copyright Colin McDonnell). Its unchanged upstream license is emitted beside the SDK as `out/studio-wake-adapter/LICENSE-ZOD.txt` and must accompany that bundle.

## MCP TypeScript client and server

Asterium's API-partner MCP connections use `@modelcontextprotocol/client` 2.3.1; external group chat uses `@modelcontextprotocol/server` 2.3.1. Both use `@modelcontextprotocol/core` 2.3.1 from the [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

Their identical, unmodified upstream license text is included at `third_party/mcp-client/2.3.1/LICENSE`. It describes the project's MIT/Apache-2.0 licensing transition and includes the applicable license texts. Asterium's connection manager and launch backend are separate application code.

## MouseCrew frontend-builder

Asterium includes the `frontend-builder` skill from [MouseCrew](https://github.com/anqinou-art/mousecrew), fixed at commit `a405854543eeb3a8c18800d17b07455b0f9bf2d6`.

Copyright (c) 2026 An Qinou Art contributors. Licensed under the MIT License. The unchanged upstream files and license are stored in `third_party/mousecrew/a4058545/`.

Asterium's adapter and runtime integration are separate files and are not represented as upstream MouseCrew work.

## YAML

API Skill metadata uses `yaml` 2.9.1, copyright Eemeli Aro, licensed under ISC. The unchanged license is included at `third_party/yaml/2.9.1/LICENSE`.
