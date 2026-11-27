# Third-party notices

Zirma is MIT licensed (see `LICENSE`). Parts of it come from, or follow, other people's open-source work. This file
says what, where, and under which licence. Where code was adapted, the file it lives in also names its source.

## Code adapted from other projects

| In Zirma | From | Licence |
| --- | --- | --- |
| `packages/engine-pi/src/skills.ts`: switching a skill off and on by editing one frontmatter line (`setSkillDisabled`, `frontmatterBlock`) | [pi-web](https://github.com/agegr/pi-web), `lib/skill-frontmatter.ts` | MIT, © 2026 agegr |
| `packages/engine-pi/src/usage.ts`: the request and response formats for a subscription's usage windows | [pi-web](https://github.com/agegr/pi-web), `lib/provider-usage.ts`, which follows [@narumitw/pi-usage](https://github.com/narumiruna/pi-extensions) | MIT, © 2026 agegr; MIT, © 2026 narumiruna |
| `packages/server/src/web/providers/bocha.ts`: the request to 博查's web search, its freshness values, reading its answer, and keeping results to one site | [pi-web-access](https://github.com/nicobailon/pi-web-access) 0.48.0, `bocha.ts` (`mapFreshness`, `parseSearchResponse`, the domain filter) | MIT, © 2025 Nico Bailon |
| `packages/server/src/web/providers/brave.ts`: the request to Brave's web search, its freshness codes, keeping results to one site, and taking Brave's marks out of titles and excerpts | [pi-web-access](https://github.com/nicobailon/pi-web-access) 0.48.0, `brave.ts` (`buildBraveQuery`, `matchesDomainFilters`, `stripHtml`) | MIT, © 2025 Nico Bailon |
| `packages/server/src/web/providers/exa.ts`: reaching Exa's free search through its MCP endpoint, folding filters into the query, and reading its answer into results | [pi-web-access](https://github.com/nicobailon/pi-web-access) 0.48.0, `exa.ts` (`callExaMcp`, `parseMcpResults`, `buildMcpQuery`) | MIT, © 2025 Nico Bailon |
| `packages/server/src/web/providers/jina.ts`: reading a page through Jina Reader, without its cache, and counting a page still loading as not read | [pi-web-access](https://github.com/nicobailon/pi-web-access) 0.48.0, `extract.ts` (`extractWithJinaReader`) | MIT, © 2025 Nico Bailon |
| `packages/server/src/web/providers/searxng.ts`: cleaning up a SearXNG address, the JSON search request, and keeping results to one site | [pi-web-access](https://github.com/nicobailon/pi-web-access) 0.48.0, `searxng.ts` (`normalizeBaseUrl`, `searchWithSearXNG`, the domain filter) | MIT, © 2025 Nico Bailon |
| `packages/server/src/web/providers/tavily.ts`: the request to Tavily's search, its time range and site filter, and reading its answer into results | [pi-web-access](https://github.com/nicobailon/pi-web-access) 0.48.0, `tavily.ts` (`searchWithTavily`, `mapDomainFilter`, `mapResults`) | MIT, © 2025 Nico Bailon |
| `packages/ui/src/brand/svg/`: model-provider and service logos (all but the ones below) | [LobeHub Icons](https://github.com/lobehub/lobe-icons), through `@lobehub/icons-static-svg` 1.104.0 | MIT, © 2023 LobeHub |
| `packages/ui/src/brand/svg/`: `tailscale`, `xiaomi`, `notion`, `linear`, `sentry`, `atlassian`, `github` | [Simple Icons](https://simpleicons.org) 16.38.0 | CC0-1.0 |
| `packages/ui/src/brand/svg/`: `inworld`, `boson` | The companies' own sites: inworld.ai (its wordmark, cropped to the mark) and boson.ai (`/logo.svg`) | The owners' marks, not openly licensed; used only to name their services in Settings → Voice |
| `packages/ui/src/brand/svg/`: `gmail`, `google-calendar` | [gilbarbara/logos](https://github.com/gilbarbara/logos), through `@iconify-json/logos` 1.2.20 | CC0-1.0 |
| `packages/ui/src/fonts/GeistSerif-Regular.woff2`: the Geist Serif font, for the wordmark; `prototype/fonts/GeistSerifVF.woff2`: the same font with its variable axis, for `prototype/serif.html` | [Geist](https://github.com/vercel/geist-font), through `geist` 1.9.2 | SIL OFL 1.1, © 2023 Vercel; the licence text is beside each file (`GeistSerif-OFL.txt`) |

The logos are trademarks of their owners; see `packages/ui/src/brand/README.md`.

## Libraries with terms to keep when packaging

| Used by | Library | Licence |
| --- | --- | --- |
| `modules/links/src/fetch.ts` (`shrinkCover`): saved covers are resized to the size they are drawn | [sharp](https://github.com/lovell/sharp) 0.35.5, with its prebuilt [libvips](https://github.com/libvips/libvips) (`@img/sharp-libvips-*`) | sharp: Apache-2.0; libvips: LGPL-3.0-or-later, linked dynamically. A packaged Zirma.app must carry libvips's licence and leave the library replaceable. |
| `packages/server/src/web/read.ts`: a web page's article as Markdown, the way pi-web-access reads one | [linkedom](https://github.com/WebReflection/linkedom) 0.18.15, [@mozilla/readability](https://github.com/mozilla/readability) 0.6.0, [turndown](https://github.com/mixmark-io/turndown) 7.2.5 | linkedom: ISC; Readability: Apache-2.0; Turndown: MIT |

## Designs followed (no code copied)

These parts were written for Zirma, but their shape follows [pi-web](https://github.com/agegr/pi-web) (MIT,
© 2026 agegr):

- Settings split into tabs, and the General tab (`packages/ui/src/Settings.tsx`, `packages/ui/src/General.tsx`)
- Settings → Skills, and adding a skill from [skills.sh](https://skills.sh) (`packages/ui/src/Skills.tsx`,
  `packages/engine-pi/src/skills.ts`)
- Masking credentials in a connector's address or command (`packages/engine-pi/src/connectors.ts`)
- The usage line under a conversation: tokens in and out, cost, how full the context is
  (`packages/ui/src/Conversation.tsx`, `packages/ui/src/styles.css`)
- Keeping a conversation's session open between turns (`packages/engine-pi`)

## Where Zirma came from

Zirma grew out of pi-web-robin, its author's own fork of pi-web. The parts ported from Robin (the todo rules,
presence, the Google Calendar and Gmail readers, Links) were written by Zirma's author and are not third-party
code. Anything in Robin that came from pi-web is listed above.

## Built on

Zirma runs on these packages; they are installed from npm, not copied in, and keep their own licences.

| Package | Used for | Licence |
| --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-mcp`) | the agent engine, model sign-in, MCP | MIT, © 2025 Mario Zechner |
| [TypeBox](https://github.com/sinclairzx81/typebox) | tool schemas | MIT |
| [node-pty](https://github.com/microsoft/node-pty) | the dev terminal | MIT, © Microsoft |
| [web-push](https://github.com/web-push-libs/web-push) | phone notifications | MPL-2.0 (used unmodified) |
| [xterm.js](https://github.com/xtermjs/xterm.js) (`@xterm/xterm`, `@xterm/addon-fit`) | the dev terminal's screen | MIT |
| [React](https://github.com/facebook/react) | the interface | MIT, © Meta |
| [uqr](https://github.com/unjs/uqr) | pairing QR codes | MIT |
| [ProseMirror](https://github.com/ProseMirror/prosemirror) (`prosemirror-model`, `-state`, `-view`, `-transform`, `-commands`, `-keymap`, `-history`, `-inputrules`, `-dropcursor`) | the notes editor | MIT, © Marijn Haverbeke and others |
| [micromark](https://github.com/micromark/micromark) and [mdast](https://github.com/syntax-tree) (`mdast-util-from-markdown`, `micromark-extension-gfm`, `mdast-util-gfm`, `micromark-extension-frontmatter`, `mdast-util-frontmatter`, `micromark-extension-math`, `mdast-util-math`) | reading notes' Markdown | MIT, © Titus Wormer |
| [KaTeX](https://github.com/KaTeX/KaTeX) | installed with `micromark-extension-math`; notes do not draw formulas yet | MIT |
| [Electron](https://github.com/electron/electron) | the Mac app | MIT |
| [Vite](https://github.com/vitejs/vite) | building the interface (dev only) | MIT |
| [Playwright](https://github.com/microsoft/playwright) (`playwright-core`) | app tests (dev only) | Apache-2.0 |

## Licence text

pi-web, @narumitw/pi-usage, LobeHub Icons and Pi are each under the MIT License below, with these copyright lines:

```
Copyright (c) 2026 agegr                (pi-web)
Copyright (c) 2026 narumiruna           (@narumitw/pi-usage)
Copyright (c) 2023 LobeHub              (LobeHub Icons)
Copyright (c) 2025 Mario Zechner        (Pi)
```

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
