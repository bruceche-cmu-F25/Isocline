# Other companies' marks

The files in `svg/` are the logos of services Zirma connects to. They are shown only next to that service's
name, to say which service a row, a page's data or a model belongs to. Each mark is a trademark of its owner;
Zirma is not affiliated with or endorsed by any of them. The licence texts are in the repository's
`THIRD-PARTY-NOTICES.md`.

## Where they came from

| Files | Source | Licence of the drawing |
| --- | --- | --- |
| `gmail`, `google-calendar` | [gilbarbara/logos](https://github.com/gilbarbara/logos) through `@iconify-json/logos` 1.2.20 | CC0-1.0 |
| `tailscale`, `xiaomi`, `notion`, `linear`, `sentry`, `atlassian`, `github` | [Simple Icons](https://simpleicons.org) 16.38.0 | CC0-1.0 |
| all the others | [LobeHub Icons](https://github.com/lobehub/lobe-icons) through `@lobehub/icons-static-svg` 1.104.0 | MIT, © LobeHub |

## Adding one

Only a drawing with an open licence (MIT, CC0 or the like) goes in: look in the sets above first. A mark taken from a company's own site has no such licence, so a service without an open one shows its first letter instead (Inworld and Boson AI in Settings → Voice).

Put a cleaned SVG in `svg/`. Its file name is its name: `<Logo name="…" />`. For a model provider, name it after
Pi's provider id, or the id's first part: `openai.svg` also serves `openai-codex`.

Cleaned means:

- the root keeps only `viewBox` (and `fill-rule` if the drawing needs it): no `width`, `height`, `style` or `<title>`;
- a one-colour mark has no `fill` at all, so it takes the text colour and follows light and dark;
- ids are named `LOGO-0`, `LOGO-1`, …: `Logo` renames them wherever a mark is drawn, so two copies on one page
  don't share a gradient;
- nothing but drawing: no scripts, links, images or event attributes. The file's text is put into the page as is.
