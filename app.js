"use strict";

const STORAGE_KEY = "doorKnockTrackerMap";
const LOGO_STORAGE_KEY = "kanvaskings-custom-logo-v1";
const PHOTO_DATABASE = "kanvaskings-pin-photos";
const PHOTO_STORE = "photos";
const MAX_PHOTO_SIZE = 8 * 1024 * 1024;
const MAX_PHOTOS_PER_PIN = 8;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_LOGO_SIZE = 1024 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
const HAIL_REPORT_RADIUS_MILES = 25;
const HAIL_MAP_FOCUS_RADIUS_MILES = 250;
const HAIL_SHADE_RADIUS_MILES = 5;
const HAIL_SIZE_THRESHOLDS = [0.5, 0.75, 1.25, 1.75, 2.5];
const HAIL_SIZE_COLOR_RANGES = [
  { threshold: 0.75, label: "0.50–<0.75 in · Blue", light: "#55a8ed", dark: "#164b8a" },
  { threshold: 1.25, label: "0.75–<1.25 in · Yellow", light: "#fff06b", dark: "#a87900" },
  { threshold: 1.75, label: "1.25–<1.75 in · Orange", light: "#ff9a45", dark: "#aa3b00" },
  { threshold: 2.5, label: "1.75–<2.50 in · Red", light: "#fa5959", dark: "#8c0714" },
  { threshold: Infinity, shadeMaximum: 4.5, label: "2.50+ in · Purple", light: "#c783e8", dark: "#4a176f" },
];
const HAIL_YEAR_CACHE = new Map();
const HAIL_DAY_CACHE = new Map();
const WIND_HISTORY_CACHE = new Map();
const PHOTO_OBJECT_URLS = new WeakMap();
const OUTCOMES = ["No Answer", "Qualified Lead", "Sale", "Completed Job", "Retail Roof Complete", "Not Interested", "Do Not Disturb", "New Roof", "Approved Roof"];
const OUTCOME_MIGRATIONS = { "Follow Up": "Qualified Lead", Appointment: "Qualified Lead" };
const COLORS = { "No Answer": "#e58a27", "Qualified Lead": "#d5ad24", Sale: "#278954", "Completed Job": "#278954", "Retail Roof Complete": "#e0b522", "Not Interested": "#cf3038", "Do Not Disturb": "#b91c2b", "New Roof": "#e98231", "Approved Roof": "#278954" };
const OUTCOME_CLASSES = { "No Answer": "no-answer", "Qualified Lead": "qualified-lead", Sale: "sale", "Completed Job": "completed-job", "Retail Roof Complete": "retail-roof-complete", "Not Interested": "not-interested", "Do Not Disturb": "do-not-disturb", "New Roof": "new-roof", "Approved Roof": "approved-roof" };
const OUTCOME_SYMBOLS = { "No Answer": "?", "Qualified Lead": "★", Sale: "⌂", "Completed Job": "✓", "Retail Roof Complete": "$", "Not Interested": "👎", "Do Not Disturb": "☠", "New Roof": "☹", "Approved Roof": "$" };
const US_BOUNDS = [[24.396308, -124.848974], [49.384358, -66.885444]];
const el = {
  form: document.querySelector("#door-form"), address: document.querySelector("#address"), date: document.querySelector("#date"), outcome: document.querySelector("#outcome"),
  contact: document.querySelector("#contact"), phone: document.querySelector("#phone"), notes: document.querySelector("#notes"), saveButton: document.querySelector("#save-button"),
  status: document.querySelector("#form-status"), offlineNote: document.querySelector("#offline-note"), connection: document.querySelector("#connection-status"), connectionLabel: document.querySelector("#connection-label"),
  entries: document.querySelector("#entries"), filter: document.querySelector("#filter"), search: document.querySelector("#search"), mapFallback: document.querySelector("#map-fallback"),
  locateButton: document.querySelector("#locate-me"), locationStatus: document.querySelector("#location-status"),
  mapSearchForm: document.querySelector("#map-search-form"), mapAddressSearch: document.querySelector("#map-address-search"), mapSearchButton: document.querySelector("#map-search-button"),
  brandLogoDropzone: document.querySelector("#brand-logo-dropzone"), brandLogoButton: document.querySelector("#brand-logo-button"), brandPasteButton: document.querySelector("#brand-paste-button"), brandLogoInput: document.querySelector("#brand-logo-input"), brandLogo: document.querySelector("#brand-logo"),
  logoFeedback: document.querySelector("#logo-feedback"), logoPasteTarget: document.querySelector("#logo-paste-target"),
};
let map = null;
let markers = [];
let hailOverlayMarkers = [];
let hailEstimateReports = [];
let hailEstimateMarker = null;
let hailRadarLayer = null;
let hailMapDisplayMode = "size";
let hailLegendControl = null;
let hailDateControl = null;
let hailDateInput = null;
let hailDateStatus = null;
let currentOrganization = null;
let workspaceRealtimeChannel = null;
let addressSearchMarker = null;
let searchingAddress = false;
let locationWatchId = null;
let locationMarker = null;
let locationAccuracy = null;
let addingDoor = false;
let lastGeocodeAt = 0;
let installPrompt = null;
let lookingUpMapAddress = false;
let logoFeedbackTimer;

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function entriesStorageKey() {
  return currentOrganization ? `${STORAGE_KEY}:${currentOrganization.company_id}` : STORAGE_KEY;
}

function loadEntries() {
  try {
    const entries = JSON.parse(localStorage.getItem(entriesStorageKey()) || "[]");
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry) => entry && typeof entry === "object").map((entry) => ({
      id: String(entry.id ?? globalThis.crypto?.randomUUID?.() ?? Date.now()), date: String(entry.date ?? ""), address: String(entry.address ?? ""),
      outcome: (() => {
        const outcome = OUTCOME_MIGRATIONS[entry.outcome] || entry.outcome;
        return OUTCOMES.includes(outcome) ? outcome : "No Answer";
      })(), contact: String(entry.contact ?? ""), phone: String(entry.phone ?? ""), notes: String(entry.notes ?? ""),
      lat: entry.lat != null && Number.isFinite(Number(entry.lat)) ? Number(entry.lat) : null, lng: entry.lng != null && Number.isFinite(Number(entry.lng)) ? Number(entry.lng) : null,
    })).filter((entry) => entry.address);
  } catch { return []; }
}

async function saveEntries(entries) {
  if (currentOrganization) {
    const previous = loadEntries();
    const previousById = new Map(previous.map((entry) => [entry.id, entry]));
    const nextIds = new Set(entries.map((entry) => entry.id));
    const changed = entries.filter((entry) => JSON.stringify(previousById.get(entry.id)) !== JSON.stringify(entry));
    const removedIds = previous.filter((entry) => !nextIds.has(entry.id)).map((entry) => entry.id);
    try {
      if (changed.length) {
        const rows = changed.map((entry) => ({
          company_id: currentOrganization.company_id,
          id: entry.id,
          date: entry.date,
          address: entry.address,
          outcome: entry.outcome,
          contact: entry.contact,
          phone: entry.phone,
          notes: entry.notes,
          lat: entry.lat,
          lng: entry.lng,
        }));
        const { error } = await window.kanvasSupabase.client
          .from("door_entries")
          .upsert(rows, { onConflict: "company_id,id" });
        if (error) throw error;
      }
      for (let offset = 0; offset < removedIds.length; offset += 100) {
        const { error } = await window.kanvasSupabase.client
          .from("door_entries")
          .delete()
          .eq("company_id", currentOrganization.company_id)
          .in("id", removedIds.slice(offset, offset + 100));
        if (error) throw error;
      }
    } catch (error) {
      setStatus(`Could not sync this change to the company workspace: ${error.message || "connection error"}`, true);
      return false;
    }
  }
  try {
    localStorage.setItem(entriesStorageKey(), JSON.stringify(entries));
    return true;
  } catch {
    setStatus("Could not save data on this device. Check available storage and try again.", true);
    return false;
  }
}

function setStatus(message, isError = false) {
  el.status.textContent = message;
  el.status.classList.toggle("error", isError);
}

function setLogoFeedback(message, isError = false) {
  el.logoFeedback.textContent = message;
  el.logoFeedback.classList.toggle("error", isError);
  el.logoFeedback.hidden = false;
  clearTimeout(logoFeedbackTimer);
  logoFeedbackTimer = setTimeout(() => { el.logoFeedback.hidden = true; }, 5000);
}

function restoreBrandLogo() {
  try {
    const savedLogo = localStorage.getItem(LOGO_STORAGE_KEY);
    if (savedLogo?.startsWith("data:image/")) el.brandLogo.src = savedLogo;
  } catch {
    setLogoFeedback("Could not load the saved logo from this browser.", true);
  }
}

function saveBrandLogo(file) {
  if (!file) return;
  if (!LOGO_TYPES.includes(file.type)) {
    setLogoFeedback("Unsupported image. Choose PNG, JPEG, WebP, GIF, or SVG.", true);
    return;
  }
  if (file.size > MAX_LOGO_SIZE) {
    setLogoFeedback("Logo must be 1 MB or smaller.", true);
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    if (typeof reader.result !== "string") {
      setLogoFeedback("Could not read that logo file.", true);
      return;
    }
    try {
      localStorage.setItem(LOGO_STORAGE_KEY, reader.result);
      el.brandLogo.src = reader.result;
      setLogoFeedback("Kanvas Kings logo updated.");
    } catch {
      setLogoFeedback("Could not save the logo. Try a smaller image.", true);
    }
  }, { once: true });
  reader.addEventListener("error", () => setLogoFeedback("Could not read that logo file.", true), { once: true });
  reader.readAsDataURL(file);
}

async function pasteBrandLogo() {
  if (!navigator.clipboard?.read) {
    setLogoFeedback("Image clipboard access is unavailable. Press Ctrl+V to paste the copied logo.");
    el.logoPasteTarget.focus();
    return;
  }
  try {
    const clipboardItems = await navigator.clipboard.read();
    for (const item of clipboardItems) {
      const imageType = item.types.find((type) => type.startsWith("image/"));
      if (!imageType) continue;
      const image = await item.getType(imageType);
      saveBrandLogo(image);
      return;
    }
    setLogoFeedback("No image data found. Copy the image itself, then try Paste again.", true);
    el.logoPasteTarget.focus();
  } catch {
    setLogoFeedback("Clipboard read was blocked. Copy the logo image, then press Ctrl+V.", true);
    el.logoPasteTarget.focus();
  }
}

function handleLogoPaste(event) {
  const imageItem = Array.from(event.clipboardData?.items || []).find((item) => item.kind === "file" && item.type.startsWith("image/"));
  const image = imageItem?.getAsFile();
  if (!image) return;
  event.preventDefault();
  saveBrandLogo(image);
}

function formatDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function updateStats(entries) {
  const stats = [
    ["Total doors", entries.length, "Conversations started", "↗", "total"],
    ["No answer", entries.filter((entry) => entry.outcome === "No Answer").length, "Try another time", "·", "no-answer"],
    ["Qualified leads", entries.filter((entry) => entry.outcome === "Qualified Lead").length, "Prospects to pursue", "★", "qualified"],
    ["Sales", entries.filter((entry) => entry.outcome === "Sale").length, "Deals closed", "✓", "sale"],
    ["Completed jobs", entries.filter((entry) => entry.outcome === "Completed Job").length, "Work delivered", "✓", "completed"],
  ];
  document.querySelector("#stats").innerHTML = stats.map(([label, value, detail, icon, type]) => `<article class="stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon ${type}" aria-hidden="true">${icon}</span></div><div class="stat-value">${value}</div><div class="stat-foot">${detail}</div></article>`).join("");
}

