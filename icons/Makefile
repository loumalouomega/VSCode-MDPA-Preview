# ── Toolbar/panel icons: tikz-ui/*.tex → svg-ui/*.svg → src/toolbarIcons.ts
#    (monochrome, currentColor-based, wired into the extension) ──
# Same pipeline and visual language as sibling project CAD-Preview; several
# icons (wireframe, close, warning) are copied verbatim from there so both
# extensions share one look. Needs pdflatex + pdftocairo (poppler).
UI_TEXDIR := tikz-ui
UI_BUILDDIR := build-ui
UI_SVGDIR := svg-ui

UI_TEX := $(wildcard $(UI_TEXDIR)/*.tex)
UI_SVG := $(patsubst $(UI_TEXDIR)/%.tex,$(UI_SVGDIR)/%.svg,$(UI_TEX))

.PHONY: all ui ts clean
all: ts
ui: $(UI_SVG)

$(UI_SVGDIR)/%.svg: $(UI_TEXDIR)/%.tex
	@mkdir -p $(UI_BUILDDIR) $(UI_SVGDIR)
	pdflatex -interaction=nonstopmode -halt-on-error -output-directory=$(UI_BUILDDIR) $< >/dev/null
	pdftocairo -svg $(UI_BUILDDIR)/$*.pdf $(UI_SVGDIR)/$*.svg

# Regenerates ../src/toolbarIcons.ts from svg-ui/*.svg — run after `make ui`
# whenever a tikz-ui/*.tex source changes. Pure Node, no LaTeX needed as long
# as svg-ui/*.svg is already up to date (it's committed for exactly this).
ts: ui
	node build-toolbar-icons.mjs

clean:
	rm -rf $(UI_BUILDDIR) $(UI_SVGDIR)
