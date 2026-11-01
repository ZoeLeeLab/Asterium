# Source availability, license choices and unresolved items

Review date: 2026-11-01. This records third-party evidence, not a project license or a completed distribution clearance. Package versions and original notice texts are indexed in `manifest.json`. The registry integrity values for the source investigations matched the project's lockfile where that version appears in the lockfile.

## Fixed source references

### elkjs 0.9.3 — EPL-2.0

- Published npm metadata: <https://registry.npmjs.org/elkjs/0.9.3>
- Published git revision: `a8304cf79fde75bc2ab1a89d28320f53f8637436`.
- Source: <https://github.com/kieler/elkjs/tree/a8304cf79fde75bc2ab1a89d28320f53f8637436>
- Download: <https://codeload.github.com/kieler/elkjs/tar.gz/a8304cf79fde75bc2ab1a89d28320f53f8637436>
- Downloaded archive SHA-256: `850418c89dd35dbd94ea0100a7becbc09d320c153fda4c4ea4a88c67e12121a9`.

The source package version was checked against the npm version. However, its build uses a separate ELK Java source checkout and GWT. The upstream README explicitly says elkjs patch/revision numbers can diverge from ELK's. The exact upstream Java/GWT source correspondence is **not yet closed**; an identically numbered ELK tag must not be assumed to exist. This link supplies verified wrapper source, not an assertion that it is the entire preferred source form of the compiled algorithms.

### mtx-decompressor 1.4.2 — MPL-2.0, embedded by PPTX renderer

- Evidence: `@aiden0z/pptx-renderer` 1.3.0's supplied `THIRD_PARTY_NOTICES.md` names embedded version 1.4.2 and describes its source files as unmodified before bundling/minification.
- Published git revision: `23bd175d31f845aafa4674114f7cddabaa82a4e1`.
- Source: <https://github.com/ChristopherVR/mtx-decompressor/tree/23bd175d31f845aafa4674114f7cddabaa82a4e1>
- Download: <https://codeload.github.com/ChristopherVR/mtx-decompressor/tar.gz/23bd175d31f845aafa4674114f7cddabaa82a4e1>
- Downloaded archive SHA-256: `eaecf2e69ad32239d9689f7526acd29b90302bedfdbde5d78ca90eb0fe64456b`.