function filteredEntries(entries) {
  const outcome = el.filter.value;
  const query = el.search.value.trim().toLocaleLowerCase();
  return entries.filter((entry) => (outcome === "All" || entry.outcome === outcome) && (!query || [entry.address, entry.contact, entry.phone, entry.notes].join(" ").toLocaleLowerCase().includes(query)));
}

function renderTable(entries) {
  const filtered = filteredEntries(entries);
  document.querySelector("#record-count").textContent = entries.length;
  document.querySelector("#showing-count").textContent = `Showing ${filtered.length} of ${entries.length}`;
  el.entries.innerHTML = filtered.length ? filtered.map((entry) => `<tr><td>${escapeHTML(formatDate(entry.date))}</td><td class="address-cell">${escapeHTML(entry.address)}</td><td><span class="outcome-badge" data-outcome="${escapeHTML(entry.outcome)}">${escapeHTML(entry.outcome)}</span></td><td class="contact-cell">${escapeHTML(entry.contact)}<span>${escapeHTML(entry.phone)}</span></td><td class="notes-cell">${escapeHTML(entry.notes)}</td><td class="no-print"><button class="delete-entry" type="button" data-delete-id="${escapeHTML(entry.id)}" aria-label="Delete record for ${escapeHTML(entry.address)}" title="Delete record">×</button></td></tr>`).join("") : `<tr class="empty-row"><td colspan="6">${entries.length ? "No doors match your search." : "No doors logged yet. Add your first conversation above."}</td></tr>`;
}

function openPinPhotoDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("Photo storage is unavailable in this browser."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PHOTO_DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PHOTO_STORE)) {
        const store = database.createObjectStore(PHOTO_STORE, { keyPath: "id" });
        store.createIndex("entryId", "entryId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open photo storage."));
    request.onblocked = () => reject(new Error("Photo storage is busy in another tab. Close other app tabs and try again."));
  });
}

function withPinPhotoStore(mode, operation) {
  return openPinPhotoDatabase().then((database) => new Promise((resolve, reject) => {
    let result;
    let operationError;
    let transaction;
    try {
      transaction = database.transaction(PHOTO_STORE, mode);
    } catch (error) {
      database.close();
      reject(error);
      return;
    }
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onerror = () => { database.close(); reject(transaction.error || new Error("Could not access saved pin photos.")); };
    transaction.onabort = () => { database.close(); reject(operationError || transaction.error || new Error("Pin photo storage was interrupted.")); };
    try {
      operation(transaction.objectStore(PHOTO_STORE), (value) => { result = value; }, (error) => {
        operationError = error;
        transaction.abort();
      });
    } catch (error) {
      operationError = error;
      transaction.abort();
    }
  }));
}

function getPinPhotos(entryId) {
  return withPinPhotoStore("readonly", (store, setResult, fail) => {
    const request = store.index("entryId").getAll(entryId);
    request.onsuccess = () => setResult(request.result);
    request.onerror = () => fail(request.error || new Error("Could not load photos for this pin."));
  });
}

function savePinPhoto(entryId, file) {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return withPinPhotoStore("readwrite", (store) => {
    store.put({ id, entryId, name: file.name, type: file.type, blob: file, createdAt: Date.now() });
  });
}

function deletePinPhoto(photoId) {
  return withPinPhotoStore("readwrite", (store) => { store.delete(photoId); });
}

async function deletePinPhotos(entryId) {
  const photos = await getPinPhotos(entryId);
  await Promise.all(photos.map((photo) => deletePinPhoto(photo.id)));
}

function releasePinPhotoUrls(panel) {
  (PHOTO_OBJECT_URLS.get(panel) || []).forEach((url) => URL.revokeObjectURL(url));
  PHOTO_OBJECT_URLS.delete(panel);
}

function renderPinPhotos(panel, photos) {
  releasePinPhotoUrls(panel);
  const grid = panel.querySelector(".pin-photo-grid");
  grid.replaceChildren();
  const objectUrls = [];
  photos.forEach((photo) => {
    const item = document.createElement("div");
    item.className = "pin-photo-item";
    const link = document.createElement("a");
    const url = URL.createObjectURL(photo.blob);
    objectUrls.push(url);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.setAttribute("aria-label", `View photo ${photo.name}`);
    const image = document.createElement("img");
    image.src = url;
    image.alt = photo.name;
    link.append(image);
    const removeButton = document.createElement("button");
    removeButton.className = "pin-photo-remove";
    removeButton.type = "button";
    removeButton.textContent = "×";
    removeButton.title = `Remove ${photo.name}`;
    removeButton.setAttribute("aria-label", `Remove photo ${photo.name}`);
    removeButton.addEventListener("click", async () => {
      removeButton.disabled = true;
      try {
        await deletePinPhoto(photo.id);
        renderPinPhotos(panel, photos.filter((item) => item.id !== photo.id));
        panel.querySelector(".pin-photo-status").textContent = "Photo removed.";
      } catch (error) {
        removeButton.disabled = false;
        panel.querySelector(".pin-photo-status").textContent = error.message || "Could not remove this photo.";
        setStatus(panel.querySelector(".pin-photo-status").textContent, true);
      }
    });
    item.append(link, removeButton);
    grid.append(item);
  });
  PHOTO_OBJECT_URLS.set(panel, objectUrls);
}

async function loadPinPhotos(entryId, panel) {
  const photos = await getPinPhotos(entryId);
  if (!panel.isConnected) return;
  renderPinPhotos(panel, photos);
  panel.querySelector(".pin-photo-status").textContent = photos.length
    ? `${photos.length} of ${MAX_PHOTOS_PER_PIN} photos`
    : "No photos yet.";
}

async function uploadPinPhotos(entryId, input, panel, button) {
  const files = [...input.files || []];
  input.value = "";
  if (!files.length) return;
  const status = panel.querySelector(".pin-photo-status");
  button.disabled = true;
  status.textContent = "Saving photos…";
  try {
    const existing = await getPinPhotos(entryId);
    const invalidFile = files.find((file) => !PHOTO_TYPES.includes(file.type) || file.size > MAX_PHOTO_SIZE);
    if (invalidFile) throw new Error(PHOTO_TYPES.includes(invalidFile.type)
      ? `${invalidFile.name} is larger than 8 MB.`
      : `${invalidFile.name} is not a supported JPEG, PNG, WebP, or GIF image.`);
    if (existing.length + files.length > MAX_PHOTOS_PER_PIN) {
      throw new Error(`A pin can have up to ${MAX_PHOTOS_PER_PIN} photos.`);
    }
    let saved = 0;
    try {
      for (const file of files) {
        await savePinPhoto(entryId, file);
        saved += 1;
      }
    } catch (error) {
      await loadPinPhotos(entryId, panel);
      throw new Error(`Saved ${saved} of ${files.length} photos. ${error.message || "Photo storage failed."}`);
    }
    await loadPinPhotos(entryId, panel);
    status.textContent = `Saved ${saved} photo${saved === 1 ? "" : "s"}.`;
    setStatus(`Photos saved for this pin.`);
  } catch (error) {
    status.textContent = error.message || "Could not save photos for this pin.";
    setStatus(status.textContent, true);
  } finally {
    button.disabled = false;
  }
}

function createPopup(entry, marker) {
  const popup = document.createElement("div");
  if (entry.contact) {
    const contact = document.createElement("div");
    contact.className = "popup-contact-name";
    contact.textContent = entry.contact;
    popup.append(contact);
  }
  const address = document.createElement("div");
  address.className = "popup-address";
  address.textContent = entry.address;
  popup.append(address);
  const outcomeChoices = document.createElement("div");
  outcomeChoices.className = "popup-outcome-choices";
  outcomeChoices.setAttribute("role", "group");
  outcomeChoices.setAttribute("aria-label", `Change result for ${entry.address}`);
  OUTCOMES.forEach((outcome) => {
    const choice = document.createElement("button");
    choice.className = `popup-outcome-choice door-pin-${OUTCOME_CLASSES[outcome]}`;
    choice.type = "button";
    choice.textContent = OUTCOME_SYMBOLS[outcome];
    choice.title = outcome;
    choice.setAttribute("aria-label", outcome);
    choice.setAttribute("aria-pressed", String(outcome === entry.outcome));
    choice.addEventListener("click", () => updateDoorOutcome(entry, outcome, outcomeChoices, marker));
    outcomeChoices.append(choice);
  });
  L.DomEvent.disableClickPropagation(outcomeChoices);
  popup.append(outcomeChoices);
  [entry.phone, formatDate(entry.date)].filter(Boolean).forEach((text) => {
    const line = document.createElement("div");
    line.className = "popup-line";
    line.textContent = text;
    popup.append(line);
  });

  const deleteButton = document.createElement("button");
  deleteButton.className = "popup-delete button button-danger-quiet";
  deleteButton.type = "button";
  deleteButton.textContent = "Delete door";
  deleteButton.setAttribute("aria-label", `Delete record for ${entry.address}`);
  deleteButton.addEventListener("click", () => deleteEntry(entry.id));
  L.DomEvent.disableClickPropagation(deleteButton);
  popup.append(deleteButton);

  const history = document.createElement("section");
  history.className = "door-weather";
  const tabs = document.createElement("div");
  tabs.className = "door-weather-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Historical storm data");
  const hailTab = createWeatherTab("hail", "Hail", true);
  const windTab = createWeatherTab("wind", "Wind", false);
  tabs.append(hailTab, windTab);
  const hailPanel = createWeatherPanel("hail", "Reported hail within 25 miles · last 3 years");
  const windPanel = createWeatherPanel("wind", "Hours with average wind ≥55 mph OR gusts ≥60 mph · last 3 years");
  windPanel.hidden = true;
  const photoPanel = document.createElement("section");
  photoPanel.className = "pin-photo-panel";
  const photoInput = document.createElement("input");
  photoInput.type = "file";
  photoInput.accept = PHOTO_TYPES.join(",");
  photoInput.multiple = true;
  photoInput.hidden = true;
  const photoButton = document.createElement("button");
  photoButton.className = "button button-quiet pin-photo-upload";
  photoButton.type = "button";
  photoButton.textContent = "Upload pictures";
  photoButton.addEventListener("click", () => photoInput.click());
  const photoStatus = document.createElement("p");
  photoStatus.className = "pin-photo-status";
  photoStatus.textContent = "Loading photos…";
  const photoGrid = document.createElement("div");
  photoGrid.className = "pin-photo-grid";
  photoInput.addEventListener("change", () => uploadPinPhotos(entry.id, photoInput, photoPanel, photoButton));
  photoPanel.append(photoButton, photoInput, photoStatus, photoGrid);
  const notesLabel = document.createElement("label");
  notesLabel.className = "popup-notes-field";
  notesLabel.textContent = "Notes";
  const notesInput = document.createElement("textarea");
  notesInput.maxLength = 1000;
  notesInput.rows = 3;
  notesInput.placeholder = "Record details for this door";
  notesInput.value = entry.notes;
  notesInput.setAttribute("aria-label", `Notes for ${entry.address}`);
  const saveNotesButton = document.createElement("button");
  saveNotesButton.className = "button button-quiet popup-save-notes";
  saveNotesButton.type = "button";
  saveNotesButton.textContent = "Save notes";
  saveNotesButton.addEventListener("click", () => updateDoorNotes(entry, notesInput.value, notesInput));
  notesLabel.append(notesInput);
  const reportButton = document.createElement("button");
  reportButton.className = "door-weather-report button button-quiet";
  reportButton.type = "button";
  reportButton.textContent = "Generate storm report";
  reportButton.addEventListener("click", () => generateStormReport(entry));
  history.append(tabs, hailPanel, windPanel, photoPanel, notesLabel, saveNotesButton, reportButton);
  L.DomEvent.disableClickPropagation(history);
  L.DomEvent.disableScrollPropagation(history);
  hailTab.addEventListener("click", () => activateWeatherTab(entry, history, "hail"));
  windTab.addEventListener("click", () => activateWeatherTab(entry, history, "wind"));
  popup.append(history);
  return popup;
}

