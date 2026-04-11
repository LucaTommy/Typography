# Counterforms — React Typography Tool

Web app for extracting and visualizing negative space between adjacent glyphs.

## Stack

- React + Vite
- `opentype.js` for OTF/TTF parsing, glyph paths, and metrics
- `paper` for boolean path subtraction
- `jszip` + `file-saver` for SVG exports

## Features

- Upload `.otf`/`.ttf` fonts
- Type custom text pairs/words
- Parametric spacing controls:
	- Tracking (uniform letter spacing)
	- Manual kerning on a selected adjacent pair
- Extract counterforms via boolean operation:
	- Bounding box between pair
	- Subtract pair glyph union from the box
- Archive mode:
	- Background async generation of all 2704 `A-Z` + `a-z` pairs
	- O(1) pair lookup from in-memory dictionary
- Export:
	- Visible counterforms
	- Full archive zip in archive mode

## Run

1. `npm install`
2. `npm run dev`

Build and lint:

- `npm run build`
- `npm run lint`