The archive contains TypeScript source and its package version was verified. The original MPL text and the renderer's third-party notice are retained in the aggregate. This version must not be replaced in the notice by the separately resolved dependency below. The MTX project's declared provenance is a TypeScript port of [libeot](https://github.com/umanwizard/libeot); preserve any applicable original file notices when redistributing or modifying source.

### mtx-decompressor 1.6.0 — separately resolved dependency

- Published git revision: `9758209fcc74d4ab71bb02a9a8b11cf850bc5c7d`.
- Source: <https://github.com/ChristopherVR/mtx-decompressor/tree/9758209fcc74d4ab71bb02a9a8b11cf850bc5c7d>
- Download: <https://codeload.github.com/ChristopherVR/mtx-decompressor/tar.gz/9758209fcc74d4ab71bb02a9a8b11cf850bc5c7d>
- Downloaded archive SHA-256: `bb3502aedda4a91b5c0871c01b7056f0b9ccd627e4a42d3094c0e6b4bb474685`.

The archive contains TypeScript source and its package version was verified. Presence in the resolved dependency closure is not proof that this copy replaces the renderer's already embedded 1.4.2 code.

### standardwebhooks 1.1.1 — MIT

- Published git revision: `b4d2c14fc5b4ccff3ff271e3b087dff812254c59`.
- Applicable library license: <https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE>
- Preserved copy: `supplemental/standardwebhooks-1.1.1-LICENSE`.
- Preserved text SHA-256: `5ec8c7b26b64d881a6706617bed25c049f97f2f35de034c756de8546fd6dbe27`.

The npm package declares MIT but omits the license file. The matching source revision places MIT in the parent `libraries/LICENSE`. The different Apache license at the repository root was not substituted for the JavaScript library's license.

## Windows installer resource plugins

### StdUtils 1.14

- Fixed source: <https://github.com/lordmulder/stdutils/tree/4e1117321001e54dcd2c52f72d3c359d5215e426>
- Download: <https://codeload.github.com/lordmulder/stdutils/tar.gz/4e1117321001e54dcd2c52f72d3c359d5215e426>
- Archive SHA-256: `3687ab4e09005a8a0b93c1a07a36285d93466070e94b8bf6f12781fb53c419e1`.
- Source version definitions match the candidate's PE version 1.1.4.0. The original LGPL-2.1-or-later text, NSIS interface clarification and README are retained in the aggregate. The clarification describes unmodified-library use through the NSIS interface; it is not permission to relicense the library. No reproducible-build equivalence is asserted.

### UAC 0.2.4c

- Official archive: <https://nsis.sourceforge.io/mediawiki/images/8/8f/UAC.zip>
- Archive SHA-256: `20e3192af5598568887c16d88de59a52c2ce4a26e42c5fb8bee8105dcbbd1760`.
- The x86-unicode DLL is byte-identical to the candidate: `2f7f8fc05dc4fd0d5cda501b47e4433357e887bbfed7292c028d99c73b52dc08`.
- Original `License.txt` is retained unchanged; it supplies zlib-style redistribution terms.

### nsis7z 19.00 and LZMA SDK 19.00

- Official plugin archive: <https://nsis.sourceforge.io/mediawiki/images/6/69/Nsis7z_19.00.7z>
- Plugin archive SHA-256: `6f2f3730049926f40442ee0c8b7d3e3dee7ace544d82467ff8059ea3f4201c58`.
- The x86-unicode DLL is byte-identical to the candidate: `b393f05e8ff919ef071181050e1873c9a776e1a0ae8329aefff7007d0cadf592`.
- The archive supplies plugin C/C++ files and explicitly instructs using the C/CPP folders of LZMA SDK 19.00, not 7-Zip 4.64 from the older paragraph.
- Matching base source: <https://www.7-zip.org/a/lzma1900.7z>; downloaded SHA-256 `00f569e624b3d9ed89cf8d40136662c4c5207eaceb92a70b1044c77f84234bad`.
- Original plugin `License.txt`, `nsis7z.txt`, and complete SDK `DOC/lzma-sdk.txt` are preserved in the aggregate. The SDK text places the original LZMA SDK in the public domain. The plugin README separately mentions LGPL without specifying a version. The scope/version of the plugin authors' grant remains a clarification item; do not label the entire plugin public domain or silently assign an LGPL version.

### WinShell 20121005 — unresolved

- Official page: <https://nsis.sourceforge.io/WinShell_plug-in>
- Official archive: <https://nsis.sourceforge.io/mediawiki/images/5/54/WinShell.zip>
- Archive SHA-256: `34e111f8aacf64c540d848fd06b9d6f3e2c10cb825ec9329a01d1141973e749b`.
- Its unicode DLL is byte-identical to the candidate: `9be85b986ea66a6997dde658abe82b3147ed2a1a3dcb784bb5176f41d22815a6`.
- The ZIP contains only two DLLs, no license text or source. The official page says `Freeware`; this alone does not establish open-source or sufficiently explicit redistribution terms. The page also describes a System-plugin alternative for some operations. Obtain applicable terms/source or assess replacement in a separate installer change; maintainer approval cannot grant another author's rights.

## Additional notice material

- JSZip: selected MIT from its offered alternatives; the upstream dual-license text is preserved unchanged.
- DOMPurify: selected Apache-2.0; supplied original license texts are preserved.
- Lucide: preserve both ISC and Feather-derived MIT notices in its full license file.
- PDF.js: preserve its separately supplied CMap, font, ICC and decoder notices when the corresponding material is used; the aggregate conservatively includes them without claiming every asset is bundled.
- PPTX renderer: the ECMA-376 shape-definition notice is separate from Apache-2.0. The supplied unchanged ECMA text permits the described standard-conformant implementation use subject to its notice conditions. The original upstream third-party explanation and notice are preserved; the standard text is not relicensed as MPL.
- NSIS stock COPYING was matched byte for byte to the file at the frozen compiler source bundle revision `fac48dd35372e2d25b7a2d20478ace2cc6df4d50`: <https://github.com/electron-userland/electron-builder-binaries/blob/fac48dd35372e2d25b7a2d20478ace2cc6df4d50/nsis/COPYING>.

## Still unresolved

1. Native Claude Code use remains subject to its vendor's terms. The npm Agent SDK is removed from the current dependency and package roots; prior SDK candidate records remain historical. This change does not grant a new subscription OAuth permission or relicense Claude Code.
2. The exact preferred-source correspondence for ELK's compiled Java/GWT algorithm code, beyond the verified npm wrapper source.
3. WinShell's explicit redistribution/source terms, and the nsis7z plugin LGPL version/scope clarification. UAC's original license and matching binary have been identified; StdUtils's version, source and original clarification have been identified. Stock NSIS COPYING is not substituted for these separate terms.
4. Complete closure of code/data already embedded inside upstream bundles; this inventory is a conservative dependency closure, not proof of a complete binary SBOM.
5. Final project/asset/brand policy choices and next-candidate verification that this collection is actually shipped. Existing candidates are not rewritten.