async function updateDoorNotes(entry, notes, input) {
  const entries = loadEntries();
  const savedEntry = entries.find((item) => item.id === entry.id);
  if (!savedEntry) {
    setStatus("Could not save notes because this door record was not found.", true);
    return;
  }
  savedEntry.notes = notes.trim();
  if (!await saveEntries(entries)) {
    input.value = entry.notes;
    return;
  }
  entry.notes = savedEntry.notes;
  input.value = entry.notes;
  renderTable(entries);
  setStatus(`Notes saved for ${entry.address}.`);
}

function createDoorIcon(entry) {
  return L.divIcon({
    className: `leaflet-div-icon door-pin-icon door-pin-${OUTCOME_CLASSES[entry.outcome] || "no-answer"}`,
    html: `<span class="door-pin-symbol" aria-hidden="true">${OUTCOME_SYMBOLS[entry.outcome] || "?"}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

async function updateDoorOutcome(entry, outcome, choices, marker) {
  if (!OUTCOMES.includes(outcome) || outcome === entry.outcome) return;
  const entries = loadEntries();
  const savedEntry = entries.find((item) => item.id === entry.id);
  if (!savedEntry) {
    setStatus("Could not update this door because its saved record was not found.", true);
    return;
  }
  savedEntry.outcome = outcome;
  if (!await saveEntries(entries)) return;
  entry.outcome = outcome;
  marker.setIcon(createDoorIcon(entry));
  choices.querySelectorAll(".popup-outcome-choice").forEach((choice) => {
    choice.setAttribute("aria-pressed", String(choice.title === outcome));
  });
  updateStats(entries);
  renderTable(entries);
  setStatus(`Updated ${entry.address} to ${outcome}.`);
}

function createWeatherTab(kind, label, active) {
  const button = document.createElement("button");
  button.className = `door-weather-tab${active ? " active" : ""}`;
  button.type = "button";
  button.textContent = label;
  button.dataset.weatherTab = kind;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-pressed", String(active));
  return button;
}

function createWeatherPanel(kind, description) {
  const panel = document.createElement("div");
  panel.className = "door-weather-panel";
  panel.dataset.weatherPanel = kind;
  const note = document.createElement("p");
  note.className = "door-weather-note";
  note.textContent = description;
  const status = document.createElement("p");
  status.className = "door-weather-status";
  status.textContent = "Open to load history.";
  const list = document.createElement("ul");
  list.className = "door-weather-list";
  list.hidden = true;
  panel.append(note, status, list);
  return panel;
}

function activateWeatherTab(entry, history, kind) {
  history.querySelectorAll("[data-weather-tab]").forEach((button) => {
    const active = button.dataset.weatherTab === kind;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  history.querySelectorAll("[data-weather-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.weatherPanel !== kind;
  });
  const panel = history.querySelector(`[data-weather-panel="${kind}"]`);
  if (panel.dataset.loaded === "true") return;
  panel.dataset.loaded = "true";
  if (kind === "hail") loadHailHistory(entry, panel);
  else loadWindHistory(entry, panel);
}

function getHistoryRange() {
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 3);
  return { start: localDateString(start), end: localDateString(end) };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += character;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function loadHailReportsForYear(year) {
  if (!HAIL_YEAR_CACHE.has(year)) {
    const request = fetch(`https://www.spc.noaa.gov/wcm/data/${year}_hail.csv`).then((response) => {
      if (!response.ok) throw new Error(`NOAA hail data for ${year} is unavailable.`);
      return response.text();
    }).then((text) => {
      const rows = parseCsv(text.replace(/^\uFEFF/, ""));
      const headers = rows.shift()?.map((header) => header.trim().toLowerCase()) || [];
      const dateIndex = headers.indexOf("date");
      const timeIndex = headers.indexOf("time");
      const sizeIndex = headers.indexOf("mag");
      const latIndex = headers.indexOf("slat");
      const lngIndex = headers.indexOf("slon");
      const endLatIndex = headers.indexOf("elat");
      const endLngIndex = headers.indexOf("elon");
      if ([dateIndex, sizeIndex, latIndex, lngIndex].some((index) => index < 0)) throw new Error(`NOAA hail data for ${year} has an unexpected format.`);
      return rows.map((values) => {
        const lat = Number.parseFloat(values[latIndex]);
        const lng = Number.parseFloat(values[lngIndex]);
        const endLat = endLatIndex < 0 ? lat : Number.parseFloat(values[endLatIndex]);
        const endLng = endLngIndex < 0 ? lng : Number.parseFloat(values[endLngIndex]);
        return {
          date: values[dateIndex], time: timeIndex < 0 ? "" : values[timeIndex],
          size: Number.parseFloat(values[sizeIndex]), lat, lng,
          endLat: Number.isFinite(endLat) ? endLat : lat, endLng: Number.isFinite(endLng) ? endLng : lng,
        };
      }).filter((report) => report.date && Number.isFinite(report.size) && report.size > 0
        && Number.isFinite(report.lat) && Math.abs(report.lat) <= 90 && Number.isFinite(report.lng) && Math.abs(report.lng) <= 180
        && Number.isFinite(report.endLat) && Math.abs(report.endLat) <= 90 && Number.isFinite(report.endLng) && Math.abs(report.endLng) <= 180);
    }).catch((error) => { HAIL_YEAR_CACHE.delete(year); throw error; });
    HAIL_YEAR_CACHE.set(year, request);
  }
  return HAIL_YEAR_CACHE.get(year);
}

function loadHailReportsForDay(date) {
  if (!HAIL_DAY_CACHE.has(date)) {
    const reportDate = date.replaceAll("-", "").slice(2);
    const request = fetch(`https://www.spc.noaa.gov/climo/reports/${reportDate}_rpts_hail.csv`).then((response) => {
      if (!response.ok) throw new Error(`NOAA hail reports for ${date} are unavailable.`);
      return response.text();
    }).then((text) => {
      const rows = parseCsv(text.replace(/^\uFEFF/, ""));
      const headers = rows.shift()?.map((header) => header.trim().toLowerCase()) || [];
      const timeIndex = headers.indexOf("time");
      const sizeIndex = headers.indexOf("size");
      const latIndex = headers.indexOf("lat");
      const lngIndex = headers.indexOf("lon");
      if ([timeIndex, sizeIndex, latIndex, lngIndex].some((index) => index < 0)) {
        throw new Error(`NOAA hail reports for ${date} have an unexpected format.`);
      }
      return rows.map((values) => {
        const rawTime = values[timeIndex]?.trim() || "";
        const paddedTime = rawTime.padStart(4, "0");
        return {
          date, time: /^\d{3,4}$/.test(rawTime) ? `${paddedTime.slice(0, 2)}:${paddedTime.slice(2)}:00` : rawTime,
          size: Number.parseFloat(values[sizeIndex]) / 100,
          lat: Number.parseFloat(values[latIndex]), lng: Number.parseFloat(values[lngIndex]),
          endLat: Number.parseFloat(values[latIndex]), endLng: Number.parseFloat(values[lngIndex]),
        };
      }).filter((report) => Number.isFinite(report.size) && report.size > 0
        && Number.isFinite(report.lat) && Math.abs(report.lat) <= 90
        && Number.isFinite(report.lng) && Math.abs(report.lng) <= 180);
    }).catch((error) => { HAIL_DAY_CACHE.delete(date); throw error; });
    HAIL_DAY_CACHE.set(date, request);
  }
  return HAIL_DAY_CACHE.get(date);
}

async function loadCurrentYearHailReports(endDate) {
  const year = endDate.slice(0, 4);
  const dates = [];
  const latestAvailableDate = new Date(`${endDate}T12:00:00`);
  latestAvailableDate.setDate(latestAvailableDate.getDate() - 1);
  const dailyEndDate = localDateString(latestAvailableDate);
  const date = new Date(`${year}-01-01T12:00:00`);
  while (localDateString(date) <= dailyEndDate) {
    dates.push(localDateString(date));
    date.setDate(date.getDate() + 1);
  }

  const reports = [];
  let failedDays = 0;
  let nextDate = 0;
  async function loadNextDay() {
    while (nextDate < dates.length) {
      const currentDate = dates[nextDate];
      nextDate += 1;
      try {
        reports.push(...await loadHailReportsForDay(currentDate));
      } catch {
        failedDays += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, dates.length) }, loadNextDay));
  return { reports, failedDays, totalDays: dates.length };
}

function distanceInMiles(lat1, lng1, lat2, lng2) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = toRadians(lat2 - lat1);
  const longitudeDelta = toRadians(lng2 - lng1);
  const arc = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(longitudeDelta / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

function distanceToHailReportMiles(lat, lng, report) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const startDistance = distanceInMiles(report.lat, report.lng, lat, lng);
  const segmentDistance = distanceInMiles(report.lat, report.lng, report.endLat, report.endLng);
  if (segmentDistance < 0.001) return startDistance;

  const startLat = toRadians(report.lat);
  const pointLat = toRadians(lat);
  const pointLngDelta = toRadians(lng - report.lng);
  const endLngDelta = toRadians(report.endLng - report.lng);
  const pointBearing = Math.atan2(
    Math.sin(pointLngDelta) * Math.cos(pointLat),
    Math.cos(startLat) * Math.sin(pointLat) - Math.sin(startLat) * Math.cos(pointLat) * Math.cos(pointLngDelta),
  );
  const segmentBearing = Math.atan2(
    Math.sin(endLngDelta) * Math.cos(toRadians(report.endLat)),
    Math.cos(startLat) * Math.sin(toRadians(report.endLat))
      - Math.sin(startLat) * Math.cos(toRadians(report.endLat)) * Math.cos(endLngDelta),
  );
  const pointDistance = startDistance / 3958.8;
  const alongTrack = Math.atan2(
    Math.sin(pointDistance) * Math.cos(pointBearing - segmentBearing),
    Math.cos(pointDistance),
  );
  if (alongTrack <= 0) return startDistance;
  if (alongTrack >= segmentDistance / 3958.8) {
    return distanceInMiles(report.endLat, report.endLng, lat, lng);
  }
  const crossTrack = Math.asin(Math.sin(pointDistance) * Math.sin(pointBearing - segmentBearing));
  return Math.abs(crossTrack) * 3958.8;
}

