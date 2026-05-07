# AskBetter Chrome Extension

Live prompt analysis as you type in ChatGPT, Gemini, and Perplexity.

## Architecture

```
extension/
├── manifest.json              # Chrome extension manifest (MV3)
├── popup.html                 # Extension popup UI
├── icons/                     # Extension icons (add 16x16, 48x48, 128x128 PNGs)
├── src/
│   ├── analysis/
│   │   └── engine.ts          # Lightweight single-prompt analyzer
│   ├── content/
│   │   ├── index.ts           # Content script — watches input, runs analysis
│   │   ├── selectors.ts       # Platform-specific DOM selectors
│   │   └── overlay.ts         # Floating score overlay UI
│   ├── background/
│   │   └── index.ts           # Service worker — message passing, optional API sync
│   └── popup/
│       └── index.ts           # Popup script — shows latest score
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## How it works

1. Content script detects which AI platform you're on
2. Finds the chat input field using platform-specific selectors
3. Watches for input changes (debounced at 300ms)
4. Runs the analysis engine on the current prompt text
5. Renders a floating overlay with scores and suggestions
6. Optionally syncs submitted prompts to the AskBetter backend

## Development

```bash
cd extension
npm install
npm run dev        # Build with watch mode
```

Then load the extension in Chrome:
1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension/` directory

## TODO

- [ ] Port full scoring logic from `askbetter/src/analysis/`
- [ ] Add settings page (toggle overlay, configure API connection)
- [ ] Track submitted prompts and sync to dashboard
- [ ] Handle platform DOM changes (selectors may need updating)
- [ ] Publish to Chrome Web Store
