# Development

See also: [engine dev](../../services/engine/docs/development.md).

## Running

```sh
pnpm dev
```

Starts Vite on `:5173` pointing to the default engine URL (`http://localhost:17777`).

To use a local engine discovered via the running signal:

```sh
pnpm dev --local engine
```

`apps/web/scripts/dev.ts` watches `services/engine/.data/running.json` (via `fs.watch`, no timeout) to discover the engine URL, then sets `ENGINE_URL` before invoking Vite. Start the engine first — the web script will wait until it appears.

To run Vite in true standalone mode without the engine (bypassing the running-signal wrapper):

```sh
ENGINE_URL=http://localhost:18000 pnpm vite
```

## Environment variables

| Variable     | Default                  | Description                        |
| ------------ | ------------------------ | ---------------------------------- |
| `ENGINE_URL` | `http://localhost:17777` | Engine base URL used by Vite proxy |
