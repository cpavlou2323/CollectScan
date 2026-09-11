# CollectScan

CollectScan, VCE Applied Computing Unit 3&4 SAT project (Unit 3 + Unit 4 Outcome 1). A browser based app for cataloguing collectables (cards, cars, Lego, figurines), scan or add items, avoid buying duplicates, and see stats on your collection. No install.

## What it does

- Log items by hand, or take a photo and let an AI model (Gemini) fill in the name, series and year and so on for you
- Warns you if you're about to add something you already have, checking as soon as a name shows up, whether you typed it or it came from a photo
- Search, sort, and filter your collection by category, condition, or favourites
- A stats page showing totals, a category breakdown, and a callout for possible duplicates
- Accounts, so your collection is tied to you and follows you between devices instead of living in one browser
- A shareable link if you want someone else to see your collection without needing to log in

## How it's built

The frontend is plain HTML, CSS and JavaScript, no frameworks, and is hosted for free on GitHub Pages. The backend is a small Node/Express server with a SQLite database, running on a Raspberry Pi at home, exposed to the internet through a Cloudflare Tunnel rather than opening up my router. Photos are stored as base64 in the database, and the AI photo identification calls Google's Gemini API.

## Using the live site

The app is live at `https://cpavlou2323.github.io/CollectScan/`. Create an account, then either tap Scan to photograph an item and auto-fill the details, or Manual Add to type them in yourself. Everything gets saved to your account, viewable from the Collection tab, and summarised on the Stats tab.

## Running it yourself

The frontend and backend are separate pieces, so both need to be running for the app to actually work end to end.

**Backend**
```bash
cd Backend
npm install
cp .env.example .env   # fill in JWT_SECRET and GEMINI_API_KEY
node server.js
```
This runs on `http://localhost:3001` by default.

**Frontend**

Open `index.html` directly, or serve it with any static server, for example:
```bash
python3 -m http.server 8000
```
Then update the `API_BASE` constant near the top of `app.js` to point at wherever your backend is actually running.

## Project structure

```
index.html, style.css, app.js   frontend files
Backend/                        Express server, SQLite database, and the routes for auth, items, AI identify, and the public share view
setup_notes.txt                 my own notes on how I set the whole thing up and deployed it, kept for reference
```
