# Contributing to wosu!

Thanks for considering a contribution! Bug reports, feature ideas and pull requests are all welcome.

## Questions

Please don't use the issue tracker for non-technical questions. Email MostLime (mostlime@outlook.com) or DM `mostlime12195` on Discord instead.

## Reporting bugs

Open an issue with:

- what you did, what you expected, and what happened instead
- your browser, OS and GPU, and the renderer shown in Settings → General (WebGL or WebGPU)
- the beatmap (a link or set id) if it only happens on one map
- any errors from the browser console (F12)

## Working on the code

wosu! is a single [PixiJS](https://pixijs.com) app written in TypeScript and built with [Vite](https://vite.dev).

```bash
npm install
npm run dev        # dev server with hot reload
npm run typecheck  # tsc, strict
npm test           # vitest
npm run build      # production build into dist/
```

`src/` is laid out like osu!lazer: `app/` (game root, screens, overlays, cursor), `screens/` (menu, song select, player, results), `gameplay/` (judgement rules, drawables, HUD), `beatmap/` (parsing, library, difficulty), `audio/`, `online/` (mirrors), `ui/` (shared widgets).

Before opening a pull request:

1. `npm run typecheck` and `npm test` pass (CI runs both, plus a build).
2. Gameplay changes keep judgement and scoring faithful to osu!. Add a test in `tests/gameplay/` where you can.
3. Visual changes come with a screenshot or short clip in the PR.
4. Keep PRs focused. One fix or feature per PR is easiest to review.

## Looking for something to do?

Check the issues labelled [good first issue](https://github.com/mostlime12195/wosu/labels/good%20first%20issue) and [help wanted](https://github.com/mostlime12195/wosu/labels/help%20wanted).
