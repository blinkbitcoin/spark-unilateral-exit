# Bundled Blink assets

The desktop UI follows `blink-brand/SKILL.md` and its component, typography,
color and logo references. Brand source: sibling checkout `../blink-brand`,
[designsats/blink-brand](https://github.com/designsats/blink-brand), commit
`5404f77159ecc626798235a89c65d191c2856946`.

- `blink-logo.svg` is an unchanged copy of
  `assets/logo/blink-logo-horizontal-on-dark.svg` in that repository.
- `ibm-plex-sans.ttf` is the IBM Plex Sans variable font from
  [Google Fonts](https://github.com/google/fonts/tree/main/ofl/ibmplexsans),
  original filename `IBMPlexSans[wdth,wght].ttf`. `OFL.txt` is its bundled
  SIL Open Font License.

These are vendored assets. Update them at their source and copy the originals;
do not edit or redraw them here. The build copies the logo, font and font
license to `dist-desktop/assets`. Runtime loading is local; no font CDN or
external asset request is allowed by the app's content security policy.
