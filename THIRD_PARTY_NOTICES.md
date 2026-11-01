# Third-party notices

This document identifies third-party material used by Asterium. It does not grant a project-level license for Asterium and does not replace any component's original terms. A project license has not yet been applied.

## Collected license texts and review scope

Original license, copyright and notice texts are collected in [third_party/licenses/THIRD_PARTY_LICENSES.txt](third_party/licenses/THIRD_PARTY_LICENSES.txt). The [manifest](third_party/licenses/manifest.json) identifies component versions, source files and SHA-256 digests of the exact text bytes. [Source availability and exceptions](third_party/licenses/SOURCES.md) records fixed source revisions and unresolved items.

The inventory combines production bundle module tracing with a conservative resolved dependency/peer closure and declared prebundled components. Some listed dependencies may not be present in a particular binary. It is not an exact SBOM for every artifact. Inclusion of a notice does not resolve an uncertain redistribution permission.

To regenerate or verify the collection after installing the locked dependencies:

```sh
node scripts/collect-third-party-notices.mjs
node scripts/collect-third-party-notices.mjs --check
```

The collection is configured as an extra resource for future application builds. Existing candidates and their hashes are unchanged; actual delivery must be checked in a new candidate before release.

## Desktop runtime dependencies

The collected texts cover React and React DOM, React Router, React Markdown, remark-gfm and their resolved dependency closure; Mermaid and its diagram/layout dependencies; Lucide; Mammoth; PDF.js; SheetJS; the PPTX renderer; MCP; YAML; Zod; and other entries identified in the manifest. Original terms remain applicable.

- Lucide's complete license text includes both its ISC notice and the MIT notice for Feather-derived icons. Both are retained.
- JSZip is offered under MIT or GPL; this distribution selects MIT and retains the upstream license document, including its dual-license explanation. This selection does not relicense other components.
- DOMPurify is offered under MPL-2.0 or Apache-2.0; this distribution selects Apache-2.0 and preserves its supplied license texts.
- The local `khroma` license text is MIT despite missing license metadata. `duck`'s local two-condition BSD text is retained without relying only on its generic metadata label.
- `isarray` supplies its MIT text in its README. `standardwebhooks`' JavaScript library MIT notice is obtained from the `libraries/LICENSE` at its verified published source revision, not the different license at the repository root. Evidence is recorded with the collection.

### ELK layout code

Mermaid includes `elkjs` 0.9.3, licensed under EPL-2.0. Its original license is retained. The verified npm publishing revision and available wrapper source are listed in SOURCES.md; the exact Java/GWT upstream source correspondence remains under review. Do not relabel ELK source as Asterium's license or treat the wrapper source link alone as proof that all corresponding source obligations have been fulfilled.

### PPTX renderer and embedded font processing

`@aiden0z/pptx-renderer` 1.3.0 is Apache-2.0. Its published bundle notice explicitly identifies embedded `mtx-decompressor` **1.4.2** under MPL-2.0. This differs from the separately resolved 1.6.0 lockfile dependency; both versions are recorded separately. Original notices and fixed source references are retained. The upstream MTX project identifies its libeot provenance.

The renderer also describes mechanically derived ECMA-376 DrawingML shape definitions. The original ECMA copyright notice and upstream third-party notice are preserved. They are not replaced by the renderer's Apache license or Asterium's proposed project license.

### PDF, font and decoder material

The PDF.js distribution contains separate notices for CMaps, Foxit/Liberation fonts, ICC data, OpenJPEG and QCMS code. Those supplied notices are collected conservatively. Their presence in the collection does not mean that every font or WASM asset is shipped. Any added asset must be traced and checked against its actual terms; font reserved names and attribution conditions remain applicable.

## Native Claude Code, installed separately

The current source no longer depends on or packages `@anthropic-ai/claude-agent-sdk`. Asterium invokes the user's separately installed, unmodified official Claude Code executable. The executable and its authentication remain governed by [Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance); they are not relicensed by Asterium.

Users complete the official CLI's own authentication flow. Asterium does not implement a Claude subscription OAuth service or collect its login credentials. Historical candidates containing the SDK retain their original notices and evidence; removing it from current source does not alter those candidates. CLI verification copies and synthetic model fixtures are development evidence and must not be included in application packages.

## Electron and Windows installer

Electron's original LICENSE and Chromium third-party license page are supplied by the Electron distribution and must be kept in application builds. They do not replace the notices for JavaScript dependencies added by Asterium.

The frozen NSIS 3.0.4.1 stock COPYING file is preserved in [third_party/installer/nsis-3.0.4.1/COPYING](third_party/installer/nsis-3.0.4.1/COPYING) and the aggregate. It contains the stock zlib/libpng, bzip2 and CPL-1.0 terms, including the NSIS LZMA linking exception. This stock notice does not automatically cover independently supplied resource plugins.

- UAC 0.2.4c: the official ZIP's x86-unicode DLL matches the candidate byte for byte; its original zlib-style license is preserved.
- StdUtils 1.14: its version definitions match the candidate PE version 1.1.4.0. The upstream LGPL-2.1-or-later text, NSIS interface clarification and README are preserved, with a fixed source revision. This is not a reproducible-build claim.
- nsis7z 19.00: the official archive's x86-unicode DLL matches the candidate byte for byte. Preserve its plugin README, supplied LZMA public-domain text and the matching LZMA SDK 19.00 source/documentation reference separately. The plugin README's LGPL statement does not specify a version; the SDK's public-domain grant must not be assumed to cover every plugin author's contribution. This remains a clarification item.
- WinShell: the official ZIP's unicode DLL matches the candidate, but contains no license text or source, and its page only labels it `Freeware`. Explicit redistribution/source terms or a replacement must be resolved before treating this item as cleared.

Source archives, versions and remaining limits are recorded in [SOURCES.md](third_party/licenses/SOURCES.md). The collection preserves available notices; it does not imply every installer authorization issue is closed.

## Standalone Wake SDK

The standalone Studio Wake Adapter SDK bundles `zod` 4.5.4 (MIT, copyright Colin McDonnell). Its unchanged upstream license is emitted beside the SDK as `out/studio-wake-adapter/LICENSE-ZOD.txt` and must accompany that bundle.

## MCP TypeScript client and server

Asterium's API-partner MCP connections use `@modelcontextprotocol/client` 2.3.1; external group chat uses `@modelcontextprotocol/server` 2.3.1. Both use `@modelcontextprotocol/core` 2.3.1 from the [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

Their identical, unmodified upstream license text is included at `third_party/mcp-client/2.3.1/LICENSE`. It describes the project's MIT/Apache-2.0 licensing transition and includes the applicable license texts. Asterium's connection manager and launch backend are separate application code.

## MouseCrew frontend-builder

Asterium includes the `frontend-builder` skill from [MouseCrew](https://github.com/anqinou-art/mousecrew), fixed at commit `a405854543eeb3a8c18800d17b07455b0f9bf2d6`.

Copyright (c) 2026 mousecrew contributors, as stated in the upstream license. Licensed under the MIT License. The unchanged upstream files and license are stored in `third_party/mousecrew/a4058545/`.

Asterium's adapter and runtime integration are separate files and are not represented as upstream MouseCrew work.

## YAML

API Skill metadata uses `yaml` 2.9.1, copyright Eemeli Aro, licensed under ISC. The unchanged license is included at `third_party/yaml/2.9.1/LICENSE`.
