'use strict';

// CollectScan, vanilla JS, no libraries
// talks to the CollectScan backend for accounts, item storage and AI identify

// change this to your deployed backend's URL once it's hosted somewhere --
// localhost only works while you're testing on your own computer
const API_BASE = 'https://collectscan.projectninetyone.com/api';

const TOKEN_KEY = 'collectscan_token'; // item data now lives on the server, just the login token stays local
const CATEGORIES = ['Cards', 'Cars', 'Lego', 'Figurines', 'Other'];
const CONDITIONS = ['New', 'Used', 'Graded', 'Loose', 'Damaged'];
const MAX_IMAGE_DIMENSION = 1280; // keeps card detail and text readable, still small enough to store and upload quickly
const IMAGE_QUALITY = 0.85;

// talks to the backend. holds the login token and does the fetch/json boilerplate
class ApiClient {
  #token;

  constructor() {
    // load any saved token straight away, so a page refresh doesn't log the user out
    this.#token = localStorage.getItem(TOKEN_KEY) || null;
  }

  get isLoggedIn() { return Boolean(this.#token); }

  // called after login/signup, and with null on logout
  setToken(token) {
    this.#token = token;
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  // every API call goes through here, so auth headers and error handling only need to be written once
  async #request(path, options = {}) {
    const hadToken = Boolean(this.#token);
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;

    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    } catch (err) {
      throw new Error("couldn't reach the server, is the backend running?");
    }

    let body = null;
    try { body = await res.json(); } catch (err) { /* e.g. a 204 with no body */ }

    // a 401 on a request that carried a token means the session expired, so log out.
    // a 401 with no token (a login/signup attempt) is just wrong credentials, and
    // the backend's own message ("incorrect email or password") is more useful.
    if (res.status === 401 && hadToken) {
      this.setToken(null);
      throw new Error('signed out, please log in again');
    }

    if (!res.ok) throw new Error((body && body.error) || `request failed (${res.status})`);
    return body;
  }

  // one-line wrappers, each just names an endpoint so the rest of the app
  // never has to build a URL or think about auth headers itself
  signup(email, password, displayName) {
    return this.#request('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, displayName }) });
  }
  login(email, password) {
    return this.#request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  }
  getProfile() { return this.#request('/me'); }
  setProfile(displayName) { return this.#request('/me', { method: 'PUT', body: JSON.stringify({ displayName }) }); }
  getShareInfo() { return this.#request('/me/share'); }
  resetShare() { return this.#request('/me/share/reset', { method: 'POST' }); }
  getPublicCollection(token) { return this.#request('/public/' + encodeURIComponent(token)); }

  getItems() { return this.#request('/items'); }
  createItem(data) { return this.#request('/items', { method: 'POST', body: JSON.stringify(data) }); }
  updateItem(id, changes) { return this.#request(`/items/${id}`, { method: 'PUT', body: JSON.stringify(changes) }); }
  deleteItem(id) { return this.#request(`/items/${id}`, { method: 'DELETE' }); }

  identify(image, mediaType) { return this.#request('/identify', { method: 'POST', body: JSON.stringify({ image, mediaType }) }); }
}

// one collectable
class Item {
  #id;
  #dateAdded;

  constructor(data = {}) {
    this.#id = data.id || Item.#generateId();
    this.#dateAdded = data.dateAdded || new Date().toISOString();

    this.name = data.name || '';
    this.category = CATEGORIES.includes(data.category) ? data.category : 'Other';
    this.series = data.series || '';
    this.year = data.year || '';
    this.condition = data.condition || '';
    this.printNumber = data.printNumber || '';
    this.autograph = Boolean(data.autograph);
    this.favourite = Boolean(data.favourite);
    this.notes = data.notes || '';
    this.images = Array.isArray(data.images) ? data.images : [];
  }

  get id() { return this.#id; }
  get dateAdded() { return this.#dateAdded; }

  // used by the collection search bar, checks name/series/category in one go
  // so the search box doesn't need to know an item's exact field names
  matches(query) {
    if (!query) return true;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      this.name.toLowerCase().includes(q) ||
      this.series.toLowerCase().includes(q) ||
      this.category.toLowerCase().includes(q)
    );
  }

  // turns this back into a plain object for sending to the backend
  toJSON() {
    return {
      id: this.#id,
      dateAdded: this.#dateAdded,
      name: this.name,
      category: this.category,
      series: this.series,
      year: this.year,
      condition: this.condition,
      printNumber: this.printNumber,
      autograph: this.autograph,
      favourite: this.favourite,
      notes: this.notes,
      images: this.images,
    };
  }

  static fromJSON(obj) {
    return new Item(obj);
  }

  // random enough for a personal collection, doesn't need to be a real UUID library
  static #generateId() {
    return 'item_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
}

// all items. keeps a local cache in sync with the backend so the rest of
// the app can still read getAll()/getById()/search() etc. synchronously
class CollectionStore {
  #api;
  #items = [];

  constructor(api) {
    this.#api = api;
  }

  // pulls the full collection down from the backend once, into #items,
  // so the rest of the app can read it instantly without an await every time
  async load() {
    const rows = await this.#api.getItems();
    this.#items = rows.map(Item.fromJSON);
  }

  // a copy of the array, so nothing outside this class can mutate #items directly
  getAll() {
    return [...this.#items];
  }

  getById(id) {
    return this.#items.find((item) => item.id === id) || null;
  }

  // saves to the backend first, only adds it locally once that succeeds
  async add(data) {
    const row = await this.#api.createItem(data);
    const item = Item.fromJSON(row);
    this.#items.push(item);
    return item;
  }

  async update(id, changes) {
    // don't let callers overwrite id / dateAdded
    const { id: _ignoredId, dateAdded: _ignoredDate, ...safeChanges } = changes;
    const row = await this.#api.updateItem(id, safeChanges);
    const updated = Item.fromJSON(row);
    this.#items = this.#items.map((item) => (item.id === id ? updated : item));
    return updated;
  }

  // reuses update() rather than a separate endpoint, an image is just one more field
  async addImage(id, dataUrl) {
    const item = this.getById(id);
    if (!item) return null;
    return this.update(id, { images: [...item.images, dataUrl] });
  }

  async delete(id) {
    await this.#api.deleteItem(id);
    this.#items = this.#items.filter((item) => item.id !== id);
  }

  // used by "clear all test data", deletes one at a time since there's no bulk-delete route
  async clearAll() {
    for (const item of [...this.#items]) await this.delete(item.id);
  }

  // demo items for the "load sample items" link, so a new account isn't a blank page
  async loadSampleData() {
    const now = Date.now();
    const day = 86400000;
    const samples = [
      { name: 'Rookie Sensation', category: 'Cards', series: 'Sample Prospects Set', year: '2025', condition: 'New', printNumber: '07/99', autograph: true, favourite: true, dateAdded: new Date(now - day).toISOString() },
      { name: 'Vintage Racer', category: 'Cars', series: 'Sample Speed Series', year: '1998', condition: 'Used', dateAdded: new Date(now - day * 3).toISOString() },
      { name: 'Classic Brick Set', category: 'Lego', series: 'Sample City Line', year: '2020', condition: 'New', dateAdded: new Date(now - day * 6).toISOString() },
      { name: 'Hero Figure', category: 'Figurines', series: 'Sample Legends', year: '2019', condition: 'Loose', favourite: true, dateAdded: new Date(now - day * 10).toISOString() },
    ];
    for (const sample of samples) await this.add(sample);
  }

  // used to warn about buying something already owned, name match is case/whitespace insensitive
  findDuplicatesOf(name, excludeId = null) {
    const target = (name || '').trim().toLowerCase();
    if (!target) return [];
    return this.#items.filter((item) => item.id !== excludeId && item.name.trim().toLowerCase() === target);
  }

  // backs the Collection screen's search bar and its category/condition filters, all in one pass
  search({ query = '', categories = [], conditions = [] } = {}) {
    return this.#items.filter((item) => {
      const matchesQuery = item.matches(query);
      const matchesCategory = categories.length === 0 || categories.includes(item.category);
      const matchesCondition = conditions.length === 0 || conditions.includes(item.condition);
      return matchesQuery && matchesCategory && matchesCondition;
    });
  }

  // takes a copy rather than sorting in place, so the caller's own array order isn't changed by surprise
  sort(items, sortBy) {
    const sorted = [...items];
    switch (sortBy) {
      case 'name':
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'oldest':
        sorted.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
        break;
      case 'newest':
      default:
        sorted.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
        break;
    }
    return sorted;
  }

  // everything the Stats screen needs, worked out in one place instead of the view doing its own counting
  stats() {
    const total = this.#items.length;
    const byCategory = {};
    for (const cat of CATEGORIES) {
      const count = this.#items.filter((item) => item.category === cat).length;
      if (count > 0) byCategory[cat] = count;
    }
    const favourites = this.#items.filter((item) => item.favourite).length;
    const autographed = this.#items.filter((item) => item.autograph).length;

    const dupMap = new Map();
    for (const item of this.#items) {
      const key = item.name.trim().toLowerCase();
      if (!key) continue;
      if (!dupMap.has(key)) dupMap.set(key, []);
      dupMap.get(key).push(item);
    }
    const duplicateGroups = [...dupMap.values()].filter((group) => group.length > 1);

    return { total, byCategory, favourites, autographed, duplicateGroups };
  }
}

// profile now lives on the server against the account, this just caches it locally
class ProfileStore {
  #api;
  #name = 'Collector';
  #email = '';

  constructor(api) {
    this.#api = api;
  }

  // called once at startup so the greeting/profile menu have a name to show
  async load() {
    const data = await this.#api.getProfile();
    this.#name = data.displayName || 'Collector';
    this.#email = data.email || '';
  }

  get name() { return this.#name; }
  get email() { return this.#email; }

  async setName(name) {
    const clean = (name || '').trim() || 'Collector';
    const data = await this.#api.setProfile(clean);
    this.#name = data.displayName || clean;
  }
}

// browser built-in trick to safely turn user text into HTML, setting textContent
// then reading innerHTML back escapes anything that could otherwise break the page
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// used on item cards with no photo, shows a big letter instead of a broken image
function categoryInitial(category) {
  return (category || '?').charAt(0).toUpperCase();
}

// small hand-drawn line icon set. keeps everything one consistent visual
// style (rounded, single weight, no colour) instead of mixing emoji, which
// render differently on every device and don't match the rest of the ui
const ICON_MARKUP = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  profile: '<circle cx="12" cy="8" r="3.3"/><path d="M5 20c1.4-4.2 4.2-6.3 7-6.3s5.6 2.1 7 6.3"/>',
  home: '<path d="M4 11.5L12 4l8 7.5"/><path d="M6.5 10v9.5H10V15h4v4.5h3.5V10"/>',
  camera: '<rect x="3" y="7" width="18" height="12.5" rx="2.5"/><path d="M8.2 7l1.3-2.3h5l1.3 2.3"/><circle cx="12" cy="13.2" r="3.4"/>',
  collection: '<rect x="4" y="4" width="7" height="7" rx="1.4"/><rect x="13" y="4" width="7" height="7" rx="1.4"/><rect x="4" y="13" width="7" height="7" rx="1.4"/><rect x="13" y="13" width="7" height="7" rx="1.4"/>',
  stats: '<path d="M5 20V11" stroke-width="2.6"/><path d="M12 20V4" stroke-width="2.6"/><path d="M19 20v-7" stroke-width="2.6"/>',
  chevronLeft: '<path d="M14.5 5.5l-6 6.5 6 6.5"/>',
  chevronRight: '<path d="M9.5 5.5l6 6.5-6 6.5"/>',
  star: { line: '<path d="M12 4.5l2.15 4.62 5.1.62-3.75 3.5.98 5.02L12 15.9l-4.48 2.36.98-5.02-3.75-3.5 5.1-.62L12 4.5z"/>', filled: '<path d="M12 4.5l2.15 4.62 5.1.62-3.75 3.5.98 5.02L12 15.9l-4.48 2.36.98-5.02-3.75-3.5 5.1-.62L12 4.5z" fill="currentColor"/>' },
  search: '<circle cx="10.3" cy="10.3" r="6.3"/><path d="M20 20l-4.8-4.8"/>',
  sort: '<path d="M8 5.5v13M8 5.5L5 9M8 5.5l3 3.5"/><path d="M16 18.5v-13M16 18.5l3-3.5M16 18.5l-3-3.5"/>',
  filter: '<line x1="4" y1="6.5" x2="20" y2="6.5"/><circle cx="9" cy="6.5" r="2" fill="currentColor"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2" fill="currentColor"/><line x1="4" y1="17.5" x2="20" y2="17.5"/><circle cx="7" cy="17.5" r="2" fill="currentColor"/>',
  upload: '<path d="M12 16V4M12 4l-4 4M12 4l4 4"/><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3"/>',
  refresh: '<path d="M4.5 9a7.5 7.5 0 0112.7-4.2L19.5 7"/><path d="M19.5 3.8v3.7h-3.7"/><path d="M19.5 15a7.5 7.5 0 01-12.7 4.2L4.5 17"/><path d="M4.5 20.2v-3.7h3.7"/>',
  warning: '<path d="M12 3.5L21 19H3L12 3.5z"/><path d="M12 9.7v4"/><circle cx="12" cy="16.4" r="0.9" fill="currentColor"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 2.3v3M12 18.7v3M2.3 12h3M18.7 12h3"/>',
  share: '<circle cx="6" cy="12" r="2.1"/><circle cx="17.3" cy="5.8" r="2.1"/><circle cx="17.3" cy="18.2" r="2.1"/><path d="M7.9 10.8l7.5-3.9M7.9 13.2l7.5 3.9"/>',
  copy: '<rect x="8.3" y="8.3" width="11" height="11" rx="2"/><path d="M4.7 15.7V6.7a2 2 0 012-2h9"/>',
  check: '<path d="M5 12.5l4.4 4.4L19 7.3"/>',
  crate: '<path d="M3 8l9-4 9 4-9 4-9-4z"/><path d="M3 8v9l9 4 9-4V8"/><path d="M12 12v9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};

// builds one inline svg icon from the shapes above, "active" swaps in the
// filled version for icons like the star that need a different look when toggled on
function icon(name, opts = {}) {
  const size = opts.size || 20;
  const strokeWidth = opts.strokeWidth || 1.8;
  const entry = ICON_MARKUP[name];
  const inner = (entry && typeof entry === 'object') ? (opts.active ? entry.filled : entry.line) : (entry || '');
  const extraClass = opts.className ? ' ' + opts.className : '';
  return `<svg class="icon icon-${name}${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// splits "data:image/jpeg;base64,xxxx" into its media type and raw base64. the
// identify endpoint wants those as separate fields, same shape the backend's /api/identify route expects
function parseDataUrl(dataUrl) {
  const mediaType = dataUrl.substring(5, dataUrl.indexOf(';'));
  const base64 = dataUrl.split(',')[1];
  return { mediaType, base64 };
}

// shrinks and compresses a photo file before it's stored, keeps the
// longest side within maxDim and re-encodes as jpeg at the given quality
function resizeImageFile(file, maxDim = MAX_IMAGE_DIMENSION, quality = IMAGE_QUALITY) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width >= height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height > width && height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Could not decode image'));
      img.src = event.target.result;
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

// the main class, renders every screen and wires up every button/form on
// the page. #view tracks which screen is currently showing, and #render()
// redraws whichever one that is whenever something changes
class CollectScanApp {
  #api;
  #store;
  #profile;
  #view = 'home';
  #selectedId = null;
  #formMode = 'add';
  #formPrefill = null;
  #toastTimer = null;

  // auth screen state
  #authMode = 'login'; // 'login' | 'signup'
  #authError = null;
  #authDraft = { email: '', password: '', displayName: '' }; // survives a re-render after a failed attempt

  // Collection-view UI state
  #searchQuery = '';
  #sortBy = 'newest';
  #catFilter = [];
  #condFilter = [];
  #panelOpen = null; // 'sort' | 'filter' | null

  // Home-view carousel state
  #homeIndex = 0;

  // Detail-view state
  #detailActiveImg = 0;

  // Form-view working state (photos + toggles being edited)
  #formImages = [];
  #formAutograph = false;
  #formFavourite = false;

  // Scan-view state
  #scanImage = null;
  #cameraStream = null; // live camera feed, while it's on
  #identifying = false;

  constructor() {
    this.#api = new ApiClient();
    this.#store = new CollectionStore(this.#api);
    this.#profile = new ProfileStore(this.#api);
  }

  // called once when the page first loads
  async init() {
    this.#bindStaticControls();

    // a shared collection link looks like ?share=TOKEN, and anyone who opens
    // it sees a read-only view with no login required, whether or not
    // they're already signed in to their own account in this browser
    const shareToken = new URLSearchParams(window.location.search).get('share');
    if (shareToken) {
      await this.#loadPublicView(shareToken);
      return;
    }

    if (this.#api.isLoggedIn) {
      await this.#bootAuthenticated();
    } else {
      this.#goTo('auth');
    }
  }

  // hides every normal screen and shows only the read-only public view,
  // used instead of the usual login-gated flow when a share link is opened
  async #loadPublicView(token) {
    document.body.classList.add('public-mode');
    const views = ['auth', 'home', 'collection', 'detail', 'form', 'scan', 'stats', 'public'];
    for (const v of views) document.getElementById('view-' + v).hidden = v !== 'public';

    const container = document.getElementById('view-public');
    container.innerHTML = `<p class="hint-text">Loading collection\u2026</p>`;
    try {
      const data = await this.#api.getPublicCollection(token);
      this.#renderPublicCollection(data);
    } catch (err) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">${icon('crate', { size: 24 })}</div>
          <p class="empty-title">This link isn't valid</p>
          <p class="empty-subtitle">${escapeHTML(err.message || "That share link doesn't exist any more.")}</p>
          <a class="btn" href="${window.location.pathname}">Go to CollectScan</a>
        </div>
      `;
    }
  }

  // groups the shared collection by category, same layout as the normal
  // Collection screen but built from plain data with no click handlers at all
  #renderPublicCollection(data) {
    const container = document.getElementById('view-public');
    const items = data.items || [];
    const groups = CATEGORIES
      .map((cat) => ({ cat, list: items.filter((item) => item.category === cat) }))
      .filter((group) => group.list.length > 0);

    const body = items.length === 0
      ? `<p class="empty-subtitle" style="text-align:center;">This collection is empty so far.</p>`
      : groups.map((group) => `
          <div class="category-group">
            <span class="pill pill-dark">${escapeHTML(group.cat)} &middot; ${group.list.length}</span>
            <div class="item-grid">
              ${group.list.map((item) => this.#publicItemCardHTML(item)).join('')}
            </div>
          </div>
        `).join('');

    container.innerHTML = `
      <div class="public-header">
        <span class="pill pill-dark">${escapeHTML(data.displayName || 'Collector')}'s Collection</span>
        <a class="muted-link" href="${window.location.pathname}">Log in to CollectScan</a>
      </div>
      ${body}
    `;
  }

  // a stripped-down version of #itemCardHTML, no edit/favourite/delete
  // controls, since a visitor with just the link can't own this collection
  #publicItemCardHTML(item) {
    const thumb = item.images && item.images[0]
      ? `<img src="${item.images[0]}" alt="">`
      : categoryInitial(item.category);
    return `
      <div class="item-card" style="cursor:default;">
        <div class="item-thumb">
          ${thumb}
          ${item.favourite ? `<span class="fav-badge">${icon('star', { size: 11, active: true })}</span>` : ''}
        </div>
        <div class="item-meta">
          <p class="item-name">${escapeHTML(item.name || 'Untitled item')}</p>
          ${item.series ? `<p class="item-series">${escapeHTML(item.series)}</p>` : ''}
        </div>
      </div>
    `;
  }

  // after a fresh login/signup, or on startup with a token already saved
  async #bootAuthenticated() {
    try {
      await Promise.all([this.#store.load(), this.#profile.load()]);
      this.#goTo('home');
    } catch (err) {
      // saved token is probably stale or expired, so go back to the login screen
      this.#api.setToken(null);
      this.#authError = null;
      this.#goTo('auth');
    }
  }

  // switches which screen is showing, every button that changes screens goes through this
  #goTo(view, opts = {}) {
    if (this.#view === 'scan' && view !== 'scan') this.#stopCamera(); // turn the camera off if we leave scan
    this.#view = view;
    if ('selectedId' in opts) this.#selectedId = opts.selectedId;
    if (view === 'form') {
      this.#formMode = opts.formMode || 'add';
      this.#formPrefill = opts.formPrefill || null;
    }
    if (view === 'collection') {
      this.#panelOpen = null;
    }
    this.#render();
  }

  // sets up the parts of the page that only need doing once, the top bar and
  // nav icons (filled in here rather than hardcoded as emoji), and their clicks
  #bindStaticControls() {
    document.getElementById('back-btn').innerHTML = icon('back', { size: 16 });
    document.getElementById('profile-btn').innerHTML = icon('profile', { size: 16 });
    for (const el of document.querySelectorAll('[data-icon]')) {
      el.innerHTML = icon(el.dataset.icon, { size: 18 });
    }

    document.getElementById('back-btn').addEventListener('click', () => this.#goTo('home'));
    document.getElementById('profile-btn').addEventListener('click', () => this.#openProfileModal());

    const navButtons = document.querySelectorAll('#bottom-nav .nav-btn');
    for (const btn of navButtons) {
      btn.addEventListener('click', () => this.#goTo(btn.dataset.view));
    }
  }

  // login / signup screen

  #renderAuth() {
    const container = document.getElementById('view-auth');
    const mode = this.#authMode;
    const draft = this.#authDraft;

    container.innerHTML = `
      <div class="auth-wrap">
        <p class="auth-title">CollectScan</p>
        <p class="auth-subtitle">${mode === 'login' ? 'Log in to your collection' : 'Create your account'}</p>
        ${this.#authError ? `<p class="auth-error">${escapeHTML(this.#authError)}</p>` : ''}
        ${mode === 'signup' ? `
          <div class="field">
            <label>Display name</label>
            <input type="text" id="auth-name" placeholder="What should we call you?" value="${escapeHTML(draft.displayName)}">
          </div>
        ` : ''}
        <div class="field">
          <label>Email</label>
          <input type="text" id="auth-email" placeholder="you@example.com" value="${escapeHTML(draft.email)}">
        </div>
        <div class="field">
          <label>Password</label>
          <input type="password" id="auth-password" placeholder="At least 8 characters" value="${escapeHTML(draft.password)}">
        </div>
        <button class="btn btn-block" id="auth-submit">${mode === 'login' ? 'Log In' : 'Sign Up'}</button>
        <p class="auth-switch">
          ${mode === 'login' ? "New here?" : 'Already have an account?'}
          <button id="auth-switch-btn">${mode === 'login' ? 'Create an account' : 'Log in'}</button>
        </p>
      </div>
    `;

    document.getElementById('auth-switch-btn').addEventListener('click', () => {
      this.#authMode = mode === 'login' ? 'signup' : 'login';
      this.#authError = null;
      this.#renderAuth();
    });
    document.getElementById('auth-submit').addEventListener('click', () => this.#submitAuth());

    // enter key submits, same as tapping the button
    container.querySelectorAll('input').forEach((input) => {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.#submitAuth(); });
    });
  }

  // handles both login and signup, since they share the same form and just call a different endpoint
  async #submitAuth() {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const nameField = document.getElementById('auth-name');
    const displayName = nameField ? nameField.value.trim() : '';

    // keep whatever was typed so a failed attempt doesn't wipe the form
    this.#authDraft = { email, password, displayName };

    if (!email || !password) {
      this.#authError = 'Enter an email and password.';
      this.#renderAuth();
      return;
    }

    const submitBtn = document.getElementById('auth-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Please wait\u2026';

    try {
      const result = this.#authMode === 'login'
        ? await this.#api.login(email, password)
        : await this.#api.signup(email, password, displayName);
      this.#api.setToken(result.token);
      this.#authError = null;
      this.#authDraft = { email: '', password: '', displayName: '' };
      await this.#bootAuthenticated();
    } catch (err) {
      this.#authError = err.message;
      this.#renderAuth();
    }
  }

  // shows/hides the right screen and picks which #render*() method draws it,
  // called after almost every action that changes what's on screen
  #render() {
    const titleEl = document.getElementById('top-bar-title');
    document.body.classList.toggle('auth-mode', this.#view === 'auth');

    const views = ['auth', 'home', 'collection', 'detail', 'form', 'scan', 'stats', 'public'];
    for (const v of views) {
      document.getElementById('view-' + v).hidden = v !== this.#view;
    }

    const navButtons = document.querySelectorAll('#bottom-nav .nav-btn');
    for (const btn of navButtons) {
      btn.classList.toggle('active', btn.dataset.view === this.#view);
    }

    switch (this.#view) {
      case 'auth':
        titleEl.textContent = 'CollectScan';
        this.#renderAuth();
        break;
      case 'home':
        titleEl.textContent = 'Hello, ' + this.#profile.name;
        this.#renderHome();
        break;
      case 'collection':
        titleEl.textContent = 'Your Collection';
        this.#renderCollection();
        break;
      case 'detail':
        titleEl.textContent = (this.#store.getById(this.#selectedId) || {}).name || 'Item';
        this.#renderDetail();
        break;
      case 'form':
        titleEl.textContent = this.#formMode === 'edit' ? 'Edit Item' : 'Add Item';
        this.#renderForm();
        break;
      case 'scan':
        titleEl.textContent = 'Scan Item';
        this.#renderScan();
        break;
      case 'stats':
        titleEl.textContent = 'Collection Stats';
        this.#renderStats();
        break;
      default:
        titleEl.textContent = 'CollectScan';
    }
  }

  // shows the small black toast message at the bottom of the screen for a couple of seconds
  #notify(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.hidden = false;
    if (this.#toastTimer) clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
  }

  // runs an async store/profile action and shows a toast instead of breaking silently if it fails
  async #safely(action) {
    try {
      await action();
    } catch (err) {
      this.#notify(err.message || 'something went wrong');
    }
  }

  // the Home screen, favourites carousel if there are any, otherwise recent items
  #renderHome() {
    const container = document.getElementById('view-home');
    const items = this.#store.getAll();
    const favourites = items.filter((item) => item.favourite);
    const source = favourites.length ? favourites : items;
    if (this.#homeIndex >= source.length) this.#homeIndex = 0;
    const current = source[this.#homeIndex];

    let stageHTML;
    if (items.length === 0) {
      stageHTML = `
        <div class="hero-box">${icon('crate', { size: 40 })}</div>
        <p class="empty-title">Add your first item today</p>
        <button class="muted-link" id="home-load-sample">or load sample items to explore</button>
      `;
    } else {
      const thumb = current.images[0]
        ? `<img src="${current.images[0]}" alt="">`
        : categoryInitial(current.category);
      stageHTML = `
        <div class="carousel-row">
          <button class="round-btn" id="home-prev" aria-label="Previous">${icon('chevronLeft', { size: 15 })}</button>
          <button class="card-frame" id="home-open-current">${thumb}</button>
          <button class="round-btn" id="home-next" aria-label="Next">${icon('chevronRight', { size: 15 })}</button>
        </div>
        <p class="hint-text">${favourites.length ? 'Favourites' : 'Recently added'} &middot; ${this.#homeIndex + 1}/${source.length}</p>
        <p style="font-size:13px;font-weight:600;margin:0;">${escapeHTML(current.name || 'Untitled item')}</p>
      `;
    }

    container.innerHTML = `
      <div class="home-stage">${stageHTML}</div>
      <div class="home-actions">
        <button class="btn" id="home-manual-add">+ Manual Add</button>
        <button class="scan-fab" id="home-scan">Scan</button>
        <button class="btn" id="home-view-collection">View Collection</button>
      </div>
    `;

    if (items.length === 0) {
      document.getElementById('home-load-sample').addEventListener('click', () => {
        this.#safely(async () => {
          await this.#store.loadSampleData();
          this.#notify('Sample items added');
          this.#render();
        });
      });
    } else {
      document.getElementById('home-prev').addEventListener('click', () => {
        this.#homeIndex = (this.#homeIndex - 1 + source.length) % source.length;
        this.#render();
      });
      document.getElementById('home-next').addEventListener('click', () => {
        this.#homeIndex = (this.#homeIndex + 1) % source.length;
        this.#render();
      });
      document.getElementById('home-open-current').addEventListener('click', () => {
        this.#goTo('detail', { selectedId: current.id });
      });
    }
    document.getElementById('home-manual-add').addEventListener('click', () => this.#goTo('form', { formMode: 'add', formPrefill: null }));
    document.getElementById('home-scan').addEventListener('click', () => this.#goTo('scan'));
    document.getElementById('home-view-collection').addEventListener('click', () => this.#goTo('collection'));
  }

  // the Collection screen's search bar, sort/filter buttons and the empty state,
  // the actual list of items is drawn separately by #renderCollectionResults()
  // so typing in the search box doesn't have to rebuild this whole toolbar
  #renderCollection() {
    const container = document.getElementById('view-collection');
    const items = this.#store.getAll();

    if (items.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">${icon('crate', { size: 24 })}</div>
          <p class="empty-title">Your collection is empty</p>
          <p class="empty-subtitle">Scan an item or add one manually to start building your library.</p>
          <div class="btn-row">
            <button class="btn" id="empty-manual-add">Manual Add</button>
            <button class="btn btn-outline" id="empty-scan">Scan</button>
          </div>
        </div>
      `;
      document.getElementById('empty-manual-add').addEventListener('click', () => this.#goTo('form', { formMode: 'add', formPrefill: null }));
      document.getElementById('empty-scan').addEventListener('click', () => this.#goTo('scan'));
      return;
    }

    const activeFilterCount = this.#catFilter.length + this.#condFilter.length;

    container.innerHTML = `
      <div class="search-bar">
        <span>${icon('search', { size: 16 })}</span>
        <input type="text" id="search-input" placeholder="Search name, series, category" value="${escapeHTML(this.#searchQuery)}">
        ${this.#searchQuery ? `<button id="clear-search" aria-label="Clear search">${icon('close', { size: 12 })}</button>` : ''}
      </div>
      <div class="toolbar-row">
        <button class="toolbar-btn" id="toggle-sort">${icon('sort', { size: 14 })} Sort</button>
        <button class="toolbar-btn" id="toggle-filter">${icon('filter', { size: 14 })} Filter${activeFilterCount ? ' (' + activeFilterCount + ')' : ''}</button>
        ${activeFilterCount ? '<button class="clear-link" id="clear-filters">Clear</button>' : ''}
      </div>
      <div id="panel-slot"></div>
      <div id="results-slot"></div>
    `;

    // keep the search box focused while typing
    const searchInput = document.getElementById('search-input');
    searchInput.addEventListener('input', (e) => {
      this.#searchQuery = e.target.value;
      this.#renderCollectionResults();
      const clearBtn = document.getElementById('clear-search');
      if (this.#searchQuery && !clearBtn) {
        // re-render toolbar area once to show the clear (x) button
        this.#renderCollection();
        document.getElementById('search-input').focus();
      }
    });
    const clearSearchBtn = document.getElementById('clear-search');
    if (clearSearchBtn) {
      clearSearchBtn.addEventListener('click', () => {
        this.#searchQuery = '';
        this.#renderCollection();
      });
    }

    document.getElementById('toggle-sort').addEventListener('click', () => {
      this.#panelOpen = this.#panelOpen === 'sort' ? null : 'sort';
      this.#renderCollectionPanel();
    });
    document.getElementById('toggle-filter').addEventListener('click', () => {
      this.#panelOpen = this.#panelOpen === 'filter' ? null : 'filter';
      this.#renderCollectionPanel();
    });
    const clearFiltersBtn = document.getElementById('clear-filters');
    if (clearFiltersBtn) {
      clearFiltersBtn.addEventListener('click', () => {
        this.#catFilter = [];
        this.#condFilter = [];
        this.#renderCollection();
      });
    }

    this.#renderCollectionPanel();
    this.#renderCollectionResults();
  }

  // the dropdown-style panel under the toolbar, shows sort options or filter
  // chips depending on which button was last pressed, or nothing if neither is open
  #renderCollectionPanel() {
    const slot = document.getElementById('panel-slot');
    if (!slot) return;

    if (this.#panelOpen === 'sort') {
      const options = [
        ['newest', 'Newest first'],
        ['oldest', 'Oldest first'],
        ['name', 'Name A\u2013Z'],
      ];
      slot.innerHTML = `<div class="panel">${options.map(([key, label]) =>
        `<button class="sort-option${this.#sortBy === key ? ' active' : ''}" data-sort="${key}">${label}</button>`
      ).join('')}</div>`;
      for (const btn of slot.querySelectorAll('.sort-option')) {
        btn.addEventListener('click', () => {
          this.#sortBy = btn.dataset.sort;
          this.#panelOpen = null;
          this.#renderCollectionPanel();
          this.#renderCollectionResults();
        });
      }
    } else if (this.#panelOpen === 'filter') {
      const catChips = CATEGORIES.map((cat) =>
        `<button class="chip${this.#catFilter.includes(cat) ? ' active' : ''}" data-cat="${cat}">${cat}</button>`
      ).join('');
      const condChips = CONDITIONS.map((cond) =>
        `<button class="chip${this.#condFilter.includes(cond) ? ' active' : ''}" data-cond="${cond}">${cond}</button>`
      ).join('');
      slot.innerHTML = `
        <div class="panel">
          <p class="panel-label">Category</p>
          <div class="panel-row">${catChips}</div>
          <p class="panel-label">Condition</p>
          <div class="panel-row">${condChips}</div>
        </div>
      `;
      for (const chip of slot.querySelectorAll('[data-cat]')) {
        chip.addEventListener('click', () => {
          const cat = chip.dataset.cat;
          this.#catFilter = this.#catFilter.includes(cat)
            ? this.#catFilter.filter((c) => c !== cat)
            : [...this.#catFilter, cat];
          this.#renderCollectionPanel();
          this.#renderCollectionResults();
        });
      }
      for (const chip of slot.querySelectorAll('[data-cond]')) {
        chip.addEventListener('click', () => {
          const cond = chip.dataset.cond;
          this.#condFilter = this.#condFilter.includes(cond)
            ? this.#condFilter.filter((c) => c !== cond)
            : [...this.#condFilter, cond];
          this.#renderCollectionPanel();
          this.#renderCollectionResults();
        });
      }
    } else {
      slot.innerHTML = '';
    }
  }

  // applies the current search/filter/sort and draws the actual item grid,
  // grouped by category, redrawn on its own whenever any of those change
  #renderCollectionResults() {
    const slot = document.getElementById('results-slot');
    if (!slot) return;

    const filtered = this.#store.search({
      query: this.#searchQuery,
      categories: this.#catFilter,
      conditions: this.#condFilter,
    });
    const sorted = this.#store.sort(filtered, this.#sortBy);

    if (sorted.length === 0) {
      slot.innerHTML = `<p style="text-align:center;color:var(--gray-500);font-size:13px;padding:32px 0;">No items match your search or filters.</p>`;
      return;
    }

    const groups = CATEGORIES
      .map((cat) => ({ cat, list: sorted.filter((item) => item.category === cat) }))
      .filter((group) => group.list.length > 0);

    slot.innerHTML = groups.map((group) => `
      <div class="category-group">
        <span class="pill pill-dark">${group.cat} &middot; ${group.list.length}</span>
        <div class="item-grid">
          ${group.list.map((item) => this.#itemCardHTML(item)).join('')}
        </div>
      </div>
    `).join('');

    for (const card of slot.querySelectorAll('[data-item-id]')) {
      card.addEventListener('click', () => this.#goTo('detail', { selectedId: card.dataset.itemId }));
    }
  }

  // one item tile in the collection grid, falls back to a plain letter if there's no photo yet
  #itemCardHTML(item) {
    const thumb = item.images[0]
      ? `<img src="${item.images[0]}" alt="">`
      : categoryInitial(item.category);
    return `
      <button class="item-card" data-item-id="${item.id}">
        <div class="item-thumb">
          ${thumb}
          ${item.favourite ? `<span class="fav-badge">${icon('star', { size: 11, active: true })}</span>` : ''}
        </div>
        <div class="item-meta">
          <p class="item-name">${escapeHTML(item.name || 'Untitled item')}</p>
          ${item.series ? `<p class="item-series">${escapeHTML(item.series)}</p>` : ''}
        </div>
      </button>
    `;
  }

  // item detail

  #renderDetail() {
    const container = document.getElementById('view-detail');
    const item = this.#store.getById(this.#selectedId);
    if (!item) {
      container.innerHTML = `<p>Item not found.</p>`;
      return;
    }

    const activeImg = this.#detailActiveImg || 0;
    const imageHTML = item.images.length
      ? `<img src="${item.images[Math.min(activeImg, item.images.length - 1)]}" alt="">`
      : categoryInitial(item.category);

    const thumbStrip = item.images.length > 1 ? `
      <div class="thumb-strip">
        ${item.images.map((src, i) => `<button data-img-index="${i}" class="${i === activeImg ? 'active' : ''}"><img src="${src}" alt=""></button>`).join('')}
      </div>` : '';

    const tags = [item.year, item.printNumber, item.condition, item.autograph ? 'Autograph' : '']
      .filter(Boolean)
      .map((tag) => `<span class="pill pill-light">${escapeHTML(tag)}</span>`)
      .join('');

    container.innerHTML = `
      <span class="pill pill-dark">${escapeHTML(item.name || 'Untitled item')}</span>
      ${item.series ? `<span class="pill pill-light">${escapeHTML(item.series)}</span>` : ''}
      <div class="detail-image">
        ${imageHTML}
        <button class="fav-toggle${item.favourite ? ' active' : ''}" id="toggle-fav" aria-label="Toggle favourite">${icon('star', { size: 16, active: item.favourite })}</button>
      </div>
      ${thumbStrip}
      ${tags ? `<div class="tag-row">${tags}</div>` : ''}
      ${item.notes ? `<p class="notes-text">${escapeHTML(item.notes)}</p>` : ''}
      <div class="btn-row">
        <button class="btn" id="detail-edit" style="flex:1;">Edit</button>
        <button class="btn" id="detail-add-photo" style="flex:1;">Add Photos</button>
      </div>
      <input type="file" accept="image/*" id="detail-photo-input" hidden>
      <div id="delete-slot"></div>
    `;

    document.getElementById('toggle-fav').addEventListener('click', () => {
      this.#safely(async () => {
        await this.#store.update(item.id, { favourite: !item.favourite });
        this.#renderDetail();
      });
    });
    if (item.images.length > 1) {
      for (const btn of container.querySelectorAll('[data-img-index]')) {
        btn.addEventListener('click', () => {
          this.#detailActiveImg = Number(btn.dataset.imgIndex);
          this.#renderDetail();
        });
      }
    }
    document.getElementById('detail-edit').addEventListener('click', () => {
      this.#goTo('form', { formMode: 'edit', formPrefill: item });
    });
    document.getElementById('detail-add-photo').addEventListener('click', () => {
      document.getElementById('detail-photo-input').click();
    });
    document.getElementById('detail-photo-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      this.#safely(async () => {
        const dataUrl = await resizeImageFile(file);
        await this.#store.addImage(item.id, dataUrl);
        this.#notify('Photo added');
        this.#renderDetail();
      });
    });

    this.#renderDeleteSlot(item.id);
  }

  // two-step delete, shows a plain button first and only shows the real
  // confirm/cancel prompt once that's pressed, so deleting can't happen by accident
  #renderDeleteSlot(itemId, confirming = false) {
    const slot = document.getElementById('delete-slot');
    if (!slot) return;
    if (!confirming) {
      slot.innerHTML = `<button class="btn btn-danger btn-block" id="delete-item">Delete Item</button>`;
      document.getElementById('delete-item').addEventListener('click', () => this.#renderDeleteSlot(itemId, true));
    } else {
      slot.innerHTML = `
        <div class="confirm-box">
          <p>Delete this item? This can't be undone.</p>
          <div class="btn-row">
            <button class="btn btn-outline" id="cancel-delete" style="flex:1;">Cancel</button>
            <button class="btn btn-danger" id="confirm-delete" style="flex:1;">Confirm Delete</button>
          </div>
        </div>
      `;
      document.getElementById('cancel-delete').addEventListener('click', () => this.#renderDeleteSlot(itemId, false));
      document.getElementById('confirm-delete').addEventListener('click', () => {
        this.#safely(async () => {
          await this.#store.delete(itemId);
          this.#notify('Item deleted');
          this.#goTo('collection');
        });
      });
    }
  }

  // add / edit form

  #renderForm() {
    const container = document.getElementById('view-form');
    const data = this.#formPrefill || {};
    this.#formImages = Array.isArray(data.images) ? [...data.images] : [];
    this.#formAutograph = Boolean(data.autograph);
    this.#formFavourite = Boolean(data.favourite);

    container.innerHTML = this.#formHTML(data);
    this.#bindFormEvents(data);
    // catches the case where a name arrives already filled in (auto-identify,
    // or editing an existing item) rather than typed by hand, so without this,
    // the warning only ever appeared if you edited the name field yourself
    if (data.name) this.#checkDuplicateWarning(data.id);
  }

  // builds the add/edit form markup, shared by both modes, #formMode just changes the button label
  #formHTML(data) {
    const categoryOptions = CATEGORIES.map((c) => `<option value="${c}"${data.category === c ? ' selected' : ''}>${c}</option>`).join('');
    const conditionOptions = `<option value="">Unspecified</option>` + CONDITIONS.map((c) => `<option value="${c}"${data.condition === c ? ' selected' : ''}>${c}</option>`).join('');

    return `
      <div class="field">
        <label>Photos</label>
        <div class="photo-row" id="photo-row"></div>
        <input type="file" accept="image/*" id="upload-input" hidden>
        <input type="file" accept="image/*" capture="environment" id="camera-input" hidden>
      </div>

      <div class="field">
        <label>Name *</label>
        <input type="text" id="field-name" placeholder="e.g. Bruno Fernandes Autograph" value="${escapeHTML(data.name || '')}">
        <p class="field-error" id="name-error" hidden>Name is required.</p>
      </div>
      <div id="dup-warning"></div>

      <div class="field-row">
        <div class="field">
          <label>Category</label>
          <select id="field-category">${categoryOptions}</select>
        </div>
        <div class="field">
          <label>Condition</label>
          <select id="field-condition">${conditionOptions}</select>
        </div>
      </div>

      <div class="field">
        <label>Series / Set</label>
        <input type="text" id="field-series" placeholder="e.g. Topps Premier League 25/26" value="${escapeHTML(data.series || '')}">
      </div>

      <div class="field-row">
        <div class="field">
          <label>Year</label>
          <input type="text" inputmode="numeric" id="field-year" placeholder="e.g. 2025" value="${escapeHTML(data.year || '')}">
          <p class="field-error" id="year-error" hidden></p>
        </div>
        <div class="field">
          <label>Print / Edition #</label>
          <input type="text" id="field-print" placeholder="e.g. 06/50" value="${escapeHTML(data.printNumber || '')}">
        </div>
      </div>

      <div class="toggle-row">
        <button class="toggle-btn${this.#formAutograph ? ' active' : ''}" id="toggle-autograph" type="button">Autograph</button>
        <button class="toggle-btn${this.#formFavourite ? ' active' : ''}" id="toggle-favourite" type="button">${icon('star', { size: 13, active: this.#formFavourite })} Favourite</button>
      </div>

      <div class="field">
        <label>Notes</label>
        <textarea id="field-notes" rows="3" placeholder="Any extra details worth remembering">${escapeHTML(data.notes || '')}</textarea>
      </div>

      <div class="btn-row">
        <button class="btn btn-outline" id="form-cancel" style="flex:1;">Cancel</button>
        <button class="btn" id="form-save" style="flex:1;">${this.#formMode === 'edit' ? 'Save Changes' : 'Save Item'}</button>
      </div>
    `;
  }

  // redraws just the photo thumbnails plus the upload/camera buttons, kept
  // separate from the rest of the form so adding/removing a photo doesn't
  // have to rebuild every other field and lose whatever the user was typing
  #renderPhotoRow() {
    const row = document.getElementById('photo-row');
    if (!row) return;
    row.innerHTML = this.#formImages.map((src, i) => `
      <div class="photo-thumb">
        <img src="${src}" alt="">
        <button class="photo-remove" data-remove-index="${i}" aria-label="Remove photo">${icon('close', { size: 10 })}</button>
      </div>
    `).join('') + `
      <button class="photo-add" id="photo-upload-btn" type="button">${icon('upload', { size: 17 })}<span>Upload</span></button>
      <button class="photo-add" id="photo-camera-btn" type="button">${icon('camera', { size: 17 })}<span>Camera</span></button>
    `;
    for (const btn of row.querySelectorAll('[data-remove-index]')) {
      btn.addEventListener('click', () => {
        this.#formImages.splice(Number(btn.dataset.removeIndex), 1);
        this.#renderPhotoRow();
      });
    }
    document.getElementById('photo-upload-btn').addEventListener('click', () => document.getElementById('upload-input').click());
    document.getElementById('photo-camera-btn').addEventListener('click', () => document.getElementById('camera-input').click());
  }

  // wires up every control on the add/edit form, photo handling, toggles,
  // typing the name (which re-checks for a duplicate), and the save/cancel buttons
  #bindFormEvents(data) {
    this.#renderPhotoRow();

    const handleFile = async (file) => {
      if (!file) return;
      try {
        const dataUrl = await resizeImageFile(file);
        this.#formImages.push(dataUrl);
        this.#renderPhotoRow();
      } catch (err) {
        this.#notify("Couldn't read that photo");
      }
    };
    document.getElementById('upload-input').addEventListener('change', (e) => {
      handleFile(e.target.files[0]);
      e.target.value = '';
    });
    document.getElementById('camera-input').addEventListener('change', (e) => {
      handleFile(e.target.files[0]);
      e.target.value = '';
    });

    const nameInput = document.getElementById('field-name');
    nameInput.addEventListener('input', () => this.#checkDuplicateWarning(data.id));
    document.getElementById('toggle-autograph').addEventListener('click', () => {
      this.#formAutograph = !this.#formAutograph;
      document.getElementById('toggle-autograph').classList.toggle('active', this.#formAutograph);
    });
    document.getElementById('toggle-favourite').addEventListener('click', () => {
      this.#formFavourite = !this.#formFavourite;
      const btn = document.getElementById('toggle-favourite');
      btn.classList.toggle('active', this.#formFavourite);
      btn.innerHTML = `${icon('star', { size: 13, active: this.#formFavourite })} Favourite`;
    });
    document.getElementById('form-cancel').addEventListener('click', () => this.#goTo('collection'));
    document.getElementById('form-save').addEventListener('click', () => this.#submitForm(data.id));
  }

  // the core duplicate-purchase warning, called both while typing the name and
  // once right after the form loads (see #renderForm), since a name arriving
  // pre-filled from Auto-Identify never fires a typing event on its own
  #checkDuplicateWarning(currentId) {
    const name = document.getElementById('field-name').value;
    const dups = this.#store.findDuplicatesOf(name, currentId || null);
    const slot = document.getElementById('dup-warning');
    if (dups.length > 0) {
      slot.innerHTML = `
        <div class="confirm-box amber">
          <p>You already have ${dups.length} item${dups.length > 1 ? 's' : ''} named "${escapeHTML(name.trim())}". Check your collection before buying another.</p>
        </div>
      `;
    } else {
      slot.innerHTML = '';
    }
  }

  // validates the name (existence check) and year (type + range check) before
  // saving, this is the only place both checks are enforced, so nothing can
  // reach the backend with an empty name or a year that isn't a real year
  async #submitForm(existingId) {
    const name = document.getElementById('field-name').value.trim();
    const nameInput = document.getElementById('field-name');
    const errorEl = document.getElementById('name-error');

    if (!name) {
      nameInput.classList.add('invalid');
      errorEl.hidden = false;
      return;
    }
    nameInput.classList.remove('invalid');
    errorEl.hidden = true;

    // year is optional, but if the person does enter something it has to actually
    // be a plausible year, this is the type check + range check the field needs.
    // trading cards and toys can carry a print year, but nothing before 1900 or
    // more than a year into the future makes sense for a real physical item
    const yearInput = document.getElementById('field-year');
    const yearError = document.getElementById('year-error');
    const yearRaw = yearInput.value.trim();
    const currentYear = new Date().getFullYear();

    if (yearRaw && (!/^\d{4}$/.test(yearRaw) || Number(yearRaw) < 1900 || Number(yearRaw) > currentYear + 1)) {
      yearInput.classList.add('invalid');
      yearError.textContent = `Enter a 4-digit year between 1900 and ${currentYear + 1}.`;
      yearError.hidden = false;
      return;
    }
    yearInput.classList.remove('invalid');
    yearError.hidden = true;

    const formData = {
      id: existingId || undefined,
      name,
      category: document.getElementById('field-category').value,
      condition: document.getElementById('field-condition').value,
      series: document.getElementById('field-series').value.trim(),
      year: yearRaw,
      printNumber: document.getElementById('field-print').value.trim(),
      autograph: this.#formAutograph,
      favourite: this.#formFavourite,
      notes: document.getElementById('field-notes').value.trim(),
      images: this.#formImages,
    };

    const saveBtn = document.getElementById('form-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving\u2026';

    try {
      let savedItem;
      if (this.#formMode === 'edit' && existingId) {
        savedItem = await this.#store.update(existingId, formData);
        this.#notify('Changes saved');
      } else {
        savedItem = await this.#store.add(formData);
        this.#notify('Item added');
      }
      this.#detailActiveImg = 0;
      this.#goTo('detail', { selectedId: savedItem.id });
    } catch (err) {
      this.#notify(err.message || 'something went wrong');
      saveBtn.disabled = false;
      saveBtn.textContent = this.#formMode === 'edit' ? 'Save Changes' : 'Save Item';
    }
  }

  // scan screen

  #renderScan() {
    const container = document.getElementById('view-scan');
    const image = this.#scanImage || null;

    // live camera is on, so show the video feed and a shutter button
    if (this.#cameraStream) {
      container.innerHTML = `
        <p class="hint-text">Line it up, then tap the button to take the photo.</p>
        <div class="scan-preview" id="scan-preview"><video id="camera-video" autoplay playsinline muted></video></div>
        <div class="camera-controls">
          <button class="icon-btn" id="camera-cancel" aria-label="Cancel">${icon('close', { size: 14 })}</button>
          <button class="shutter-btn" id="camera-shutter" aria-label="Take photo"></button>
          <span class="shutter-spacer"></span>
        </div>
      `;
      const video = document.getElementById('camera-video');
      video.srcObject = this.#cameraStream;
      document.getElementById('camera-shutter').addEventListener('click', () => this.#capturePhoto(video));
      document.getElementById('camera-cancel').addEventListener('click', () => {
        this.#stopCamera();
        this.#renderScan();
      });
      return;
    }

    container.innerHTML = `
      <p class="hint-text">Capture or upload a photo of your collectable, then confirm the details.</p>
      <div class="scan-preview" id="scan-preview">${image ? `<img src="${image}" alt="">` : icon('camera', { size: 28 })}</div>
      ${!image ? `
        <div class="btn-row">
          <button class="btn" id="scan-take" style="flex:1;">Take Photo</button>
          <button class="btn btn-outline" id="scan-upload" style="flex:1;">Upload Photo</button>
        </div>
      ` : `
        <button class="muted-link" id="scan-retake" style="align-self:center;" ${this.#identifying ? 'disabled' : ''}>${icon('refresh', { size: 13 })} Retake photo</button>
        <button class="btn btn-block" id="scan-identify" ${this.#identifying ? 'disabled' : ''}>
          ${this.#identifying ? 'Identifying\u2026' : icon('target', { size: 14 }) + ' Auto-Identify with AI'}
        </button>
        <button class="muted-link" id="scan-continue" style="align-self:center;" ${this.#identifying ? 'disabled' : ''}>Skip, enter details manually</button>
      `}
      <input type="file" accept="image/*" capture="environment" id="scan-camera-input" hidden>
      <input type="file" accept="image/*" id="scan-upload-input" hidden>
    `;

    const handleFile = async (file) => {
      if (!file) return;
      try {
        this.#scanImage = await resizeImageFile(file);
        this.#renderScan();
      } catch (err) {
        this.#notify("Couldn't read that photo");
      }
    };

    if (!image) {
      document.getElementById('scan-take').addEventListener('click', () => this.#startCamera());
      document.getElementById('scan-upload').addEventListener('click', () => document.getElementById('scan-upload-input').click());
    } else {
      document.getElementById('scan-retake').addEventListener('click', () => {
        this.#scanImage = null;
        this.#renderScan();
      });
      document.getElementById('scan-identify').addEventListener('click', () => this.#identifyPhoto());
      document.getElementById('scan-continue').addEventListener('click', () => {
        const img = this.#scanImage;
        this.#scanImage = null;
        this.#goTo('form', { formMode: 'add', formPrefill: { images: [img] } });
      });
    }
    document.getElementById('scan-camera-input').addEventListener('change', (e) => {
      handleFile(e.target.files[0]);
      e.target.value = '';
    });
    document.getElementById('scan-upload-input').addEventListener('change', (e) => {
      handleFile(e.target.files[0]);
      e.target.value = '';
    });
  }

  // sends the photo to the backend's /api/identify, which asks Claude to guess
  // the item's details, same idea as the concept-test build, just through a
  // server now so the API key never has to sit in the browser
  async #identifyPhoto() {
    if (!this.#scanImage || this.#identifying) return;
    this.#identifying = true;
    this.#renderScan();

    const img = this.#scanImage;
    try {
      const { mediaType, base64 } = parseDataUrl(img);
      const guess = await this.#api.identify(base64, mediaType);
      this.#scanImage = null;
      this.#identifying = false;
      this.#goTo('form', { formMode: 'add', formPrefill: { images: [img], ...guess } });
    } catch (err) {
      this.#identifying = false;
      this.#notify(err.message || "Couldn't identify that, try entering details manually");
      this.#renderScan();
    }
  }

  // ask for the camera, fall back to the file picker if it's blocked or missing
  async #startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      document.getElementById('scan-camera-input').click();
      return;
    }
    try {
      this.#cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      this.#renderScan();
    } catch (err) {
      this.#notify("Couldn't access the camera, pick a photo instead");
      document.getElementById('scan-camera-input').click();
    }
  }

  // grab the current video frame and turn it into a jpeg, same as an uploaded photo
  #capturePhoto(video) {
    const canvas = document.createElement('canvas');
    let width = video.videoWidth;
    let height = video.videoHeight;
    if (width >= height && width > MAX_IMAGE_DIMENSION) {
      height = Math.round((height * MAX_IMAGE_DIMENSION) / width);
      width = MAX_IMAGE_DIMENSION;
    } else if (height > width && height > MAX_IMAGE_DIMENSION) {
      width = Math.round((width * MAX_IMAGE_DIMENSION) / height);
      height = MAX_IMAGE_DIMENSION;
    }
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(video, 0, 0, width, height);
    this.#scanImage = canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
    this.#stopCamera();
    this.#renderScan();
  }

  // switch the camera off so the light/indicator turns off too
  #stopCamera() {
    if (this.#cameraStream) {
      for (const track of this.#cameraStream.getTracks()) track.stop();
      this.#cameraStream = null;
    }
  }

  // stats

  #renderStats() {
    const container = document.getElementById('view-stats');
    const items = this.#store.getAll();

    if (items.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">${icon('stats', { size: 22 })}</div>
          <p class="empty-title">No stats yet</p>
          <p class="empty-subtitle">Add a few items to your collection to see totals and breakdowns here.</p>
        </div>
      `;
      return;
    }

    const { total, byCategory, favourites, autographed, duplicateGroups } = this.#store.stats();
    const maxCount = Math.max(1, ...Object.values(byCategory));

    const bars = Object.entries(byCategory).map(([cat, count]) => `
      <div class="bar-row">
        <div class="bar-label"><span>${cat}</span><span>${count}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${(count / maxCount) * 100}%"></div></div>
      </div>
    `).join('');

    const dupSection = duplicateGroups.length > 0 ? `
      <div>
        <p class="section-heading" style="color:var(--amber);">${icon('warning', { size: 13 })} Possible Duplicates</p>
        ${duplicateGroups.map((group) => `
          <div class="dup-group">
            <strong>${escapeHTML(group[0].name)} &middot; ${group.length} copies</strong>
            ${group.map((item) => `<button data-goto-item="${item.id}">${escapeHTML(item.series || item.condition || 'view item')}</button>`).join('')}
          </div>
        `).join('')}
      </div>
    ` : '';

    container.innerHTML = `
      <div class="stat-hero">
        <p class="big-num">${total}</p>
        <p class="cap">Total Items Tracked</p>
      </div>
      <div class="stat-grid">
        <div class="stat-chip"><p class="num">${favourites}</p><p class="cap">Favourites</p></div>
        <div class="stat-chip"><p class="num">${autographed}</p><p class="cap">Autographed</p></div>
      </div>
      <div>
        <p class="section-heading">By Category</p>
        ${bars}
      </div>
      ${dupSection}
    `;

    for (const btn of container.querySelectorAll('[data-goto-item]')) {
      btn.addEventListener('click', () => this.#goTo('detail', { selectedId: btn.dataset.gotoItem }));
    }
  }

  // profile popup

  #openProfileModal() {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-overlay" id="profile-overlay">
        <div class="modal-box">
          <div class="modal-head">
            <h2>Your Profile</h2>
            <button id="profile-close" aria-label="Close">${icon('close', { size: 15 })}</button>
          </div>
          <p class="modal-note">Signed in as ${escapeHTML(this.#profile.email)}</p>
          <div class="field">
            <label>Display name</label>
            <input type="text" id="profile-name-input" value="${escapeHTML(this.#profile.name)}">
          </div>
          <button class="btn btn-block" id="profile-save">Save</button>
          <hr class="modal-divider">
          <div class="field">
            <label>Share your collection</label>
            <div id="share-slot"><button class="btn btn-outline btn-block" id="share-get-link">${icon('share', { size: 13 })} Get shareable link</button></div>
          </div>
          <hr class="modal-divider">
          <button class="danger-link" id="logout-btn">Log out</button>
          <hr class="modal-divider">
          <div id="reset-slot"></div>
        </div>
      </div>
    `;

    const close = () => { root.innerHTML = ''; };
    document.getElementById('profile-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'profile-overlay') close();
    });
    document.getElementById('profile-close').addEventListener('click', close);
    document.getElementById('profile-save').addEventListener('click', () => {
      this.#safely(async () => {
        await this.#profile.setName(document.getElementById('profile-name-input').value);
        close();
        this.#render();
      });
    });
    document.getElementById('share-get-link').addEventListener('click', () => this.#loadShareSlot());
    document.getElementById('logout-btn').addEventListener('click', () => {
      this.#api.setToken(null);
      close();
      this.#authMode = 'login';
      this.#authError = null;
      this.#goTo('auth');
    });

    this.#renderResetSlot(false);
  }

  // fetches the account's share link (creating one on first use) or generates
  // a brand new one if forceReset is true, which quietly breaks any old link
  async #loadShareSlot(forceReset = false) {
    const slot = document.getElementById('share-slot');
    if (!slot) return;
    slot.innerHTML = `<p class="hint-text">Loading link\u2026</p>`;
    try {
      const { token } = forceReset ? await this.#api.resetShare() : await this.#api.getShareInfo();
      const link = `${window.location.origin}${window.location.pathname}?share=${token}`;
      slot.innerHTML = `
        <div class="share-row">
          <input type="text" id="share-link-input" readonly value="${escapeHTML(link)}">
          <button class="icon-btn" id="share-copy-btn" aria-label="Copy link">${icon('copy', { size: 14 })}</button>
        </div>
        <button class="muted-link" id="share-reset-btn">Generate a new link</button>
      `;
      document.getElementById('share-copy-btn').addEventListener('click', async () => {
        document.getElementById('share-link-input').select();
        try {
          await navigator.clipboard.writeText(link);
          this.#notify('Link copied');
        } catch (err) {
          this.#notify('Could not copy, select the text and copy it manually');
        }
      });
      document.getElementById('share-reset-btn').addEventListener('click', () => this.#loadShareSlot(true));
    } catch (err) {
      slot.innerHTML = `<p class="field-error">${escapeHTML(err.message || "Couldn't load your share link")}</p>`;
    }
  }

  // same two-step confirm pattern as #renderDeleteSlot, but for wiping the whole collection at once
  #renderResetSlot(confirming) {
    const slot = document.getElementById('reset-slot');
    if (!slot) return;
    if (!confirming) {
      slot.innerHTML = `<button class="danger-link" id="reset-data">Delete all my items</button>`;
      document.getElementById('reset-data').addEventListener('click', () => this.#renderResetSlot(true));
    } else {
      slot.innerHTML = `
        <div class="confirm-box">
          <p>Delete every item in your collection? This can't be undone.</p>
          <div class="btn-row">
            <button class="btn btn-outline" id="reset-cancel" style="flex:1;">Cancel</button>
            <button class="btn btn-danger" id="reset-confirm" style="flex:1;">Confirm</button>
          </div>
        </div>
      `;
      document.getElementById('reset-cancel').addEventListener('click', () => this.#renderResetSlot(false));
      document.getElementById('reset-confirm').addEventListener('click', () => {
        this.#safely(async () => {
          await this.#store.clearAll();
          this.#notify('All items cleared');
          document.getElementById('modal-root').innerHTML = '';
          this.#goTo('home');
        });
      });
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new CollectScanApp();
  app.init();
});
