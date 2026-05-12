# Tech Stack

## Runtime & Language

- **TypeScript** ~5.8, strict mode, ES2022 target
- **Chrome Extension Manifest V3** — service worker background, content scripts, popup
- No runtime frameworks or UI libraries — all DOM manipulation is vanilla JS/TS

## Build System

- **Vite** ^6.3 with Rollup under the hood
- Three entry points compiled to flat `dist/` files:
  - `src/content/index.ts` → `dist/content.js`
  - `src/background/index.ts` → `dist/background.js`
  - `src/popup/index.ts` → `dist/popup.js`
- Chunks go to `dist/chunks/[name].js`
- `emptyOutDir: true` — dist is wiped on every build

## Module System

- `"type": "module"` in package.json
- `moduleResolution: "bundler"` in tsconfig — use bare specifiers, no `.js` extensions on imports

## Type Checking

- `@types/chrome` for Chrome extension APIs
- No separate test framework is configured

## Common Commands

```bash
npm run dev        # Vite build in watch mode (for development)
npm run build      # Single production build
npm run typecheck  # tsc --noEmit, no emit, type errors only
npm run format     # Prettier — formats src/**/*.ts and popup.html in place
```

## Loading the Extension Locally

1. Run `npm run dev` (or `npm run build`)
2. Open `chrome://extensions`
3. Enable Developer mode
4. Click "Load unpacked" → select the project root (where `manifest.json` lives)
5. Reload the extension after each build

## Dependencies

All dependencies are `devDependencies` — nothing ships at runtime except the compiled JS:

| Package | Purpose |
|---|---|
| `vite` | Build tool |
| `typescript` | Compiler |
| `@types/chrome` | Chrome API types |
| `prettier` | Code formatter (3.5.3 pinned) — config in `.prettierrc`, ignores in `.prettierignore` |
