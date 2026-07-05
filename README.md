# Mien-HYLO

The public release of Mien — a personal dashboard for sleep, finance, productivity, and weekend planning, all in one place, powered by Claude. Runs entirely on your own machine; your data never leaves it.

## What's inside

- **Health** — Apple Watch sleep + workouts, recovery score, wind-down timer
- **Finance** — Watchlist, symbols-only Robinhood CSV import, AI analysis, news + YouTube feeds with deep summaries
- **Productivity** — AI-planned daily schedule, weather-aware planning, Notion task sync
- **Weekend** — AI itineraries with Celsius weather previews, events, saved restaurants, saved places, and a location map
- **Chat** — Claude with your data as context
- **Mobile companion** — iPhone app reads from the same data

## Install

See **[SETUP.md](./SETUP.md)**. About 15 minutes.

## How it works

Each person runs their own copy. The desktop app stores everything in a local SQLite file. A small relay process proxies AI calls and lets your phone reach your laptop's data over a Cloudflare tunnel. No shared servers, no telemetry, no accounts.

Architecture details: [CLAUDE.md](./CLAUDE.md).

More documentation: [docs/README.md](./docs/README.md).

## License

MIT — see [LICENSE](./LICENSE).