function closestPointOnHailReport(lat, lng, report) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const segmentDistance = distanceInMiles(report.lat, report.lng, report.endLat, report.endLng);
  if (segmentDistance < 0.001) return { lat: report.lat, lng: report.lng };

  const startLat = toRadians(report.lat);
  const startLng = toRadians(report.lng);
  const pointLat = toRadians(lat);
  const pointLngDelta = toRadians(lng - report.lng);
  const endLngDelta = toRadians(report.endLng - report.lng);
  const startDistance = distanceInMiles(report.lat, report.lng, lat, lng);
  const pointBearing = Math.atan2(
    Math.sin(pointLngDelta) * Math.cos(pointLat),
    Math.cos(startLat) * Math.sin(pointLat) - Math.sin(startLat) * Math.cos(pointLat) * Math.cos(pointLngDelta),
  );
  const segmentBearing = Math.atan2(
    Math.sin(endLngDelta) * Math.cos(toRadians(report.endLat)),
    Math.cos(startLat) * Math.sin(toRadians(report.endLat))
      - Math.sin(startLat) * Math.cos(toRadians(report.endLat)) * Math.cos(endLngDelta),
  );
  const pointDistance = startDistance / 3958.8;
  const alongTrack = Math.atan2(
    Math.sin(pointDistance) * Math.cos(pointBearing - segmentBearing),
    Math.cos(pointDistance),
  );
  const angularDistance = Math.max(0, Math.min(segmentDistance / 3958.8, alongTrack));
  const closestLat = Math.asin(
    Math.sin(startLat) * Math.cos(angularDistance)
      + Math.cos(startLat) * Math.sin(angularDistance) * Math.cos(segmentBearing),
  );
  const closestLng = startLng + Math.atan2(
    Math.sin(segmentBearing) * Math.sin(angularDistance) * Math.cos(startLat),
    Math.cos(angularDistance) - Math.sin(startLat) * Math.sin(closestLat),
  );
  return { lat: closestLat * 180 / Math.PI, lng: closestLng * 180 / Math.PI };
}

function hailReportDirectionFromPoint(lat, lng, report) {
  const closest = closestPointOnHailReport(lat, lng, report);
  if (distanceInMiles(lat, lng, closest.lat, closest.lng) < 0.05) return "at pin";
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const startLat = toRadians(lat);
  const endLat = toRadians(closest.lat);
  const longitudeDelta = toRadians(closest.lng - lng);
  const bearing = (Math.atan2(
    Math.sin(longitudeDelta) * Math.cos(endLat),
    Math.cos(startLat) * Math.sin(endLat) - Math.sin(startLat) * Math.cos(endLat) * Math.cos(longitudeDelta),
  ) * 180 / Math.PI + 360) % 360;
  return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][
    Math.round(bearing / 22.5) % 16
  ];
}

function formatHailDistanceAndDirection(distance, direction) {
  return direction === "at pin" ? `${distance.toFixed(1)} mi from pin` : `${distance.toFixed(1)} mi ${direction} of pin`;
}

async function getHailHistory(entry) {
  const range = getHistoryRange();
  const firstYear = Number(range.start.slice(0, 4));
  const lastYear = Number(range.end.slice(0, 4));
  const currentYear = lastYear;
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index)
    .filter((year) => year !== currentYear);
  const [results, currentYearResults] = await Promise.all([
    Promise.allSettled(years.map(loadHailReportsForYear)),
    loadCurrentYearHailReports(range.end),
  ]);
  const reports = [...results.flatMap((result) => result.status === "fulfilled" ? result.value : []), ...currentYearResults.reports];
  const nearby = reports.map((report) => ({ ...report, distance: distanceToHailReportMiles(entry.lat, entry.lng, report) }))
    .filter((report) => report.date >= range.start && report.date <= range.end && report.distance <= HAIL_REPORT_RADIUS_MILES)
    .sort((first, second) => second.date.localeCompare(first.date) || (second.time || "").localeCompare(first.time || ""));
  const failedYears = results.filter((result) => result.status === "rejected").length;
  const allHistoricalYearsFailed = years.length > 0 && failedYears === years.length;
  const allCurrentYearDaysFailed = currentYearResults.totalDays > 0 && currentYearResults.failedDays === currentYearResults.totalDays;
  if (allHistoricalYearsFailed && allCurrentYearDaysFailed) throw new Error("NOAA hail reports are unavailable.");
  return { reports: nearby, partial: failedYears > 0 || currentYearResults.failedDays > 0, range };
}

function summarizeHailStormDays(reports) {
  const days = new Map();
  reports.forEach((report) => {
    const day = days.get(report.date) || { date: report.date, largestSize: 0, nearestDistance: Infinity, reportCount: 0, reports: [] };
    day.largestSize = Math.max(day.largestSize, report.size);
    day.nearestDistance = Math.min(day.nearestDistance, report.distance);
    day.reportCount += 1;
    day.reports.push(report);
    days.set(report.date, day);
  });
  return [...days.values()].sort((first, second) => second.date.localeCompare(first.date));
}

