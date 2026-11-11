# 🚕 Apa TAXI

A Hungarian-style taximeter for dad's unpaid family chauffeur service. Open it in the Tesla browser (or any phone or tablet), press **INDULÁS**, and the meter charges the family at real Budapest taxi rates. At the end you get a receipt ("nyugta"), and every trip goes onto the family's running tab ("családi tartozás").

## How the fare works

It uses the Budapest regulated tariff that has applied since 1 August 2026:

| | |
|---|---|
| Alapdíj (base fee) | 1300 Ft |
| Km-díj (per km) | 521 Ft/km |
| Percdíj / várakozás (per minute) | 130 Ft/perc |

Like a real Hungarian taximeter, it charges **per km above the changeover speed** and **per minute below it**. The changeover speed is percdíj × 60 / km-díj, about 15 km/h, so standing at a red light or crawling in traffic is billed by time. You can change all the rates in ⚙ Settings.

## Features

- Live fare, trip time, distance, speed and waiting time, all from the browser's GPS
- Taxi lamp that switches between SZABAD, FOGLALT and SZÜNET
- Pause and resume, plus a receipt with silly payment options ("1 db ölelés", "Mosogatás (1 hét)"…)
- Trip log with the total the family owes, kept in the browser's localStorage
- A list of passenger names (⚙ Settings, one per line); tap a name on the main screen to pick who is riding
- Custom rates and an optional beep
- **Demo mode** for trying it at home without driving: ⚙ → Demó mód, or open `?demo=1`
- Keeps the screen awake while the meter runs, and resumes after a page reload

## Hosting (needed for the Tesla)

Browsers only give GPS to pages served over **HTTPS**. The app is plain static files (`index.html`, `style.css`, `app.js`) with no build step, so GitHub Pages works:

1. Repo → **Settings → Pages** → Source: *Deploy from a branch* → choose the branch and `/ (root)` → Save.
2. After about a minute it's live at `https://<username>.github.io/apa-taxi/`.
3. In the Tesla, open the browser, go to that URL, allow location access, and bookmark it.

On a free GitHub plan, Pages needs the repo to be public. If you don't want that, Netlify Drop and Cloudflare Pages also work: just upload the folder.

To run it locally: `python3 -m http.server`, then open http://localhost:8000/?demo=1

*Only for family jokes. Please don't play with the screen while driving* 😄
