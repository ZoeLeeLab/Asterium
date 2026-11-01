# Third-party notices

This document identifies third-party material used by Asterium. It does not replace any component's original terms. Asterium-owned code is separately licensed under [MPL-2.0](LICENSE); documentation, artwork and branding have the scopes stated in [COPYRIGHT.md](COPYRIGHT.md). This notice collection does not itself grant those rights or declare all release checks passed.

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

Mermaid includes `elkjs` 0.9.3, licensed under EPL-2.0. Its upstream release identifies ELK 0.9.1 plus the port-placement change in ELK PR 955. Fixed wrapper, Java baseline, patch and preferred-source references are listed in SOURCES.md; no byte-identical rebuild is claimed. ELK is not relicensed as Asterium code.

The published worker also embeds Java/GWT library code. Original source-file headers and complete license texts are retained for GWT 2.10.0 and Guava/Guava-GWT 31.1-jre (Apache-2.0), EMF-GWT common/ecore 2.12.4 (original EPL-1.0 headers), and Xtext xbase library 2.28.0 (EPL-2.0). The fixed source JARs, hashes and conservative header collection are recorded at `third_party/elkjs/0.9.3/`; all notices are also included in the aggregate. Current EMF licensing is not substituted for the fixed old version. This conservative collection is not a claim that every class in those source archives is shipped.

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
- nsis7z 19.00: its official x86-unicode DLL matches the historical r2 candidate byte for byte. The original plugin's unversioned LGPL grant is retained; Asterium selects compliance with LGPL-2.1 under its section 13, rather than changing the upstream text. The full LGPL text, NSIS API's zlib/libpng notice and stock license text are included. The original LZMA SDK public-domain notice remains separate and is not assumed to cover plugin contributions. Corresponding plugin/SDK source and build references accompany the distribution process described in SOURCES.md.
- electron-builder 26.18.1: installer templates are MIT, copyright Loopline Systems. Its original license is retained. The source-owned packaging adapter checks the exact locked templates and changes shell calls only in a temporary build copy; installed dependencies are not patched.
- WinShell: historical r2 and older candidates include this unresolved Freeware-only plugin and retain their original evidence. The current source recipe replaces its calls with Asterium's Windows COM implementation through the stock System plug-in. A new installer must be unpacked to verify that WinShell.dll is absent before distribution; source changes do not change any old binary or prove new package acceptance.

Source archives, versions and remaining limits are recorded in [SOURCES.md](third_party/licenses/SOURCES.md). The collection preserves available notices; it does not imply every installer authorization issue is closed.

## Standalone Wake SDK

The standalone Studio Wake Adapter SDK bundles `zod` 4.5.4 (MIT, copyright Colin McDonnell). Its unchanged upstream license is emitted beside the SDK as `out/studio-wake-adapter/LICENSE-ZOD.txt` and must accompany that bundle.

## MCP TypeScript client and server

Asterium's API-partner MCP connections use `@modelcontextprotocol/client` 2.3.1; external group chat uses `@modelcontextprotocol/server` 2.3.1. Both use `@modelcontextprotocol/core` 2.3.1 from the [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

Their identical, unmodified upstream license text is included at `third_party/mcp-client/2.3.1/LICENSE`. It describes the project's MIT/Apache-2.0 licensing transition and includes the applicable license texts. Asterium's connection manager and launch backend are separate application code.

## MouseCrew frontend-builder

Asterium includes the `frontend-builder` skill from [MouseCrew](https://github.com/anqinou-art/mousecrew), fixed at commit `a405854543eeb3a8c18800d17b07455b0f9bf2d6`.

Copyright (c) 2026 mousecrew contributors, as stated in the upstream license. Licensed under the MIT License. The unchanged upstream files and license are stored in `third_party/mousecrew/a4058545/`.

Asterium's stage-loading adapter is separate application code. Its native project method/workflow templates adapt the frontend-builder methodology and retain the fixed revision and MIT source attribution; these are not represented as new upstream MouseCrew code. This round restored the nine vendored files to exact upstream bytes, removing only extra trailing whitespace introduced by the earlier import. The historical candidates are unchanged.

## YAML

API Skill metadata uses `yaml` 2.9.1, copyright Eemeli Aro, licensed under ISC. The unchanged license is included at `third_party/yaml/2.9.1/LICENSE`.