function hailSizeColor(size) {
  if (size < 0.5) return null;
  const bandIndex = HAIL_SIZE_COLOR_RANGES.findIndex((band) => size < band.threshold);
  const index = bandIndex < 0 ? HAIL_SIZE_COLOR_RANGES.length - 1 : bandIndex;
  const band = HAIL_SIZE_COLOR_RANGES[index];
  const minimum = index === 0 ? 0.5 : HAIL_SIZE_COLOR_RANGES[index - 1].threshold;
  const maximum = band.shadeMaximum ?? band.threshold;
  const progress = Math.min(1, (size - minimum) / (maximum - minimum));
  const channels = [1, 3, 5].map((offset) => {
    const light = Number.parseInt(band.light.slice(offset, offset + 2), 16);
    const dark = Number.parseInt(band.dark.slice(offset, offset + 2), 16);
    return Math.round(light + (dark - light) * progress).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

function hailLikelihoodColor(percent) {
  if (percent >= 75) return "#ef2020";
  if (percent >= 50) return "#f47721";
  if (percent >= 25) return "#f4dc22";
  if (percent >= 10) return "#2585e8";
  return null;
}

function clearHailMapOverlay() {
  hailOverlayMarkers.forEach((layer) => map?.removeLayer(layer));
  hailOverlayMarkers = [];
  hailRadarLayer = null;
  hailEstimateReports = [];
  if (hailEstimateMarker && map) map.removeLayer(hailEstimateMarker);
  hailEstimateMarker = null;
  if (map && hailLegendControl) map.removeControl(hailLegendControl);
  if (hailDateStatus) {
    hailDateStatus.textContent = `Search or zoom to an area, then choose a date to show hail reports within ${HAIL_MAP_FOCUS_RADIUS_MILES} miles.`;
  }
}

function createHailMapLegend(date) {
  if (!hailLegendControl) {
    hailLegendControl = L.control({ position: "topright" });
    hailLegendControl.onAdd = () => {
      const container = L.DomUtil.create("div", "hail-map-legend leaflet-bar");
      container.setAttribute("aria-label", "Hail report map legend");
      container.addEventListener("click", (event) => event.stopPropagation());
      container.addEventListener("dblclick", (event) => event.stopPropagation());
      L.DomEvent.disableScrollPropagation(container);
      return container;
    };
  }
  hailLegendControl.addTo(map);
  const container = hailLegendControl.getContainer();
  container.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = `Hail map · ${formatDate(date)}`;
  container.append(heading);
  const modeButtons = document.createElement("div");
  modeButtons.className = "hail-map-mode-buttons";
  [["percentage", "Percentage"], ["size", "Size"]].forEach(([mode, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hail-map-mode-button";
    button.dataset.hailMode = mode;
    button.textContent = label;
    button.addEventListener("click", () => setHailMapDisplayMode(mode));
    modeButtons.append(button);
  });
  container.append(modeButtons);
  const percentageLegend = document.createElement("div");
  percentageLegend.className = "hail-map-mode-legend hail-map-percentage-legend";
  [
    ["10–<25% · Blue", "#2585e8"],
    ["25–<50% · Yellow", "#f4dc22"],
    ["50–<75% · Orange", "#f47721"],
    ["75–100% · Red", "#ef2020"],
  ].forEach(([label, color]) => {
    const row = document.createElement("span");
    row.className = "hail-map-legend-row";
    const swatch = document.createElement("i");
    swatch.style.backgroundColor = color;
    row.append(swatch, document.createTextNode(label));
    percentageLegend.append(row);
  });
  const percentageNote = document.createElement("small");
  percentageNote.textContent = "Uncalibrated proximity estimate; areas below 10% are transparent.";
  percentageLegend.append(percentageNote);
  container.append(percentageLegend);
  const sizeLegend = document.createElement("div");
  sizeLegend.className = "hail-map-mode-legend hail-map-size-legend";
  HAIL_SIZE_COLOR_RANGES.forEach((band) => {
    const row = document.createElement("span");
    row.className = "hail-map-legend-row";
    const swatch = document.createElement("i");
    swatch.style.background = `linear-gradient(90deg, ${band.light}, ${band.dark})`;
    row.append(swatch, document.createTextNode(band.label));
    sizeLegend.append(row);
  });
  const shadeNote = document.createElement("small");
  shadeNote.textContent = "Darker shades indicate larger hail within each size band. Opacity fades with proximity to a report/path; areas beyond 5 mi are transparent.";
  sizeLegend.append(shadeNote);
  container.append(sizeLegend);
  updateHailMapModeControls();
  const estimateHeading = document.createElement("strong");
  estimateHeading.className = "hail-estimate-heading";
  estimateHeading.textContent = "Hail estimate at clicked map point";
  container.append(estimateHeading);
  const overallEstimate = document.createElement("div");
  overallEstimate.className = "hail-map-overall-estimate";
  overallEstimate.setAttribute("aria-live", "polite");
  overallEstimate.textContent = "Click the map to see the estimate.";
  container.append(overallEstimate);
  const estimates = document.createElement("div");
  estimates.className = "hail-map-estimates";
  estimates.setAttribute("aria-live", "polite");
  estimates.textContent = "Size-threshold estimates will appear here.";
  container.append(estimates);
  const estimateNote = document.createElement("small");
  estimateNote.textContent = "Uncalibrated SPC-report proximity estimate, not a meteorological probability or verified hail footprint.";
  container.append(estimateNote);
  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.textContent = "Clear hail map";
  clearButton.addEventListener("click", clearHailMapOverlay);
  container.append(clearButton);
}

function setHailMapDisplayMode(mode) {
  hailMapDisplayMode = mode;
  updateHailMapModeControls();
  hailRadarLayer?.redraw();
  if (hailEstimateMarker) {
    const point = hailEstimateMarker.getLatLng();
    const proximity = estimateHailProximity(point.lat, point.lng, hailEstimateReports);
    const color = hailMapDisplayMode === "percentage"
      ? hailLikelihoodColor(proximity)
      : hailSizeColor(Math.max(0, ...hailEstimateReports
        .filter((report) => distanceToHailReportMiles(point.lat, point.lng, report) <= HAIL_SHADE_RADIUS_MILES)
        .map((report) => report.size)));
    hailEstimateMarker.setStyle({ fillColor: color || "#53636a" });
  }
}

function updateHailMapModeControls() {
  if (!hailLegendControl) return;
  const container = hailLegendControl.getContainer();
  container.querySelectorAll("[data-hail-mode]").forEach((button) => {
    const active = button.dataset.hailMode === hailMapDisplayMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  container.querySelectorAll(".hail-map-mode-legend").forEach((legend) => {
    legend.hidden = legend.classList.contains("hail-map-percentage-legend")
      ? hailMapDisplayMode !== "percentage"
      : hailMapDisplayMode !== "size";
  });
}

function estimateHailProximity(lat, lng, reports) {
  let strongestScore = 0;
  reports.forEach((report) => {
    const distance = distanceToHailReportMiles(lat, lng, report);
    if (distance <= HAIL_SHADE_RADIUS_MILES) {
      strongestScore = Math.max(strongestScore, 1 - distance / HAIL_SHADE_RADIUS_MILES);
    }
  });
  return Math.round(strongestScore * 100);
}

function estimateHailLikelihoods(lat, lng, reports) {
  const likelihoods = new Map(HAIL_SIZE_THRESHOLDS.map((threshold) => [threshold, null]));
  reports.forEach((report) => {
    const distance = distanceToHailReportMiles(lat, lng, report);
    if (distance > HAIL_SHADE_RADIUS_MILES) return;
    const estimate = Math.round((1 - distance / HAIL_SHADE_RADIUS_MILES) * 100);
    HAIL_SIZE_THRESHOLDS.forEach((threshold) => {
      if (report.size >= threshold) {
        likelihoods.set(threshold, Math.max(likelihoods.get(threshold) ?? 0, estimate));
      }
    });
  });
  return likelihoods;
}

function showHailLikelihoodAtLocation(event) {
  if (!hailEstimateReports.length || !hailLegendControl) return;
  const legend = hailLegendControl.getContainer();
  const estimates = legend.querySelector(".hail-map-estimates");
  if (!estimates) return;
  const proximity = estimateHailProximity(event.latlng.lat, event.latlng.lng, hailEstimateReports);
  const overallEstimate = legend.querySelector(".hail-map-overall-estimate");
  overallEstimate.replaceChildren();
  overallEstimate.append(document.createTextNode(proximity < 10 ? "<10% · no shaded zone" : `${proximity}% estimated hail likelihood`));
  if (!hailEstimateMarker) {
    hailEstimateMarker = L.circleMarker(event.latlng, {
      radius: 11,
      color: "#fff",
      weight: 3,
      fillColor: "#53636a",
      fillOpacity: 1,
      bubblingMouseEvents: false,
    }).addTo(map);
  } else {
    hailEstimateMarker.setLatLng(event.latlng);
  }
  const sizeColor = hailSizeColor(Math.max(0, ...hailEstimateReports
    .filter((report) => distanceToHailReportMiles(event.latlng.lat, event.latlng.lng, report) <= HAIL_SHADE_RADIUS_MILES)
    .map((report) => report.size)));
  hailEstimateMarker.setStyle({
    fillColor: hailMapDisplayMode === "percentage" ? hailLikelihoodColor(proximity) || "#53636a" : sizeColor || "#53636a",
  });
  hailEstimateMarker.unbindTooltip();
  hailEstimateMarker.bindTooltip(proximity < 10 ? "<10% hail estimate" : `${proximity}% hail estimate`, {
    permanent: true,
    direction: "top",
    offset: [0, -8],
    className: "hail-estimate-map-tooltip",
  }).openTooltip();
  const likelihoods = estimateHailLikelihoods(event.latlng.lat, event.latlng.lng, hailEstimateReports);
  estimates.replaceChildren();
  HAIL_SIZE_THRESHOLDS.forEach((threshold) => {
    const row = document.createElement("span");
    row.className = "hail-map-estimate-row";
    const size = document.createElement("span");
    size.textContent = `${threshold.toFixed(2)} in or larger`;
    const likelihood = document.createElement("strong");
    const estimate = likelihoods.get(threshold);
    likelihood.textContent = estimate === null ? "No nearby reports" : `${estimate}%`;
    row.append(size, likelihood);
    estimates.append(row);
  });
}

function createHailRadarLayer(reports) {
  const tileSize = 256;
  const radiusDegrees = HAIL_SHADE_RADIUS_MILES / 69;
  const layer = L.gridLayer({ tileSize, opacity: 1, keepBuffer: 2, zIndex: 350, interactive: false });
  layer.createTile = (coords, done) => {
    const sampleSize = coords.z >= 12 ? 192 : coords.z >= 7 ? 96 : 48;
    const step = tileSize / sampleSize;
    const canvas = document.createElement("canvas");
    canvas.width = tileSize;
    canvas.height = tileSize;
    const context = canvas.getContext("2d");
    const samples = document.createElement("canvas");
    samples.width = sampleSize;
    samples.height = sampleSize;
    const sampleContext = samples.getContext("2d");
    const image = sampleContext.createImageData(sampleSize, sampleSize);
    const northWest = map.unproject(L.point(coords.x * tileSize, coords.y * tileSize), coords.z);
    const southEast = map.unproject(L.point((coords.x + 1) * tileSize, (coords.y + 1) * tileSize), coords.z);
    const centerLatitude = (northWest.lat + southEast.lat) / 2;
    const longitudePadding = radiusDegrees / Math.max(Math.cos(centerLatitude * Math.PI / 180), 0.15);
    const tileReports = reports.filter((report) => {
      const minLat = Math.min(report.lat, report.endLat);
      const maxLat = Math.max(report.lat, report.endLat);
      const minLng = Math.min(report.lng, report.endLng);
      const maxLng = Math.max(report.lng, report.endLng);
      return maxLat >= southEast.lat - radiusDegrees && minLat <= northWest.lat + radiusDegrees
        && maxLng >= northWest.lng - longitudePadding && minLng <= southEast.lng + longitudePadding;
    });

    if (tileReports.length) {
      for (let y = 0; y < sampleSize; y += 1) {
        for (let x = 0; x < sampleSize; x += 1) {
          const point = map.unproject(
            L.point(coords.x * tileSize + (x + 0.5) * step, coords.y * tileSize + (y + 0.5) * step),
            coords.z,
          );
          let strongestScore = 0;
          let largestNearbySize = 0;
          tileReports.forEach((report) => {
            const distance = distanceToHailReportMiles(point.lat, point.lng, report);
            if (distance > HAIL_SHADE_RADIUS_MILES) return;
            const score = 1 - distance / HAIL_SHADE_RADIUS_MILES;
            strongestScore = Math.max(strongestScore, score);
            largestNearbySize = Math.max(largestNearbySize, report.size);
          });
          const percent = Math.round(strongestScore * 100);
          const color = strongestScore === 0 ? null
            : hailMapDisplayMode === "percentage" ? hailLikelihoodColor(percent) : hailSizeColor(largestNearbySize);
          if (!color) continue;
          const offset = (y * sampleSize + x) * 4;
          image.data[offset] = Number.parseInt(color.slice(1, 3), 16);
          image.data[offset + 1] = Number.parseInt(color.slice(3, 5), 16);
          image.data[offset + 2] = Number.parseInt(color.slice(5, 7), 16);
          image.data[offset + 3] = hailMapDisplayMode === "percentage"
            ? 220
            : Math.round(strongestScore * 220);
        }
      }
      sampleContext.putImageData(image, 0, 0);
      context.imageSmoothingEnabled = false;
      context.drawImage(samples, 0, 0, tileSize, tileSize);
    }
    done(null, canvas);
    return canvas;
  };
  return layer;
}

function getHailReportFocusBounds(reports) {
  const focusRadiusMiles = 25;
  let focusReports = reports;
  let largestCluster = 0;

  reports.forEach((candidate) => {
    const cluster = reports.filter((report) => (
      distanceToHailReportMiles(candidate.lat, candidate.lng, report) <= focusRadiusMiles
    ));
    if (cluster.length > largestCluster) {
      largestCluster = cluster.length;
      focusReports = cluster;
    }
  });

  const bounds = L.latLngBounds([]);
  focusReports.forEach((report) => {
    bounds.extend([report.lat, report.lng]);
    if (Number.isFinite(report.endLat) && Number.isFinite(report.endLng)) {
      bounds.extend([report.endLat, report.endLng]);
    }
  });
  return bounds;
}

function getHailMapFocusPoints() {
  if (map.getZoom() >= 6) {
    const center = map.getCenter();
    return [{ lat: center.lat, lng: center.lng }];
  }
  if (addressSearchMarker) {
    const point = addressSearchMarker.getLatLng();
    return [{ lat: point.lat, lng: point.lng }];
  }
  return loadEntries()
    .filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lng))
    .map((entry) => ({ lat: entry.lat, lng: entry.lng }));
}

function getHailReportsWithinMapFocus(reports, focusPoints) {
  return focusPoints.length
    ? reports.filter((report) => focusPoints.some((point) => (
      distanceToHailReportMiles(point.lat, point.lng, report) <= HAIL_MAP_FOCUS_RADIUS_MILES
    )))
    : reports;
}

function showHailMapDate(date) {
  createHailDateControl();
  hailDateControl.addTo(map);
  if (hailDateInput) hailDateInput.value = date;
  if (hailDateStatus) hailDateStatus.textContent = `Showing hail reports for ${formatDate(date)}.`;
}

function createHailDateControl() {
  if (hailDateControl) return;
  hailDateControl = L.control({ position: "topleft" });
  hailDateControl.onAdd = () => {
    const container = L.DomUtil.create("div", "hail-map-date leaflet-bar");
    const title = document.createElement("strong");
    title.textContent = "Hail map date";
    hailDateInput = document.createElement("input");
    hailDateInput.type = "date";
    hailDateInput.min = "1999-06-01";
    const latestAvailableDate = new Date();
    latestAvailableDate.setDate(latestAvailableDate.getDate() - 1);
    hailDateInput.max = localDateString(latestAvailableDate);
    hailDateInput.setAttribute("aria-label", "Select a date for hail reports");
    hailDateInput.addEventListener("change", () => loadHailReportsForMapDate());
    hailDateStatus = document.createElement("small");
    hailDateStatus.setAttribute("aria-live", "polite");
    hailDateStatus.textContent = `Search or zoom to an area, then choose a date to show hail reports within ${HAIL_MAP_FOCUS_RADIUS_MILES} miles.`;
    container.append(title, hailDateInput, hailDateStatus);
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    return container;
  };
  hailDateControl.addTo(map);
}

async function loadHailReportsForMapDate() {
  const date = hailDateInput?.value;
  if (!date) {
    if (hailDateStatus) hailDateStatus.textContent = "Select a date first.";
    return;
  }
  if (date < "1999-06-01" || date >= localDateString()) {
    if (hailDateStatus) hailDateStatus.textContent = "Choose a date from June 1, 1999 through yesterday.";
    return;
  }
  hailDateInput.disabled = true;
  hailDateStatus.textContent = "Loading SPC hail reports…";
  try {
    let reports;
    try {
      reports = await loadHailReportsForDay(date);
    } catch (dailyError) {
      const selectedYear = Number(date.slice(0, 4));
      if (selectedYear === new Date().getFullYear()) throw dailyError;
      reports = (await loadHailReportsForYear(selectedYear)).filter((report) => report.date === date);
    }
    const focusPoints = getHailMapFocusPoints();
    const focusedReports = getHailReportsWithinMapFocus(reports, focusPoints);
    const byDay = summarizeHailStormDays(focusedReports);
    if (!byDay.length) {
      clearHailMapOverlay();
      hailDateStatus.textContent = focusPoints.length
        ? `No SPC hail reports within ${HAIL_MAP_FOCUS_RADIUS_MILES} miles of this map area on ${formatDate(date)}.`
        : `No SPC hail reports found for ${formatDate(date)}.`;
      return;
    }
    showHailReportsOnMap(byDay[0], focusPoints.length > 0);
    hailDateStatus.textContent = focusPoints.length
      ? `Showing ${focusedReports.length} hail reports within ${HAIL_MAP_FOCUS_RADIUS_MILES} miles of this map area for ${formatDate(date)}.`
      : `Showing all ${reports.length} available U.S. hail reports for ${formatDate(date)}.`;
  } catch (error) {
    hailDateStatus.textContent = error.message || "Could not load hail reports for that date.";
    setStatus(hailDateStatus.textContent, true);
  } finally {
    hailDateInput.disabled = false;
  }
}

function showHailReportsOnMap(day, fitRegionalReports = false) {
  if (!map) {
    setStatus("The map is unavailable, so hail reports cannot be displayed.", true);
    return;
  }
  clearHailMapOverlay();
  const reports = day.reports.filter((report) => Number.isFinite(report.lat) && Number.isFinite(report.lng));
  if (!reports.length) {
    setStatus(`No mappable hail reports for ${formatDate(day.date)}.`, true);
    return;
  }
  hailEstimateReports = reports;
  hailRadarLayer = createHailRadarLayer(reports).addTo(map);
  hailOverlayMarkers.push(hailRadarLayer);
  createHailMapLegend(day.date);
  showHailMapDate(day.date);
  const bounds = fitRegionalReports ? L.latLngBounds([]) : getHailReportFocusBounds(reports);
  if (fitRegionalReports) {
    reports.forEach((report) => {
      bounds.extend([report.lat, report.lng]);
      if (Number.isFinite(report.endLat) && Number.isFinite(report.endLng)) {
        bounds.extend([report.endLat, report.endLng]);
      }
    });
  }
  if (bounds.isValid()) {
    if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
      map.flyTo(bounds.getCenter(), 12, { duration: 0.7 });
    } else {
      map.flyToBounds(bounds.pad(0.12), { maxZoom: fitRegionalReports ? 9 : 11, duration: 0.7 });
    }
    map.once("moveend", () => hailRadarLayer?.redraw());
  }
  setStatus(`Showing ${reports.length} hail report${reports.length === 1 ? "" : "s"} for ${formatDate(day.date)}. The map colors reported hail sizes immediately${fitRegionalReports ? ` within ${HAIL_MAP_FOCUS_RADIUS_MILES} miles of the selected map area` : " around the largest local report cluster"} and fades with distance. This is not Verisk radar data.`);
}

async function getWindHistory(entry) {
  const range = getHistoryRange();
  const cacheKey = `${entry.lat.toFixed(3)},${entry.lng.toFixed(3)},${range.start},${range.end}`;
  if (!WIND_HISTORY_CACHE.has(cacheKey)) {
    const params = new URLSearchParams({
      latitude: String(entry.lat), longitude: String(entry.lng), start_date: range.start, end_date: range.end,
      hourly: "wind_speed_10m,wind_gusts_10m", wind_speed_unit: "mph", timezone: "auto",
    });
    const request = fetch(`https://archive-api.open-meteo.com/v1/archive?${params}`).then((response) => {
      if (!response.ok) throw new Error("Historical wind is unavailable.");
      return response.json();
    }).catch((error) => { WIND_HISTORY_CACHE.delete(cacheKey); throw error; });
    WIND_HISTORY_CACHE.set(cacheKey, request);
  }
  const data = await WIND_HISTORY_CACHE.get(cacheKey);
  const gridLat = Number(data.latitude);
  const gridLng = Number(data.longitude);
  const distance = Number.isFinite(gridLat) && Number.isFinite(gridLng) ? distanceInMiles(entry.lat, entry.lng, gridLat, gridLng) : 0;
  const times = data.hourly?.time || [];
  const speeds = data.hourly?.wind_speed_10m || [];
  const gusts = data.hourly?.wind_gusts_10m || [];
  const reports = times.map((time, index) => ({ time, speed: speeds[index], gust: gusts[index], distance }))
    .filter((hour) => (Number.isFinite(hour.speed) && hour.speed >= 55) || (Number.isFinite(hour.gust) && hour.gust >= 60));
  return { reports, range };
}

function renderWeatherResults(panel, reports, formatReport, emptyMessage, caveat = "", countLabel = "matching record") {
  const status = panel.querySelector(".door-weather-status");
  const list = panel.querySelector(".door-weather-list");
  status.textContent = reports.length ? `${reports.length} ${countLabel}${reports.length === 1 ? "" : "s"}.` : emptyMessage;
  list.replaceChildren();
  reports.forEach((report) => {
    const item = document.createElement("li");
    item.textContent = formatReport(report);
    list.append(item);
  });
  list.hidden = reports.length === 0;
  if (caveat) {
    const note = document.createElement("small");
    note.className = "door-weather-caveat";
    note.textContent = caveat;
    panel.append(note);
  }
}

async function loadHailHistory(entry, panel) {
  panel.querySelector(".door-weather-status").textContent = "Loading NOAA hail reports, including current-year daily records…";
  try {
    const result = await getHailHistory(entry);
    if (!panel.isConnected) return;
    const days = summarizeHailStormDays(result.reports);
    const status = panel.querySelector(".door-weather-status");
    const list = panel.querySelector(".door-weather-list");
    status.textContent = days.length ? `${days.length} reported storm day${days.length === 1 ? "" : "s"}.` : `No hail reports found within ${HAIL_REPORT_RADIUS_MILES} miles in this period.`;
    list.replaceChildren();
    days.forEach((day) => {
      const item = document.createElement("li");
      const nearestReport = day.reports.reduce((nearest, report) => (
        report.distance < nearest.distance ? report : nearest
      ), day.reports[0]);
      const direction = hailReportDirectionFromPoint(entry.lat, entry.lng, nearestReport);
      const mapButton = document.createElement("button");
      mapButton.className = "hail-day-date-button";
      mapButton.type = "button";
      mapButton.textContent = formatDate(day.date);
      mapButton.setAttribute("aria-label", `Show hail reports from ${formatDate(day.date)} on map`);
      mapButton.addEventListener("click", () => showHailReportsOnMap(day));
      L.DomEvent.disableClickPropagation(mapButton);
      const summary = document.createElement("span");
      summary.textContent = `Largest hail ${day.largestSize.toFixed(2)} in · nearest report ${formatHailDistanceAndDirection(day.nearestDistance, direction)} · ${day.reportCount} report${day.reportCount === 1 ? "" : "s"}`;
      item.append(mapButton, summary);
      list.append(item);
    });
    list.hidden = days.length === 0;
    panel.querySelector(".door-weather-caveat")?.remove();
    const note = document.createElement("small");
    note.className = "door-weather-caveat";
    note.textContent = result.partial
      ? "Some NOAA report files were unavailable; results may be incomplete. Daily sizes are the largest nearby reports, not verified property measurements."
      : "Distance and direction are from the pin to the nearest point on each reported path. NOAA/SPC locations and paths are approximate observations, not verified hail footprints at this address.";
    panel.append(note);
  } catch {
    panel.dataset.loaded = "false";
    panel.querySelector(".door-weather-status").textContent = "Could not load NOAA hail reports. Check your connection and try again.";
  }
}

async function loadWindHistory(entry, panel) {
  panel.querySelector(".door-weather-status").textContent = "Loading historical wind…";
  try {
    const result = await getWindHistory(entry);
    if (!panel.isConnected) return;
    renderWeatherResults(panel, result.reports,
      (hour) => `${hour.time.replace("T", " · ")} · ${Math.round(hour.speed)} mph average · ${Math.round(hour.gust)} mph gust · ${hour.distance.toFixed(1)} mi from grid point`,
      "No hours met either wind threshold in this period.",
      "Open-Meteo hourly historical model at the nearest grid point; not an on-site measurement.");
  } catch {
    panel.dataset.loaded = "false";
    panel.querySelector(".door-weather-status").textContent = "Could not load historical wind. Check your connection and try again.";
  }
}

function activateWeatherTab(entry, history, kind) {
  history.querySelectorAll("[data-weather-tab]").forEach((button) => {
    const active = button.dataset.weatherTab === kind;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  history.querySelectorAll("[data-weather-panel]").forEach((panel) => { panel.hidden = panel.dataset.weatherPanel !== kind; });
  const panel = history.querySelector(`[data-weather-panel="${kind}"]`);
  if (panel.dataset.loaded === "true") return;
  panel.dataset.loaded = "true";
  if (kind === "hail") loadHailHistory(entry, panel);
  else loadWindHistory(entry, panel);
}

function escapeReportText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function generateStormReport(entry) {
  const reportWindow = window.open("", "_blank");
  if (!reportWindow) {
    setStatus("Allow pop-ups to generate the storm report.", true);
    return;
  }
  reportWindow.opener = null;
  reportWindow.document.write("<!doctype html><title>Storm report</title><p>Loading storm history…</p>");
  Promise.allSettled([getHailHistory(entry), getWindHistory(entry)]).then(([hailResult, windResult]) => {
    if (reportWindow.closed) return;
    const hail = hailResult.status === "fulfilled" ? hailResult.value : null;
    const wind = windResult.status === "fulfilled" ? windResult.value : null;
    const hailRows = hail?.reports.map((report) => `<tr><td>${escapeReportText(report.date)} ${escapeReportText(report.time?.slice(0, 5))}</td><td>${report.size.toFixed(2)} in</td><td>${escapeReportText(formatHailDistanceAndDirection(report.distance, hailReportDirectionFromPoint(entry.lat, entry.lng, report)))}</td></tr>`).join("") || "<tr><td colspan=\"3\">No nearby hail reports found or data unavailable.</td></tr>";
    const windRows = wind?.reports.map((hour) => `<tr><td>${escapeReportText(hour.time.replace("T", " "))}</td><td>${Math.round(hour.speed)} mph</td><td>${Math.round(hour.gust)} mph</td><td>${hour.distance.toFixed(1)} mi</td></tr>`).join("") || "<tr><td colspan=\"4\">No hours met either threshold or data unavailable.</td></tr>";
    const range = getHistoryRange();
    reportWindow.document.open();
    reportWindow.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Storm report · ${escapeReportText(entry.address)}</title><style>
      body{max-width:900px;margin:36px auto;padding:0 22px;font:15px Arial,sans-serif;color:#202a28}h1{margin:0 0 8px;font-size:26px}h2{margin:28px 0 8px;font-size:18px}.meta{color:#596970;line-height:1.6}.note{color:#66757a;font-size:12px;line-height:1.5}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{padding:9px 8px;border-bottom:1px solid #dfe5e3;text-align:left}th{background:#f1f4f2;font-size:12px}.actions{margin:22px 0}.actions button{padding:9px 14px;cursor:pointer}@media print{body{margin:0 auto}.actions{display:none}tr{break-inside:avoid}}
      </style></head><body><h1>Kanvas Kings Storm Report</h1><div class="meta">${entry.contact ? `<strong>Name:</strong> ${escapeReportText(entry.contact)}<br>` : ""}<strong>Address:</strong> ${escapeReportText(entry.address)}<br><strong>Door outcome:</strong> ${escapeReportText(entry.outcome)}<br><strong>Visit date:</strong> ${escapeReportText(entry.date)}${entry.notes ? `<br><strong>Notes:</strong> ${escapeReportText(entry.notes)}` : ""}<br><strong>Report period:</strong> ${range.start} through ${range.end}<br><strong>Generated:</strong> ${new Date().toLocaleString()}</div><div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
      <h2>Nearby hail reports</h2><p class="note">NOAA/SPC hail reports within ${HAIL_REPORT_RADIUS_MILES} miles. Distance is measured to the reported start-to-end path where available, and direction points from the pin to the nearest point on that path. Report locations and paths are approximate observations, not verified hail footprints or confirmation at the exact property. ${hail?.partial ? "Some NOAA report files were unavailable." : hail ? "" : "Hail report data could not be loaded."}</p><table><thead><tr><th>Date / time</th><th>Reported hail size</th><th>Distance / direction from pin</th></tr></thead><tbody>${hailRows}</tbody></table>
      <h2>High-wind hours</h2><p class="note">Open-Meteo hourly historical model. Included when average wind is at least 55 mph or gusts are at least 60 mph. Distance is from the address to the nearest model grid point. ${wind ? "Modeled estimates, not on-site measurements." : "Wind history could not be loaded."}</p><table><thead><tr><th>Date / hour</th><th>Average wind</th><th>Gust</th><th>Grid distance</th></tr></thead><tbody>${windRows}</tbody></table></body></html>`);
    reportWindow.document.close();
  });
}

function fitMap() {
  if (!map || !markers.length) return;
  const bounds = L.featureGroup(markers).getBounds();
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.22), { maxZoom: 16 });
}

function zoomToSearchResults() {
  if (!map || !el.search.value.trim()) return;
  const points = filteredEntries(loadEntries())
    .filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lng))
    .map((entry) => [entry.lat, entry.lng]);
  const uniquePoints = [...new Map(points.map((point) => [`${point[0]},${point[1]}`, point])).values()];
  if (uniquePoints.length === 1) {
    map.flyTo(uniquePoints[0], 18, { duration: 0.7 });
  } else if (uniquePoints.length > 1) {
    const bounds = L.latLngBounds(uniquePoints);
    if (bounds.isValid()) map.flyToBounds(bounds.pad(0.22), { maxZoom: 16, duration: 0.7 });
  }
}

function renderMap(entries) {
  if (!map) return;
  clearHailMapOverlay();
  markers.forEach((marker) => map.removeLayer(marker));
  markers = [];
  entries.filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lng)).forEach((entry) => {
    const marker = L.marker([entry.lat, entry.lng], { draggable: true, icon: createDoorIcon(entry), title: `${entry.address} (drag to adjust location)` }).addTo(map);
    marker.bindPopup(createPopup(entry, marker));
    marker.on("popupopen", (event) => {
      const history = event.popup.getElement()?.querySelector(".door-weather");
      if (history) {
        activateWeatherTab(entry, history, "hail");
        const photoPanel = history.querySelector(".pin-photo-panel");
        photoPanel.querySelector(".pin-photo-status").textContent = "Loading photos…";
        loadPinPhotos(entry.id, photoPanel).catch((error) => {
          photoPanel.querySelector(".pin-photo-status").textContent = error.message || "Could not load photos for this pin.";
          setStatus(photoPanel.querySelector(".pin-photo-status").textContent, true);
        });
      }
    });
    marker.on("popupclose", (event) => {
      const photoPanel = event.popup.getContent()?.querySelector?.(".pin-photo-panel");
      if (photoPanel) releasePinPhotoUrls(photoPanel);
    });
    marker.on("dragend", async () => {
      const location = marker.getLatLng();
      const savedEntries = loadEntries();
      const savedEntry = savedEntries.find((item) => item.id === entry.id);
      if (!savedEntry) return;
      savedEntry.lat = location.lat;
      savedEntry.lng = location.lng;
      if (await saveEntries(savedEntries)) setStatus(`Saved new map location for ${savedEntry.address}.`);
    });
    markers.push(marker);
  });
}

function render() {
  const entries = loadEntries();
  updateStats(entries);
  renderTable(entries);
  renderMap(entries);
}

async function nominatimRequest(url) {
  const delay = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  lastGeocodeAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error("The location service is unavailable. Try again in a moment.");
    return response.json();
  } finally { clearTimeout(timeout); }
}

async function geocode(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=${encodeURIComponent(address)}`;
  const results = await nominatimRequest(url);
  if (!results.length) return null;
  const result = results[0];
  const lat = Number(result.lat), lng = Number(result.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, label: result.display_name || address } : null;
}

async function searchMapAddress(event) {
  event.preventDefault();
  if (searchingAddress) return;
  if (!navigator.onLine) { setStatus("Reconnect to search for an address.", true); return; }
  searchingAddress = true;
  el.mapSearchButton.disabled = true;
  setStatus("Searching for the address…");
  try {
    const result = await geocode(el.mapAddressSearch.value.trim());
    if (!result) { setStatus("Address not found. Try adding the city, state, and ZIP code.", true); return; }
    if (addressSearchMarker) map.removeLayer(addressSearchMarker);
    addressSearchMarker = L.circleMarker([result.lat, result.lng], { radius: 12, color: "#fff", weight: 3, fillColor: "#1876e8", fillOpacity: 1 }).addTo(map);
    const popup = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = result.label;
    popup.append(label);
    addressSearchMarker.bindPopup(popup);
    map.flyTo([result.lat, result.lng], 19, { duration: 0.7 });
    addressSearchMarker.openPopup();
    setStatus("Address located. This search marker is temporary; save a door to keep it.");
  } catch (error) {
    const message = error.name === "AbortError" ? "Address search timed out. Try again." : error.message || "Could not search for that address.";
    setStatus(message, true);
  } finally {
    searchingAddress = false;
    el.mapSearchButton.disabled = false;
  }
}

async function reverseGeocode(lat, lng) {
  const params = new URLSearchParams({ format: "jsonv2", lat: String(lat), lon: String(lng), zoom: "18", addressdetails: "1" });
  const result = await nominatimRequest(`https://nominatim.openstreetmap.org/reverse?${params}`);
  const details = result.address || {};
  const street = [details.house_number, details.road || details.pedestrian || details.residential].filter(Boolean).join(" ");
  const locality = details.city || details.town || details.village || details.hamlet || details.municipality;
  const address = [street, locality, details.state, details.postcode].filter(Boolean).join(", ");
  return address || result.display_name || null;
}

function createMapDoorPopup(lat, lng) {
  const content = document.createElement("div");
  content.className = "map-door-popup";
  const title = document.createElement("strong");
  title.className = "map-door-title";
  title.textContent = "Log this door";
  const form = document.createElement("form");
  const contactLabel = document.createElement("label");
  contactLabel.className = "map-door-field";
  contactLabel.textContent = "Name";
  const contactInput = document.createElement("input");
  contactInput.type = "text";
  contactInput.placeholder = "Name at the door";
  contactInput.maxLength = 100;
  contactInput.autocomplete = "name";
  contactLabel.append(contactInput);
  const addressLabel = document.createElement("label");
  addressLabel.className = "map-door-field";
  addressLabel.textContent = "Address";
  const addressInput = document.createElement("input");
  addressInput.type = "text";
  addressInput.required = true;
  addressInput.placeholder = "Finding address…";
  addressInput.maxLength = 180;
  addressLabel.append(addressInput);
  const outcomeLabel = document.createElement("label");
  outcomeLabel.className = "map-door-field";
  outcomeLabel.textContent = "Door outcome";
  const outcomeSelect = document.createElement("select");
  outcomeSelect.required = true;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose an outcome";
  placeholder.selected = true;
  placeholder.disabled = true;
  outcomeSelect.append(placeholder);
  OUTCOMES.forEach((outcome) => {
    const option = document.createElement("option");
    option.value = outcome;
    option.textContent = outcome;
    outcomeSelect.append(option);
  });
  outcomeLabel.append(outcomeSelect);
  const status = document.createElement("p");
  status.className = "map-door-status";
  status.textContent = "Looking up the address…";
  const saveButton = document.createElement("button");
  saveButton.className = "button button-primary map-door-save";
  saveButton.type = "submit";
  saveButton.textContent = "Save door";
  saveButton.disabled = true;
  form.append(contactLabel, addressLabel, outcomeLabel, status, saveButton);
  content.append(title, form);
  L.DomEvent.disableClickPropagation(content);
  L.DomEvent.disableScrollPropagation(content);

  function enableManualEntry(message) {
    addressInput.placeholder = "Enter the street address";
    outcomeSelect.disabled = false;
    saveButton.disabled = false;
    status.textContent = message;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    saveButton.disabled = true;
    status.textContent = "Saving door…";
    const entry = {
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      date: localDateString(),
      address: addressInput.value.trim(),
      outcome: outcomeSelect.value,
      contact: contactInput.value.trim(),
      phone: "",
      notes: "",
      lat,
      lng,
    };
    const entries = loadEntries();
    entries.unshift(entry);
    if (!await saveEntries(entries)) {
      saveButton.disabled = false;
      status.textContent = "Could not save this door. Try again.";
      return;
    }
    map.closePopup();
    render();
    map.setView([lat, lng], Math.max(map.getZoom(), 18));
    setStatus(`${entry.outcome} saved for ${entry.address}.`);
  });

  return { content, title, contactInput, addressInput, outcomeSelect, status, saveButton, enableManualEntry };
}

async function fillAddressFromMap(event) {
  if (lookingUpMapAddress) return;
  const { lat, lng } = event.latlng;
  const point = L.latLng(lat, lng);
  map.setView(point, Math.max(map.getZoom(), 18));
  const popupForm = createMapDoorPopup(lat, lng);
  const popup = L.popup({ maxWidth: 280, closeButton: true }).setLatLng(point).setContent(popupForm.content).openOn(map);
  if (!navigator.onLine) {
    popupForm.enableManualEntry("Offline. Enter the address to continue.");
    setStatus("Reconnect for automatic address lookup, or enter it in the map popup.", true);
    return;
  }

  lookingUpMapAddress = true;
  setStatus("Finding the house address…");
  try {
    const address = await reverseGeocode(lat, lng);
    if (!popup.isOpen()) return;
    if (address) {
      popupForm.addressInput.value = address;
      popupForm.title.textContent = address;
      popupForm.outcomeSelect.disabled = false;
      popupForm.saveButton.disabled = false;
      popupForm.status.textContent = "Choose an outcome, then save.";
    } else {
      popupForm.enableManualEntry("No address found here. Enter it manually.");
    }
  } catch (error) {
    if (!popup.isOpen()) return;
    const message = error.name === "AbortError" ? "Address lookup timed out. Enter the address manually." : "Could not look up this address. Enter it manually.";
    popupForm.enableManualEntry(message);
  } finally { lookingUpMapAddress = false; }
}

async function addEntry(event) {
  event.preventDefault();
  if (addingDoor || !el.form.reportValidity()) return;
  if (!navigator.onLine) { setStatus("You’re offline. Reconnect to look up and pin this address.", true); return; }
  addingDoor = true;
  el.saveButton.disabled = true;
  setStatus("Finding this address on the map…");
  try {
    const coordinates = await geocode(el.address.value.trim());
    if (!coordinates) { setStatus("Address not found. Add a city, state, and ZIP code, then try again.", true); return; }
    const entry = {
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`, date: el.date.value, address: el.address.value.trim(), outcome: el.outcome.value,
      contact: el.contact.value.trim(), phone: el.phone.value.trim(), notes: el.notes.value.trim(), lat: coordinates.lat, lng: coordinates.lng,
    };
    const entries = loadEntries();
    entries.unshift(entry);
    if (!await saveEntries(entries)) return;
    el.form.reset();
    el.date.value = localDateString();
    setStatus("Door saved and pinned.");
    render();
    map?.setView([coordinates.lat, coordinates.lng], 16);
  } catch (error) {
    const message = error.name === "AbortError" ? "Address lookup timed out. Check your connection and try again." : error.message || "Could not find that address. Check your connection and try again.";
    setStatus(message, true);
  } finally { addingDoor = false; el.saveButton.disabled = false; }
}

async function deleteEntry(id) {
  const entries = loadEntries();
  const entry = entries.find((item) => item.id === id);
  if (entry && confirm(`Delete the record for ${entry.address}?`) && await saveEntries(entries.filter((item) => item.id !== id))) {
    render();
    if (globalThis.indexedDB) deletePinPhotos(id).catch((error) => setStatus(`Door deleted, but its photos could not be removed: ${error.message || "storage error"}`, true));
  }
}

async function clearAll() {
  const entries = loadEntries();
  if (!entries.length) { setStatus("There are no saved records to clear."); return; }
  if (confirm("Delete every saved door record and map pin? This cannot be undone.") && await saveEntries([])) {
    render();
    setStatus("All door records have been cleared.");
    if (globalThis.indexedDB) {
      Promise.all(entries.map((entry) => deletePinPhotos(entry.id))).catch((error) => {
        setStatus(`Door records were cleared, but some photos could not be removed: ${error.message || "storage error"}`, true);
      });
    }
  }
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s]*[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportCSV() {
  const entries = loadEntries();
  if (!entries.length) { setStatus("Add a door before exporting results."); return; }
  const rows = [["Date", "Address", "Outcome", "Contact", "Phone or email", "Notes", "Latitude", "Longitude"]];
  entries.forEach((entry) => rows.push([entry.date, entry.address, entry.outcome, entry.contact, entry.phone, entry.notes, entry.lat, entry.lng]));
  const url = URL.createObjectURL(new Blob([`\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `door-knock-results-${localDateString()}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function updateOnlineStatus() {
  const online = navigator.onLine;
  el.offlineNote.hidden = online;
  el.connection.classList.toggle("offline", !online);
  el.connectionLabel.textContent = online ? "Online" : "Offline";
  if (!online) el.mapFallback.hidden = false;
  else if (map) el.mapFallback.hidden = true;
}

function initializeMap() {
  if (typeof L === "undefined") { el.mapFallback.hidden = false; el.mapFallback.textContent = "The map library couldn’t load. Saved door records are still available."; return; }
  map = L.map("map", { scrollWheelZoom: true, doubleClickZoom: false, touchZoom: true, keyboard: true, zoomSnap: 0.5 });
  map.fitBounds(US_BOUNDS, { padding: [12, 12] });
  const tileProviders = [
    {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      options: { maxZoom: 19, attribution: 'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community' },
    },
    {
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      options: { subdomains: "abcd", maxZoom: 20, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' },
    },
  ];
  let activeLayer;
  let activeProvider = -1;
  function loadTileProvider(index) {
    activeProvider = index;
    let failures = 0;
    if (activeLayer) map.removeLayer(activeLayer);
    activeLayer = L.tileLayer(tileProviders[index].url, tileProviders[index].options);
    activeLayer.on("tileerror", () => {
      if (index !== activeProvider) return;
      failures += 1;
      if (failures >= 3 && index + 1 < tileProviders.length) {
        loadTileProvider(index + 1);
      } else if (failures >= 3) {
        el.mapFallback.hidden = false;
        el.mapFallback.textContent = navigator.onLine
          ? "Map providers are blocked or unavailable. Door records remain available; check your network access."
          : "Map tiles need an internet connection. Your saved door records are still available.";
      }
    });
    activeLayer.on("tileload", () => {
      if (index === activeProvider) el.mapFallback.hidden = true;
    });
    activeLayer.addTo(map);
  }
  loadTileProvider(0);
  createHailDateControl();
  map.on("click", showHailLikelihoodAtLocation);
  map.on("dblclick", fillAddressFromMap);
}

function setLocationStatus(message) {
  el.locationStatus.textContent = message;
  el.locationStatus.hidden = !message;
}

function setLocationButtonActive(active) {
  el.locateButton.classList.toggle("tracking", active);
  el.locateButton.setAttribute("aria-pressed", String(active));
  el.locateButton.title = active ? "Stop live location" : "Start live location";
  el.locateButton.setAttribute("aria-label", el.locateButton.title);
}

function stopLocationTracking() {
  if (locationWatchId !== null) navigator.geolocation.clearWatch(locationWatchId);
  locationWatchId = null;
  if (locationMarker) map.removeLayer(locationMarker);
  if (locationAccuracy) map.removeLayer(locationAccuracy);
  locationMarker = null;
  locationAccuracy = null;
  setLocationButtonActive(false);
}

function updateUserLocation(position) {
  if (locationWatchId === null) return;
  const point = [position.coords.latitude, position.coords.longitude];
  const accuracy = Math.max(position.coords.accuracy || 0, 10);
  if (!locationAccuracy) {
    locationAccuracy = L.circle(point, { radius: accuracy, color: "#2580ed", weight: 1, fillColor: "#2580ed", fillOpacity: 0.12, interactive: false }).addTo(map);
    locationMarker = L.circleMarker(point, { radius: 9, color: "#fff", weight: 3, fillColor: "#1876e8", fillOpacity: 1, bubblingMouseEvents: false }).addTo(map);
    map.setView(point, Math.max(map.getZoom(), 16));
  } else {
    locationAccuracy.setLatLng(point);
    locationAccuracy.setRadius(accuracy);
    locationMarker.setLatLng(point);
    map.panTo(point, { animate: true, duration: 0.3 });
  }
  setLocationStatus("Live location");
}

function handleLocationError(error) {
  if (error.code === error.PERMISSION_DENIED) {
    stopLocationTracking();
    setLocationStatus("Location permission is blocked. Allow it in your browser settings.");
    return;
  }
  setLocationStatus(error.code === error.TIMEOUT ? "Waiting for a location signal…" : "Your device couldn’t determine its location.");
}

function toggleLocationTracking() {
  if (locationWatchId !== null) {
    stopLocationTracking();
    setLocationStatus("");
    return;
  }
  if (!navigator.geolocation) {
    setLocationStatus("This browser doesn’t support live location.");
    return;
  }
  if (!window.isSecureContext) {
    setLocationStatus("Live location requires HTTPS or localhost.");
    return;
  }
  setLocationButtonActive(true);
  setLocationStatus("Finding your location…");
  try {
    locationWatchId = navigator.geolocation.watchPosition(updateUserLocation, handleLocationError, { enableHighAccuracy: true, maximumAge: 1500, timeout: 20000 });
  } catch {
    stopLocationTracking();
    setLocationStatus("Couldn’t start location tracking.");
  }
}

async function fetchCompanyEntries() {
  const { data, error } = await window.kanvasSupabase.client
    .from("door_entries")
    .select("id,date,address,outcome,contact,phone,notes,lat,lng")
    .eq("company_id", currentOrganization.company_id)
    .order("date", { ascending: false });
  if (error) throw error;
  const entries = data.map((row) => ({
    id: row.id,
    date: row.date,
    address: row.address,
    outcome: row.outcome,
    contact: row.contact,
    phone: row.phone,
    notes: row.notes,
    lat: row.lat,
    lng: row.lng,
  }));
  localStorage.setItem(entriesStorageKey(), JSON.stringify(entries));
  return entries;
}

function setWorkspaceLabel(companyName) {
  const label = document.querySelector("#workspace-label");
  const signOut = document.querySelector("#workspace-signout");
  label.textContent = companyName;
  label.title = `Company workspace: ${companyName}`;
  label.hidden = false;
  signOut.hidden = false;
}

async function initializeWorkspace() {
  const workspace = window.kanvasSupabase;
  if (!workspace?.configured) return true;
  if (!workspace.client) {
    setStatus(workspace.configurationError || "Supabase could not be initialized.", true);
    return false;
  }
  const { data: sessionData, error: sessionError } = await workspace.client.auth.getSession();
  if (sessionError) {
    setStatus(`Could not check your company login: ${sessionError.message}`, true);
    return false;
  }
  const session = sessionData.session;
  if (!session) {
    location.replace("./company-access.html");
    return false;
  }

  let companyInfo;
  const { data: memberships, error: membershipError } = await workspace.client.rpc("get_my_company");
  if (!membershipError && memberships?.length) {
    companyInfo = {
      company_id: memberships[0].company_id,
      company_name: memberships[0].company_name,
      role: memberships[0].role,
    };
    localStorage.setItem(`kanvaskings-company-cache:${session.user.id}`, JSON.stringify(companyInfo));
  } else if (!navigator.onLine) {
    try {
      companyInfo = JSON.parse(localStorage.getItem(`kanvaskings-company-cache:${session.user.id}`) || "null");
    } catch {
      companyInfo = null;
    }
    if (!companyInfo?.company_id) {
      setStatus("Offline and no cached company workspace is available. Reconnect to sign in.", true);
      return false;
    }
  } else if (membershipError) {
    setStatus(`Could not load your company workspace: ${membershipError.message}`, true);
    return false;
  } else {
    location.replace("./company-access.html?message=workspace");
    return false;
  }

  currentOrganization = companyInfo;
  setWorkspaceLabel(companyInfo.company_name);
  try {
    await fetchCompanyEntries();
  } catch (error) {
    if (navigator.onLine) {
      setStatus(`Could not load shared company logs: ${error.message || "connection error"}`, true);
      return false;
    }
    setStatus("Offline — showing this company’s last synced logs. Changes need an internet connection.", true);
  }

  if (navigator.onLine) {
    workspaceRealtimeChannel = workspace.client
      .channel(`company-door-entries-${companyInfo.company_id}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "door_entries",
        filter: `company_id=eq.${companyInfo.company_id}`,
      }, async () => {
        try {
          await fetchCompanyEntries();
          render();
        } catch (error) {
          setStatus(`Could not refresh shared company logs: ${error.message || "connection error"}`, true);
        }
      })
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setStatus("Live company updates are unavailable. Reload to check for newer logs.", true);
        }
      });
  }
  workspace.client.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") location.replace("./company-access.html");
  });
  return true;
}

function initializeTracker() {
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date());
  restoreBrandLogo();
  el.date.value = localDateString();
  initializeMap();
  render();
  updateOnlineStatus();
  el.form.addEventListener("submit", addEntry);
  el.brandLogoButton.addEventListener("click", () => el.brandLogoInput.click());
  el.brandLogoInput.addEventListener("change", () => {
    saveBrandLogo(el.brandLogoInput.files[0]);
    el.brandLogoInput.value = "";
  });
  el.brandPasteButton.addEventListener("click", pasteBrandLogo);
  document.addEventListener("paste", handleLogoPaste);
  el.brandLogoDropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    el.brandLogoDropzone.classList.add("drag-over");
  });
  el.brandLogoDropzone.addEventListener("dragleave", () => el.brandLogoDropzone.classList.remove("drag-over"));
  el.brandLogoDropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    el.brandLogoDropzone.classList.remove("drag-over");
    saveBrandLogo(event.dataTransfer.files[0]);
  });
  el.mapSearchForm.addEventListener("submit", searchMapAddress);
  el.filter.addEventListener("change", () => { render(); zoomToSearchResults(); });
  el.search.addEventListener("input", () => { render(); zoomToSearchResults(); });
  el.entries.addEventListener("click", (event) => { const button = event.target.closest("button[data-delete-id]"); if (button) deleteEntry(button.dataset.deleteId); });
  document.querySelector("#fit-map").addEventListener("click", fitMap);
  el.locateButton.addEventListener("click", toggleLocationTracking);
  document.querySelector("#clear-all").addEventListener("click", clearAll);
  document.querySelector("#export-csv").addEventListener("click", exportCSV);
  document.querySelector("#print-results").addEventListener("click", () => window.print());
  document.querySelector("#workspace-signout").addEventListener("click", async () => {
    if (!window.kanvasSupabase?.client) return;
    const { error } = await window.kanvasSupabase.client.auth.signOut();
    if (error) setStatus(`Could not sign out: ${error.message}`, true);
    else location.replace("./company-access.html");
  });
  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);
  window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); installPrompt = event; document.querySelector("#install-button").hidden = false; });
  document.querySelector("#install-button").addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    document.querySelector("#install-button").hidden = true;
  });
  if ("serviceWorker" in navigator && location.protocol !== "file:") window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}

initializeWorkspace().then((ready) => {
  if (ready) initializeTracker();
}).catch((error) => {
  setStatus(`Could not initialize the company workspace: ${error.message || "unexpected error"}`, true);
});