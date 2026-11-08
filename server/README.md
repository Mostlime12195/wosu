# wosu! online API

Accounts, score submission and global leaderboards for the site. One Node 22+ process, no dependencies: `node:sqlite` for the database and plain files for replays.

```bash
WOSU_DATA=/var/lib/wosu PORT=3100 node --no-warnings=ExperimentalWarning server/index.mjs
```

- `WOSU_DATA` (default `./data`): `wosu.sqlite` plus `replays/<score id>.bin`. Back this directory up; nothing else holds state.
- Listens on 127.0.0.1 only. Put it behind the static site's reverse proxy at `/api/*` and forward `X-Forwarded-Proto` so the session cookie is marked `Secure`.
- Sessions are HttpOnly cookies scoped to `/api`, 180 days. Passwords are scrypt-hashed. State-changing requests must come from the site's own origin.
- Rate limits: 5 accounts created per hour per IP, 20 sign-ins per 10 minutes per IP, 60 submissions per 10 minutes per account.

Optional environment:

- `SITE_URL` (default `https://wosu.dino.icu`): the origin links in emails point at.
- `RESEND_API_KEY` + `MAIL_FROM` (e.g. `wosu! <noreply@wosu.dino.icu>`): enables verification mails and password resets through [Resend](https://resend.com). Without them addresses are stored unverified and resets answer 503.

Moderation: `node server/admin.mjs role <name> admin` makes the first admin; admins promote mods in-game (profile page → Moderation) or with the same command. `admin.mjs users|mods|log|restrict|unrestrict|delete-score` cover the rest from a shell.

Routes are listed at the top of `index.mjs`; `tests/server/api.test.ts` runs the whole thing against a temporary data directory.

Honest caveat: scores are what the client reports. The replay is stored with each one, so a wrong-looking score can be checked (and deleted from the database) by hand; server-side replay verification is a later step.
