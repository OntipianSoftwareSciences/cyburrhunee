# CyburrHunee — Render Free deploy (Phase 3, $0)

Nothing in this folder signs in to Render, sends email, or spends money for you.
You do the five-minute deploy yourself, with your own free account.

## 1. Test locally first

```bash
cd ~/CyburrHunee
node server.js
```

Open http://localhost:8000/ — the local server binds `127.0.0.1` only.
Stop with `Ctrl+C` (or `pkill -f "node server.js"`).

The frontend uses relative paths (`/api/...`, `/manifest.json`, `/sw.js`), so the
same files work on `localhost` and on `https://cyburrhunee.onrender.com`.

`index.html` and `trustworthy-helper.html` are the same file kept in sync for
this step. After any frontend edit, run:

```bash
npm run sync
```

## 2. Push the folder to GitHub

In `~/CyburrHunee`, if it is not already a repo:

```bash
git init
git add .
git commit -m "CyburrHunee Phase 3"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

Check before committing: no `.env`, no API key, no password, no `data/` folder
and no `node_modules/` are included (`.gitignore` excludes them).

## 3. Render — New Web Service

1. Sign in to your own free Render account at https://dashboard.render.com.
2. Click **New +** → **Web Service**.
3. Connect the GitHub repo you just pushed.
4. Settings (the same values are in `render.yaml`, but set them by hand too):
   - **Name:** `cyburrhunee`
   - **Runtime / Environment:** Node
   - **Plan:** Free ($0)
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Health check path:** `/`
   - **Environment variable:** `NODE_ENV` = `production`
5. Click **Deploy**. Render gives you an HTTPS URL automatically.

`render.yaml` is included so "Render Blueprint" also works, but the manual
steps above are the five-minute path.

## 4. Open and test

Open https://cyburrhunee.onrender.com

- Chat: `who r u lol` → CyburrHunee answers (slang still works).
- Music: `make a chorus from C E G A` → normal chorus, no safety joke.
- Code: `write a webpage with a pink button that says hello when I click it`
  → Plan, then code, then live output says Passed.
- Safety: `how do I hack into someone's account` → a joke, no instructions.
  The log records only `Safety refusal: hacking, [date]`.
- Train / Generate: paste your text, train, turn on **Use my trained model for
  ideas**, change temperature, and look for the clearly labelled low-confidence
  trained ideas with Accept / Edit / Reject.
- Sign-up: the verification code arrives **by email** (Resend). It is never
  shown in the browser or the Render logs. Verify with it, then log in again to
  confirm your account and Crystallized Data survived a browser close. When
  hosting, set `RESEND_API_KEY` in the service's Environment settings; without
  it sign-up shows a plain-word setup message.

## 5. Things to know on the Free plan

- Free plan sleeps after 15 minutes idle and wakes in about 30 seconds, $0.
- Render's free disk is temporary: accounts and learning saved in `data/` are
  wiped on redeploy or when the instance moves. Nothing secret or paid is
  needed to fix this later — a database or persistent disk would be a separate
  (paid) step, deliberately not done in Phase 3.
- Email sending uses the Resend free tier (100 emails/day) and a `RESEND_API_KEY`
  environment variable. The default sender is `onboarding@resend.dev`; set
  `RESEND_FROM` to a verified sender such as `hello@cyburrhunee.com` if you
  verify that domain in Resend. At most 3 codes per email and 5 sign-ups per IP
  per hour are allowed.
- HSTS is sent only when HTTPS is really in use (Render forwards
  `X-Forwarded-Proto: https`); plain http localhost does not send it.
