# CollectScan 

### What I Built

I wanted to build a clean, mobile-first web app that solves a very specific headache for collectors: keeping track of what you own so you don't accidentally buy the exact same card or figure twice at a convention or store.

Since it's built entirely in vanilla HTML, CSS, and JavaScript with zero backend bloat, it runs instantly right in your browser and stores everything securely in `localStorage`.

Key features include:

* **Duplicate Warning System:** A live check built into the manual add form that alerts you if you're about to log an item with a name you already own.
* **Smart Collection View:** Filter, search, and sort your items by category (Cards, Cars, Lego, Figurines), condition, or favourites.
* **Offline Photo Handling:** Snap a photo using your device camera or upload one directly to attach to your item profile.
* **Instant Stats Dashboard:** Clean breakdowns of your total collection size, category distribution, autographed counts, and a dedicated possible-duplicates callout.
* **Sample Data Loader:** A quick option to populate the app with demo items so you can test out the UI immediately without starting from scratch.

---

### How to Use It (As a Regular User)

You can check out the live site here: **[Link to GitHub Pages View]** *(or run it locally below)*.

1. **Getting Started:** When you first open the app, tap the **"Load sample items"** link on the home screen to populate some demo cards and figurines, or jump straight into **Manual Add** to log your own items.
2. **Cataloguing an Item:** Tap **Manual Add**, fill in the item details (name, category, condition, price, and notes), and attach a photo if you have one. If the name matches something you already own, the app will flag it.
3. **Managing Your Collection:** Head over to the **Collection** tab to search and filter through your items. Tap any item to view its full details, toggle your favourites, add extra photos, or edit/delete entries.
4. **Checking Stats:** Tap the **Stats** tab to see a breakdown of your items by category, total value/count, and any potential duplicate risks.

---

### Running It Locally (For Developers)

If you want to run or test the prototype locally on your machine:

1. Clone or download this repository:
```bash
git clone https://github.com/[your-username]/collectscan.git

```


2. Navigate into the folder and start a tiny local server to avoid browser `file://` security quirks:
```bash
python3 -m http.server 8000

```


3. Open your browser and go to `http://localhost:8000`.

---

### Tech Stack

* **Frontend:** Vanilla HTML5, CSS3 (Mobile-first, pill-button design system)
* **Logic:** Pure JavaScript (ES6 Classes: `Item`, `CollectionStore`, `ProfileStore`, and `CollectScanApp`)
* **Storage:** Browser `localStorage`