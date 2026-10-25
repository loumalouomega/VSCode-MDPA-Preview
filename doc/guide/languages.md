# Languages

This page is written in English, which is the source language of every page of this documentation; no page has a translation yet.

The extension follows VS Code's display language. Text in the preview chrome, in the panels and in the manifest is looked up in a catalogue keyed by the English text, and any string without a translation stays in English, one string at a time. Spanish, French, German and Brazilian Portuguese ship with translations of the viewer's menus, panels, tooltips and command titles. Long explanatory tooltips and technical identifiers (formats, variable names, formulas) stay in English where no translation exists, and any missing string falls back to English. Further languages are added by supplying a table in `src/parser/i18n/locales/` (and a `package.nls.<locale>.json` for the manifest).

Machine-facing text is never translated: MCP tool and parameter names, recipe and sidecar formats, `.mdpa` keywords, and the headers and values of exported CSV and XLSX files. Numbers in exported files always use a decimal point.

To check how a layout copes with longer text, set the display language to the pseudo-locale `qps-ploc`, which brackets and lengthens every string.
