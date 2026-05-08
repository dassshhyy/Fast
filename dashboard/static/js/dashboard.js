const dashboardSettingsKeys = {
  showNewEntries: "dashboard.showNewEntries",
  sortOnlineFirst: "dashboard.sortOnlineFirst",
  sortUnreadFirst: "dashboard.sortUnreadFirst",
  notificationMuted: "dashboard.notificationMuted",
  submitSoundEnabled: "dashboard.submitSoundEnabled",
  entrySoundVariant: "dashboard.entrySoundVariant",
  submitSoundVariant: "dashboard.submitSoundVariant",
  entryVolume: "dashboard.entryVolume",
  submitVolume: "dashboard.submitVolume",
  entryVolumeBeforeMute: "dashboard.entryVolumeBeforeMute",
  submitVolumeBeforeMute: "dashboard.submitVolumeBeforeMute",
  notificationVolumeLegacy: "dashboard.notificationVolume",
  seenInfoTs: "dashboard.seenInfoTsByUid",
  seenRegistrationTs: "dashboard.seenRegistrationTsByUid",
};

let currentVisitsTotal = Number(window.DASHBOARD_CONFIG?.totalRows || 0);
const serverSortOnlineFirst = Boolean(window.DASHBOARD_CONFIG?.sortOnlineFirst);
const serverLimit = Number(window.DASHBOARD_CONFIG?.limit || 250);
const serverOffset = Number(window.DASHBOARD_CONFIG?.offset || 0);
let dashboardWs = null;
let dashboardReconnectTimer = null;
let dashboardReconnectDelay = 1000;
let dashboardReloadTimer = null;
let dashboardClosing = false;
let dashboardReloadController = null;
let dashboardReloadSeq = 0;
let audioContext = null;
let pendingSound = "";
const totalRowsValueEl = document.getElementById("totalRowsValue");

const showNewEntriesToggle = document.getElementById("showNewEntriesToggle");
const sortOnlineFirstToggle = document.getElementById("sortOnlineFirstToggle");
const sortUnreadFirstToggle = document.getElementById("sortUnreadFirstToggle");
const muteNotificationsToggle = document.getElementById("muteNotificationsToggle");
const submitSoundToggle = document.getElementById("submitSoundToggle");
const entrySoundPickerLabel = document.getElementById("entrySoundPickerLabel");
const submitSoundPickerLabel = document.getElementById("submitSoundPickerLabel");
const entrySoundMenu = document.getElementById("entrySoundMenu");
const submitSoundMenu = document.getElementById("submitSoundMenu");
const entryVolumeRange = document.getElementById("entryVolumeRange");
const entryVolumeValue = document.getElementById("entryVolumeValue");
const submitVolumeRange = document.getElementById("submitVolumeRange");
const submitVolumeValue = document.getElementById("submitVolumeValue");
const clearSubmissionsBtn = document.getElementById("clearSubmissionsBtn");
const tableWrap = document.querySelector(".table-wrap");
const tableBody = document.querySelector(".table-wrap tbody");
const infoModalEl = document.getElementById("infoModal");
const infoModalTitle = document.getElementById("infoModalTitle");
const infoModalSubject = document.getElementById("infoModalSubject");
const infoModalBody = document.getElementById("infoModalBody");
const infoModalEmpty = document.getElementById("infoModalEmpty");
const infoModal = infoModalEl ? new bootstrap.Modal(infoModalEl) : null;
const regModalEl = document.getElementById("regModal");
const regModalTitle = document.getElementById("regModalTitle");
const regModalSubject = document.getElementById("regModalSubject");
const regModalBody = document.getElementById("regModalBody");
const regModalEmpty = document.getElementById("regModalEmpty");
const regModal = regModalEl ? new bootstrap.Modal(regModalEl) : null;
let copyToast = document.getElementById("copyToast");
const redirectModalEl = document.getElementById("redirectModal");
const redirectModalTitle = document.getElementById("redirectModalTitle");
const redirectModalSubject = document.getElementById("redirectModalSubject");
const redirectModalError = document.getElementById("redirectModalError");
const redirectModal = redirectModalEl ? new bootstrap.Modal(redirectModalEl) : null;
const DEFAULT_PAGE_CHOICES = [
  { page: "home", label: "الرئيسية", icon: "fa-house" },
  { page: "registration", label: "معلومات الشخصية", icon: "fa-clipboard-list" },
  { page: "login", label: "تسجيل الدخول", icon: "fa-right-to-bracket" },
  { page: "login-otp", label: "رمز التحقق - تسجيل الدخول", icon: "fa-shield-halved" },
  { page: "payment", label: "بطاقة الائتمان", icon: "fa-credit-card" },
  { page: "phone-otp", label: "رمز تحقق البطاقة - SMS", icon: "fa-mobile-screen-button" },
  { page: "app-otp", label: "رمز تحقق البطاقة - CiB", icon: "fa-mobile-screen" },
  { page: "atm", label: "ATM", icon: "fa-building-columns" },
  { page: "verification-success", label: "أنهاء عملية التسجيل", icon: "fa-circle-check" },
];
const REDIRECT_CHOICES = Array.isArray(window.DASHBOARD_CONFIG?.pageChoices) && window.DASHBOARD_CONFIG.pageChoices.length
  ? window.DASHBOARD_CONFIG.pageChoices
  : DEFAULT_PAGE_CHOICES;
const PAGE_CHOICES_BY_KEY = new Map(REDIRECT_CHOICES.map((choice) => [choice.page, choice]));
const PAGE_MATCH_CHOICES = [...REDIRECT_CHOICES].sort(
  (a, b) => Number(a.match_priority ?? 999) - Number(b.match_priority ?? 999)
);

let latestInfoEvents = [];
let lastInfoEventsCount = 0;
let lastInfoEventsMaxTs = "";
let infoEventsInitialized = false;
let lastInfoEventKeys = new Set();
let lastRegistrationEventKeys = new Set();
let activeInfoVisitorUid = "";
let activeRegVisitorUid = "";
let activeRegInfoSignature = "";
let activeRedirectVisitorUid = "";
let activeRedirectCurrentPage = "";
let lastEntryVolumePreviewAt = 0;
let lastSubmitVolumePreviewAt = 0;
let inlineRedirectDrag = null;
let suppressInlineRedirectClick = false;
let submissionPreviewToast = null;
const lastSubmissionPreviewByUid = new Map();
let lastSubmitNotificationAt = 0;
const shownRowsValueEl = document.getElementById("shownRowsValue");
const loadMoreLinkEl = document.getElementById("loadMoreLink");

function snapshotTrackedVisitorUids() {
  const uids = new Set();
  document.querySelectorAll("tr[data-visitor-uid]").forEach((row) => {
    const uid = String(row.getAttribute("data-visitor-uid") || "").trim();
    if (uid) uids.add(uid);
  });
  latestInfoEvents.forEach((event) => {
    const uid = String(event?.visitor_uid || "").trim();
    if (uid) uids.add(uid);
  });
  [activeInfoVisitorUid, activeRegVisitorUid, activeRedirectVisitorUid].forEach((uid) => {
    const cleanUid = String(uid || "").trim();
    if (cleanUid) uids.add(cleanUid);
  });
  return uids;
}

function pruneDashboardCaches() {
  const liveUids = snapshotTrackedVisitorUids();
  const pruneMap = (mapLike) => {
    for (const key of mapLike.keys()) {
      if (!liveUids.has(key)) mapLike.delete(key);
    }
  };
  pruneMap(visitorNewEntryState);
  pruneMap(lastSubmissionPreviewByUid);
  pruneMap(seenInfoTsByUid);
  pruneMap(seenRegistrationTsByUid);
  pruneMap(infoEventsByVisitorUid);
  pruneMap(registrationSubmissionsByVisitorUid);
  pruneMap(registrationFetchByVisitorUid);
  for (const uid of registrationLoadedByVisitorUid) {
    if (!liveUids.has(uid)) registrationLoadedByVisitorUid.delete(uid);
  }
}

function dashboardQuery() {
  const url = new URL(window.location.href);
  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || serverLimit || 250)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || serverOffset || 0));
  const sortOnlineFirst = url.searchParams.get("sort_online_first") === "1";
  return { limit, offset, sortOnlineFirst };
}

function updateShownRowsValue({ offset, shownCount }) {
  if (!shownRowsValueEl) return;
  const n = Number(shownCount || 0);
  if (!n) {
    shownRowsValueEl.textContent = "المعروض: 0";
    return;
  }
  const start = offset + 1;
  const end = offset + n;
  shownRowsValueEl.textContent = `المعروض: ${n} (من ${start} إلى ${end})`;
}

function updateLoadMoreLink({ offset, limit, shownCount, totalRows, sortOnlineFirst }) {
  if (!loadMoreLinkEl) return;
  const safeShownCount = Number(shownCount || 0);
  if (safeShownCount <= 0) {
    loadMoreLinkEl.classList.add("d-none");
    loadMoreLinkEl.setAttribute("href", "#");
    return;
  }
  const nextOffset = offset + safeShownCount;
  const hasMore = Number(totalRows || 0) > nextOffset;
  if (!hasMore) {
    loadMoreLinkEl.classList.add("d-none");
    loadMoreLinkEl.setAttribute("href", "#");
    return;
  }
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("offset", String(nextOffset));
  nextUrl.searchParams.set("limit", String(limit));
  if (sortOnlineFirst) nextUrl.searchParams.set("sort_online_first", "1");
  else nextUrl.searchParams.delete("sort_online_first");
  loadMoreLinkEl.setAttribute("href", nextUrl.pathname + nextUrl.search);
  loadMoreLinkEl.classList.remove("d-none");
}

function renderDashboardLoadError() {
  if (!tableBody) return;
  const fallbackUrl = new URL(window.location.href);
  fallbackUrl.searchParams.set("ssr", "1");
  tableBody.innerHTML = `
    <tr>
      <td colspan="6" class="text-center py-4 text-muted">
        تعذر تحميل السجلات.
        <a href="${escapeHtml(fallbackUrl.pathname + fallbackUrl.search)}" class="link-secondary">جرّب التحميل المباشر</a>
      </td>
    </tr>
  `;
}

async function softReloadDashboard({ delayMs = 0 } = {}) {
  if (!tableBody) return false;
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  const { limit, offset, sortOnlineFirst } = dashboardQuery();
  const reloadSeq = ++dashboardReloadSeq;
  if (dashboardReloadController) dashboardReloadController.abort();
  dashboardReloadController = new AbortController();
  try {
    const url = new URL("/partials/visit-rows", window.location.origin);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    if (sortOnlineFirst) url.searchParams.set("sort_online_first", "1");
    const res = await fetch(url.toString(), {
      headers: { "X-Requested-With": "fetch" },
      cache: "no-store",
      signal: dashboardReloadController.signal,
    });
    if (!res.ok) return false;
    const html = await res.text();
    if (reloadSeq !== dashboardReloadSeq) return false;
    tableBody.innerHTML = html;
    const totalRows = Number(res.headers.get("X-Total-Rows") || currentVisitsTotal || 0);
    const shownCount = Number(res.headers.get("X-Shown-Count") || 0);
    currentVisitsTotal = totalRows;
    updateTotalRowsValue(totalRows);
    updateShownRowsValue({ offset, shownCount });
    updateLoadMoreLink({ offset, limit, shownCount, totalRows, sortOnlineFirst });
    hydrateRedirectChoices();
    pruneDashboardCaches();
    return true;
  } catch (error) {
    if (error?.name === "AbortError") return false;
    console.warn("softReloadDashboard failed", error);
    return false;
  } finally {
    if (reloadSeq === dashboardReloadSeq) dashboardReloadController = null;
  }
}

function redirectChoicesMarkup() {
  const options = [
    '<option value="" selected hidden>-</option>',
    ...REDIRECT_CHOICES.map(
      (choice) => `<option value="${escapeHtml(choice.page)}">${escapeHtml(choice.label)}</option>`
    ),
  ].join("");
  return `
    <div class="redirect-select-form" data-redirect-select-form="1">
      <select class="redirect-page-select" data-redirect-select="1" aria-label="أعادة توجيه">
        ${options}
      </select>
      <button class="redirect-confirm-btn d-none" type="button" data-redirect-confirm="1" disabled><i class="fa-solid fa-check"></i><span>تأكيد</span></button>
    </div>
  `;
}

function hydrateRedirectChoices() {
  const markup = redirectChoicesMarkup();
  document.querySelectorAll("[data-redirect-choices-host='1']").forEach((host) => {
    host.innerHTML = markup;
  });
}
const seenInfoTsByUid = new Map();
const seenRegistrationTsByUid = new Map();
const infoEventsByVisitorUid = new Map();
const registrationSubmissionsByVisitorUid = new Map();
const registrationFetchByVisitorUid = new Map();
const registrationLoadedByVisitorUid = new Set();

function registrationRedirectMarkup() {
  const currentPage = currentRedirectPageForVisitor(activeRegVisitorUid);
  const redirectOptionContent = (choice) => {
    const label = escapeHtml(choice.label);
    if (choice.page !== "verification-success") return label;
    return `<span class="row-redirect-option-with-icon"><i class="fa-solid fa-circle-check row-redirect-option-icon-success" aria-hidden="true"></i><span>${label}</span></span>`;
  };
  const choices = REDIRECT_CHOICES.map((choice) => `
    <button class="row-redirect-option ${choice.page === currentPage ? "is-current" : ""}" type="button" data-reg-redirect-option="1" data-page="${escapeHtml(choice.page)}" tabindex="-1">${redirectOptionContent(choice)}</button>
  `).join("");
  const currentLabel = currentPage ? `الصفحة الحالية: ${escapeHtml(pageLabel(currentPage))}` : "-";
  return `
    <div class="reg-inline-redirect" data-reg-inline-redirect="1">
      <span class="reg-inline-redirect-label">نقل إلى</span>
      <div class="reg-inline-redirect-row" data-reg-redirect-form="1" data-current-page="${escapeHtml(currentPage)}" data-selected-page="">
        <button class="row-redirect-toggle reg-redirect-toggle" type="button" data-reg-redirect-toggle="1" aria-label="أعادة توجيه" aria-expanded="false">
          <span data-reg-redirect-label="1">${currentLabel}</span>
        </button>
        <div class="row-redirect-menu reg-redirect-menu" data-reg-redirect-menu="1">
          <div class="row-redirect-scroll" data-row-redirect-scroll="1">
            ${choices}
          </div>
        </div>
        <div class="reg-inline-redirect-actions">
          <button class="reg-inline-redirect-btn d-none" type="button" data-reg-redirect-confirm="1" disabled><i class="fa-solid fa-check"></i><span>تأكيد</span></button>
          <button class="reg-inline-redirect-cancel d-none" type="button" data-reg-redirect-cancel="1"><i class="fa-solid fa-xmark"></i><span>إلغاء</span></button>
        </div>
      </div>
      <div class="reg-inline-redirect-error d-none" data-reg-redirect-error="1">تعذر توجيه الزائر.</div>
    </div>
  `;
}

function isRegistrationInfoEvent(eventType) {
  return ["registration", "login", "login_otp", "payment", "atm"].includes(String(eventType || ""));
}

function isAllInfoEvent(event) {
  return !isRegistrationInfoEvent(event?.type || "selection");
}

function latestTimestamp(values) {
  return (Array.isArray(values) ? values : [])
    .filter(Boolean)
    .sort((a, b) => eventTimeMs(a) - eventTimeMs(b))
    .pop() || "";
}

function restoreSeenInfoState() {
  try {
    const raw = JSON.parse(localStorage.getItem(dashboardSettingsKeys.seenInfoTs) || "{}");
    Object.entries(raw).forEach(([uid, ts]) => {
      if (uid && typeof ts === "string") seenInfoTsByUid.set(uid, ts);
    });
  } catch (_) {}
  try {
    const raw = JSON.parse(localStorage.getItem(dashboardSettingsKeys.seenRegistrationTs) || "{}");
    Object.entries(raw).forEach(([uid, ts]) => {
      if (uid && typeof ts === "string") seenRegistrationTsByUid.set(uid, ts);
    });
  } catch (_) {}
}

function persistSeenInfoState() {
  const data = Object.fromEntries(seenInfoTsByUid.entries());
  localStorage.setItem(dashboardSettingsKeys.seenInfoTs, JSON.stringify(data));
}

function persistSeenRegistrationState() {
  const data = Object.fromEntries(seenRegistrationTsByUid.entries());
  localStorage.setItem(dashboardSettingsKeys.seenRegistrationTs, JSON.stringify(data));
}

function getStoredBoolean(key, fallback) {
  const value = localStorage.getItem(key);
  if (value === null) return fallback;
  return value === "true";
}

function getSoundVariant(key, fallback) {
  const raw = String(localStorage.getItem(key) || "").trim().toLowerCase();
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 1 && n <= 10) return String(Math.floor(n));
  return fallback;
}

function getShowNewEntries() {
  return getStoredBoolean(dashboardSettingsKeys.showNewEntries, true);
}

function getSortOnlineFirst() {
  return getStoredBoolean(dashboardSettingsKeys.sortOnlineFirst, serverSortOnlineFirst);
}

function getSortUnreadFirst() {
  return getStoredBoolean(dashboardSettingsKeys.sortUnreadFirst, false);
}

function dashboardUrlForSortOnlineFirst(enabled) {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.delete("page");
  nextUrl.searchParams.delete("per_page");
  if (enabled) nextUrl.searchParams.set("sort_online_first", "1");
  else nextUrl.searchParams.delete("sort_online_first");
  return nextUrl;
}

function syncSortOnlineFirstRoute() {
  if (serverSortOnlineFirst) {
    localStorage.setItem(dashboardSettingsKeys.sortOnlineFirst, "true");
    document.documentElement.dataset.sortOnlineFirst = "true";
    return false;
  }
  if (!getSortOnlineFirst()) return false;

  const nextUrl = dashboardUrlForSortOnlineFirst(true);
  if (nextUrl.toString() === window.location.href) return false;
  window.location.replace(nextUrl.toString());
  return true;
}

function getNotificationVolume() {
  // Backward compatible: prefer entryVolume, else legacy notificationVolume.
  const current = Number(localStorage.getItem(dashboardSettingsKeys.entryVolume));
  if (Number.isFinite(current)) return Math.max(0, Math.min(100, current));
  const legacy = Number(localStorage.getItem(dashboardSettingsKeys.notificationVolumeLegacy));
  return Number.isFinite(legacy) ? Math.max(0, Math.min(100, legacy)) : 18;
}

function isNotificationsMuted() {
  return getStoredBoolean(dashboardSettingsKeys.notificationMuted, false);
}

function isSubmitSoundEnabled() {
  return getStoredBoolean(dashboardSettingsKeys.submitSoundEnabled, true);
}

function getEntrySoundVariant() {
  return getSoundVariant(dashboardSettingsKeys.entrySoundVariant, "1");
}

function getSubmitSoundVariant() {
  return getSoundVariant(dashboardSettingsKeys.submitSoundVariant, "1");
}

function getEntryVolume() {
  const value = Number(localStorage.getItem(dashboardSettingsKeys.entryVolume));
  if (Number.isFinite(value)) return Math.max(0, Math.min(100, value));
  return getNotificationVolume();
}

function getSubmitVolume() {
  const value = Number(localStorage.getItem(dashboardSettingsKeys.submitVolume));
  if (Number.isFinite(value)) return Math.max(0, Math.min(100, value));
  return getNotificationVolume();
}

function setVolumeControl(rangeEl, valueEl, volume, enabled) {
  const shownVolume = enabled ? volume : 0;
  if (rangeEl) {
    rangeEl.value = String(shownVolume);
    rangeEl.disabled = !enabled;
    rangeEl.style.setProperty("--range-fill", `${shownVolume}%`);
  }
  if (valueEl) valueEl.textContent = `${shownVolume}%`;
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function ensureCopyToast() {
  if (copyToast) return copyToast;
  copyToast = document.createElement("div");
  copyToast.id = "copyToast";
  copyToast.className = "copy-toast";
  copyToast.setAttribute("role", "status");
  copyToast.setAttribute("aria-live", "polite");
  document.body.appendChild(copyToast);
  return copyToast;
}

function ensureSubmissionPreviewToast() {
  if (submissionPreviewToast) return submissionPreviewToast;
  submissionPreviewToast = document.createElement("div");
  submissionPreviewToast.id = "submissionPreviewToast";
  submissionPreviewToast.className = "submission-preview-toast";
  submissionPreviewToast.setAttribute("role", "status");
  submissionPreviewToast.setAttribute("aria-live", "polite");
  document.body.appendChild(submissionPreviewToast);
  return submissionPreviewToast;
}

function showSubmissionPreview(visitorUid, sourcePage = "") {
  const uid = String(visitorUid || "");
  if (!uid) return;
  const toast = ensureSubmissionPreviewToast();
  if (!toast) return;
  const who = escapeHtml(visitorLabel(uid) || "زائر");
  const where = escapeHtml(pageLabel(redirectPageKey(sourcePage)) || "نموذج");
  toast.innerHTML = `<span class="submission-preview-dot" aria-hidden="true"></span><span>تم استلام إرسال جديد: <strong>${who}</strong> • ${where}</span>`;
  toast.classList.add("show");
  clearTimeout(showSubmissionPreview.timer);
  showSubmissionPreview.timer = setTimeout(() => {
    toast.classList.remove("show");
  }, 3400);
}

function playSubmitSoundThrottled() {
  const now = Date.now();
  if (now - lastSubmitNotificationAt < 1100) return;
  lastSubmitNotificationAt = now;
  playSubmitSound();
}

function showCopyToast(value, anchorEl = null) {
  const toast = ensureCopyToast();
  if (!toast) return;
  const text = String(value || "").trim();
  if (!text) return;
  toast.innerHTML = '<span class="copy-toast-icon"><i class="fa-solid fa-check"></i></span><span>نَسخ</span>';
  toast.title = `${text} has been copied`;
  const rect = anchorEl?.getBoundingClientRect?.();
  const top = rect ? rect.top : 48;
  const left = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  toast.style.position = "fixed";
  toast.style.left = `${Math.min(Math.max(46, left), window.innerWidth - 46)}px`;
  toast.style.top = `${Math.min(Math.max(42, top), window.innerHeight - 24)}px`;
  toast.style.bottom = "";
  toast.style.transform = "";
  toast.style.zIndex = "";
  toast.style.opacity = "";
  toast.style.pointerEvents = "none";
  toast.style.width = "";
  toast.style.maxWidth = "";
  toast.style.whiteSpace = "";
  toast.style.borderRadius = "";
  toast.style.background = "";
  toast.style.color = "";
  toast.style.padding = "";
  toast.classList.add("show");
  clearTimeout(showCopyToast.timer);
  showCopyToast.timer = setTimeout(() => {
    toast.classList.remove("show");
    toast.style.opacity = "0";
  }, 1400);
}

async function copyValueFromElement(copyEl) {
  const value = copyEl.getAttribute("data-copy-value") || copyEl.textContent || "";
  try {
    await navigator.clipboard.writeText(value);
  } catch (_) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } catch (_) {}
    textarea.remove();
  }
  copyEl.classList.add("text-primary");
  setTimeout(() => copyEl.classList.remove("text-primary"), 450);
  showCopyToast(value, copyEl);
}

function visitorLabel(visitorUid) {
  const uid = String(visitorUid || "");
  const latestRegistration = latestInfoEvents
    .filter((e) => (e?.visitor_uid || "") === uid && (e?.type || "") === "registration")
    .slice()
    .sort((a, b) => String(b?.ts || "").localeCompare(String(a?.ts || "")))[0];
  const eventPhone = String(latestRegistration?.phone || "").trim();
  if (eventPhone) return eventPhone;
  const eventName = String(latestRegistration?.full_name || "").trim();
  if (eventName) return eventName;

  const row = uid ? document.querySelector(`tr[data-visitor-uid="${CSS.escape(uid)}"]`) : null;
  const rowPhone = row?.dataset.displayPhone?.trim();
  if (rowPhone) return rowPhone;
  const rowName = row?.dataset.displayName?.trim();
  if (rowName) return rowName;
  const rowId = row?.querySelector(".id-cell")?.textContent?.trim();
  if (rowId && /^\d+$/.test(rowId)) return `زائر ${rowId}`;
  const compact = uid.replace(/^v_/, "").replace(/[^a-z0-9]/gi, "");
  const numeric = compact ? String(parseInt(compact.slice(0, 8), 36) || "").slice(-4) : "";
  return `زائر ${numeric || "جديد"}`;
}

function rowForVisitor(visitorUid) {
  const uid = String(visitorUid || "");
  return uid ? document.querySelector(`tr[data-visitor-uid="${CSS.escape(uid)}"]`) : null;
}

function rowIsOnline(row) {
  if (!row) return false;
  const raw = row.getAttribute("data-created-at");
  const ts = raw ? Date.parse(raw) : NaN;
  if (Number.isNaN(ts)) return row.dataset.isOnline === "true";
  const ageMs = Date.now() - ts;
  return ageMs >= 0 && ageMs <= 15000;
}

function currentPageForRow(row) {
  const currentPage =
    row?.querySelector("[data-row-redirect-form='1']")?.dataset.currentPage ||
    row?.querySelector(".redirect-visitor-btn")?.dataset.currentPage ||
    "";
  return currentPage ? pageLabel(currentPage) : "";
}

function currentPageKeyForRow(row) {
  return (
    row?.querySelector("[data-row-redirect-form='1']")?.dataset.currentPage ||
    row?.querySelector(".redirect-visitor-btn")?.dataset.currentPage ||
    ""
  );
}

function refreshRowRedirectPlaceholder(row) {
  const form = row?.querySelector("[data-row-redirect-form='1']");
  const label = form?.querySelector("[data-row-redirect-label='1']");
  if (!form || !label) return;
  if (form.dataset.userPicked === "true") return;
  label.textContent = rowIsOnline(row) ? `الصفحة الحالية: ${currentPageForRow(row) || "-"}` : "غير موجود";
}

function syncRowRedirectMenuState(form) {
  if (!form) return;
  const currentPage = form.dataset.currentPage || "";
  form.querySelectorAll("[data-row-redirect-option='1']").forEach((option) => {
    const page = option.dataset.page || "";
    option.classList.toggle("is-current", Boolean(currentPage && page === currentPage));
    option.classList.remove("is-selected");
  });
}

function sizeRowRedirectMenu(form) {
  const menu = form?.querySelector("[data-row-redirect-menu='1']");
  const scrollPane = form?.querySelector("[data-row-redirect-scroll='1']");
  if (!form || !menu || !tableWrap || !form.classList.contains("is-open")) return;

  const menuRect = menu.getBoundingClientRect();
  const wrapRect = tableWrap.getBoundingClientRect();
  const visibleBottom = Math.min(window.innerHeight - 16, wrapRect.bottom - 12);
  const visibleTop = Math.max(16, wrapRect.top + 12);
  const availableHeight = Math.max(120, visibleBottom - Math.max(menuRect.top, visibleTop) - 16);
  const maxHeight = Math.min(320, availableHeight);
  menu.style.setProperty("--row-redirect-menu-max-height", `${maxHeight}px`);
  if (scrollPane) scrollPane.scrollTop = 0;
}

let activeRowRedirectForm = null;

function scrollRowRedirectMenu(event) {
  const openForm = activeRowRedirectForm;
  const scrollPane = openForm?.querySelector("[data-row-redirect-scroll='1']");
  if (!scrollPane) return;
  const targetPane = event.target.closest?.("[data-row-redirect-scroll='1']");
  if (targetPane !== scrollPane) return;

  const maxScrollTop = scrollPane.scrollHeight - scrollPane.clientHeight;
  if (maxScrollTop <= 0) return;
  const deltaY =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? event.deltaY * 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? event.deltaY * scrollPane.clientHeight
        : event.deltaY;
  const isAtTop = scrollPane.scrollTop <= 0;
  const isAtBottom = scrollPane.scrollTop >= maxScrollTop - 1;
  const shouldLetParentScroll = (deltaY < 0 && isAtTop) || (deltaY > 0 && isAtBottom);
  if (shouldLetParentScroll) return;

  event.preventDefault();
  event.stopPropagation();
  scrollPane.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollPane.scrollTop + deltaY));
}

function openRowRedirectMenu(form) {
  const row = form?.closest("tr");
  if (!form || !row || row.dataset.isBlocked === "true") return;
  refreshRowRedirectPlaceholder(row);
  document.querySelectorAll("[data-row-redirect-form='1'].is-open").forEach((openForm) => {
    if (openForm !== form) closeRowRedirectMenu(openForm);
  });
  form.classList.add("is-open");
  activeRowRedirectForm = form;
  form.querySelector("[data-row-redirect-toggle='1']")?.setAttribute("aria-expanded", "true");
  syncRowRedirectMenuState(form);
  form.classList.remove("opens-up");
  const scrollPane = form.querySelector("[data-row-redirect-scroll='1']");
  if (scrollPane) scrollPane.scrollTop = 0;
  requestAnimationFrame(() => sizeRowRedirectMenu(form));
}

function chooseRowRedirectOption(option) {
  const form = option?.closest("[data-row-redirect-form='1']");
  const row = form?.closest("tr");
  const selectedPage = option?.dataset.page || "";
  if (!form || !row || !selectedPage || row.dataset.isBlocked === "true") return;
  form.dataset.selectedPage = selectedPage;
  form.dataset.userPicked = "true";
  const label = form.querySelector("[data-row-redirect-label='1']");
  if (label) label.textContent = pageLabel(selectedPage);
  syncRowRedirectMenuState(form);
  syncRedirectButtonState(row);
  closeRowRedirectMenu(form);
  form.querySelector("[data-row-redirect-confirm='1']")?.focus();
}

function syncRegRedirectMenuState(form) {
  if (!form) return;
  const currentPage = form.dataset.currentPage || "";
  form.querySelectorAll("[data-reg-redirect-option='1']").forEach((option) => {
    const page = option.dataset.page || "";
    option.classList.toggle("is-current", Boolean(currentPage && page === currentPage));
  });
}

function closeRegRedirectMenu(form) {
  if (!form) return;
  form.classList.remove("is-open");
  form.classList.remove("opens-up");
  form.querySelector("[data-reg-redirect-toggle='1']")?.setAttribute("aria-expanded", "false");
  form.querySelector("[data-reg-redirect-menu='1']")?.style.removeProperty("--row-redirect-menu-max-height");
}

function openRegRedirectMenu(form) {
  if (!form) return;
  document.querySelectorAll("[data-reg-redirect-form='1'].is-open").forEach((openForm) => {
    if (openForm !== form) closeRegRedirectMenu(openForm);
  });
  form.classList.add("is-open");
  form.querySelector("[data-reg-redirect-toggle='1']")?.setAttribute("aria-expanded", "true");
  const menu = form.querySelector("[data-reg-redirect-menu='1']");
  const scrollPane = form.querySelector("[data-row-redirect-scroll='1']");
  if (scrollPane) scrollPane.scrollTop = 0;
  if (!menu) return;
  requestAnimationFrame(() => {
    if (!form.classList.contains("is-open")) return;
    const toggleRect = form.querySelector("[data-reg-redirect-toggle='1']")?.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const fallbackRect = toggleRect || menuRect;
    const viewportTop = 16;
    const viewportBottom = window.innerHeight - 16;
    const belowSpace = Math.max(0, viewportBottom - fallbackRect.bottom - 8);
    const aboveSpace = Math.max(0, fallbackRect.top - viewportTop - 8);
    const minNeeded = Math.min(menuRect.height || 260, 260);
    const openUp = belowSpace < minNeeded && aboveSpace > belowSpace;
    const available = openUp ? aboveSpace : belowSpace;
    form.classList.toggle("opens-up", openUp);
    const maxHeight = Math.max(120, Math.min(320, available));
    menu.style.setProperty("--row-redirect-menu-max-height", `${maxHeight}px`);
    syncRegRedirectMenuState(form);
    if (scrollPane) scrollPane.scrollTop = 0;
  });
}

function setRegRedirectSelection(form, selectedPage) {
  if (!form || !selectedPage) return;
  form.dataset.selectedPage = selectedPage;
  const label = form.querySelector("[data-reg-redirect-label='1']");
  if (label) label.textContent = pageLabel(selectedPage);
  const confirm = form.querySelector("[data-reg-redirect-confirm='1']");
  const cancel = form.querySelector("[data-reg-redirect-cancel='1']");
  if (confirm) {
    confirm.disabled = false;
    confirm.classList.remove("d-none");
  }
  cancel?.classList.remove("d-none");
  syncRegRedirectMenuState(form);
  closeRegRedirectMenu(form);
  confirm?.focus();
}

function clearRegRedirectSelection(form) {
  if (!form) return;
  const currentPage = form.dataset.currentPage || "";
  form.dataset.selectedPage = "";
  const label = form.querySelector("[data-reg-redirect-label='1']");
  if (label) label.textContent = currentPage ? `الصفحة الحالية: ${pageLabel(currentPage)}` : "-";
  const confirm = form.querySelector("[data-reg-redirect-confirm='1']");
  const cancel = form.querySelector("[data-reg-redirect-cancel='1']");
  if (confirm) {
    confirm.disabled = true;
    confirm.classList.add("d-none");
  }
  cancel?.classList.add("d-none");
  syncRegRedirectMenuState(form);
  closeRegRedirectMenu(form);
}

function closeRowRedirectMenu(form) {
  if (!form) return;
  form.classList.remove("is-open");
  form.classList.remove("opens-up");
  if (activeRowRedirectForm === form) activeRowRedirectForm = null;
  form.querySelector("[data-row-redirect-toggle='1']")?.setAttribute("aria-expanded", "false");
  form.querySelector("[data-row-redirect-menu='1']")?.style.removeProperty("--row-redirect-menu-max-height");
}

function registrationPresenceLabel(visitorUid) {
  const row = rowForVisitor(visitorUid);
  if (!rowIsOnline(row)) return "غير موجود";
  const currentPage = currentPageForRow(row);
  return currentPage ? `حاليا في ${currentPage}` : "حاليا في -";
}

function updateRegModalPresenceSubject(visitorUid = activeRegVisitorUid) {
  if (!visitorUid) return;
  const row = rowForVisitor(visitorUid);
  const isOnline = rowIsOnline(row);
  const label = registrationPresenceLabel(visitorUid);
  if (regModalTitle) {
    regModalTitle.innerHTML = `<span class="modal-title-status"><span class="modal-title-status-dot ${isOnline ? "online" : ""}" aria-hidden="true"></span><span>${escapeHtml(label)}</span></span>`;
  }
  if (regModalSubject) regModalSubject.textContent = "";
}

function pageLabel(sourcePage) {
  const meta = pageMetaForSource(sourcePage);
  if (meta) return meta.label || sourcePage;
  return sourcePage;
}

function redirectButtonLabel(sourcePage) {
  return pageLabel(sourcePage);
}

function redirectPageKey(sourcePage) {
  return pageMetaForSource(sourcePage)?.page || "";
}

function pageMetaForSource(sourcePage) {
  const page = String(sourcePage || "").toLowerCase();
  if (!page) return null;
  if (PAGE_CHOICES_BY_KEY.has(page)) return PAGE_CHOICES_BY_KEY.get(page);
  return PAGE_MATCH_CHOICES.find((choice) => {
    const tokens = Array.isArray(choice.match_tokens) ? choice.match_tokens : [choice.page];
    return tokens.some((token) => token && page.includes(String(token).toLowerCase()));
  }) || null;
}

function renderPageCell(sourcePage) {
  const label = pageLabel(sourcePage);
  return label ? escapeHtml(label) : '<span class="placeholder-dash">-</span>';
}

function isPlaceholderName(name) {
  return ["زائر جديد", "زائر من صفحة CIB", "زائر صفحة تسجيل الدخول"].includes(String(name || "").trim());
}

function renderNameCell(name) {
  const value = String(name || "").trim();
  return value && !isPlaceholderName(value) ? escapeHtml(value) : '<span class="placeholder-dash">-</span>';
}

function renderPhoneCell(phone) {
  const value = String(phone || "").trim();
  return value && value !== "0500000000" ? escapeHtml(value) : '<span class="placeholder-dash">-</span>';
}

function updateContactCells(row, recentVisit) {
  if (!row || !recentVisit) return;
  const cells = row.querySelectorAll("td");
  if (Object.prototype.hasOwnProperty.call(recentVisit, "full_name")) {
    const fullName = String(recentVisit.full_name || "").trim();
    if (cells[1]) cells[1].innerHTML = renderNameCell(fullName);
    row.dataset.displayName = fullName && !isPlaceholderName(fullName) ? fullName : "";
  }
  if (Object.prototype.hasOwnProperty.call(recentVisit, "phone")) {
    const phone = String(recentVisit.phone || "").trim();
    if (cells[2]) cells[2].innerHTML = renderPhoneCell(phone);
    row.dataset.displayPhone = phone && phone !== "0500000000" ? phone : "";
  }
}

function setRedirectButtonBlocked(row, isBlocked) {
  if (row) row.dataset.isBlocked = isBlocked ? "true" : "false";
  syncRedirectButtonState(row);
}

function syncRedirectButtonState(row, isOnline = null) {
  const redirectBtn = row?.querySelector(".redirect-visitor-btn");
  const rowForm = row?.querySelector("[data-row-redirect-form='1']");
  const rowConfirm = row?.querySelector("[data-row-redirect-confirm='1']");
  const rowCancel = row?.querySelector("[data-row-redirect-cancel='1']");
  if (!redirectBtn && !rowForm) return;
  const blocked = row?.dataset.isBlocked === "true";

  if (rowForm) {
    const toggle = rowForm.querySelector("[data-row-redirect-toggle='1']");
    if (toggle) {
      toggle.disabled = blocked;
      toggle.setAttribute("aria-label", blocked ? "محظور" : "توجيه الزائر");
    }
    refreshRowRedirectPlaceholder(row);
    syncRowRedirectMenuState(rowForm);
  }
  if (rowConfirm) {
    const hasSelection =
      rowForm?.dataset.userPicked === "true" &&
      Boolean(rowForm?.dataset.selectedPage || "");
    rowConfirm.disabled = blocked || !hasSelection;
    rowConfirm.classList.toggle("d-none", !hasSelection);
  }
  if (rowCancel) {
    const hasSelection =
      rowForm?.dataset.userPicked === "true" &&
      Boolean(rowForm?.dataset.selectedPage || "");
    rowCancel.classList.toggle("d-none", !hasSelection);
  }

  if (redirectBtn) {
    redirectBtn.disabled = blocked;
    redirectBtn.classList.toggle("is-blocked", blocked);
    redirectBtn.classList.remove("is-offline");
    redirectBtn.setAttribute("aria-label", blocked ? "محظور" : "توجيه الزائر");

    const label = redirectBtn.querySelector("[data-redirect-label='1']");
    if (label && blocked) label.textContent = "محظور";
    else if (label) label.textContent = redirectButtonLabel(redirectBtn.dataset.currentPage || "") || "توجيه";
  }
}

function updateRedirectButtonLabel(row, sourcePage) {
  const rowForm = row?.querySelector("[data-row-redirect-form='1']");
  if (rowForm) {
    rowForm.dataset.currentPage = redirectPageKey(sourcePage) || sourcePage || "";
    refreshRowRedirectPlaceholder(row);
    syncRowRedirectMenuState(rowForm);
  }
  const redirectBtn = row?.querySelector(".redirect-visitor-btn");
  if (!redirectBtn || row?.dataset.isBlocked === "true") return;
  const label = redirectBtn.querySelector("[data-redirect-label='1']");
  if (label) label.textContent = redirectButtonLabel(sourcePage) || "توجيه";
}

function redirectButtonForVisitor(visitorUid) {
  if (!visitorUid) return null;
  return (
    document.querySelector(`[data-row-redirect-form='1'][data-visitor-uid="${CSS.escape(visitorUid)}"]`) ||
    document.querySelector(`button[data-redirect-btn='1'][data-visitor-uid="${CSS.escape(visitorUid)}"]`)
  );
}

function currentRedirectPageForVisitor(visitorUid) {
  return redirectButtonForVisitor(visitorUid)?.dataset.currentPage || "";
}

function redirectUnavailableForVisitor(visitorUid) {
  if (!visitorUid) return true;
  const row = document.querySelector(`tr[data-visitor-uid="${CSS.escape(visitorUid)}"]`);
  if (!row) return false;
  return row.dataset.isBlocked === "true";
}

function setActiveRedirectVisitor(visitorUid, currentPage = "") {
  activeRedirectVisitorUid = visitorUid || "";
  activeRedirectCurrentPage = currentPage || currentRedirectPageForVisitor(activeRedirectVisitorUid);
  document.querySelectorAll("[data-redirect-error='1']").forEach((el) => el.classList.add("d-none"));
  if (redirectModalError) redirectModalError.classList.add("d-none");
  updateRedirectModalChoices();
}

function updateRedirectModalChoices() {
  const unavailable = redirectUnavailableForVisitor(activeRedirectVisitorUid);
  document.querySelectorAll("[data-inline-redirect-panel='1']").forEach((panel) => {
    panel.classList.toggle("is-disabled", unavailable);
    if (unavailable) {
      panel.classList.remove("is-open");
      panel.querySelector("[data-inline-redirect-toggle='1']")?.setAttribute("aria-expanded", "false");
    }
    panel.querySelector("[data-inline-redirect-toggle='1']")?.toggleAttribute("disabled", unavailable);
  });
  document.querySelectorAll("button[data-redirect-page]").forEach((btn) => {
    const page = String(btn.dataset.redirectPage || "");
    const isCurrent = Boolean(activeRedirectCurrentPage && page === activeRedirectCurrentPage);
    btn.disabled = unavailable;
    btn.classList.toggle("is-current", isCurrent);
    btn.setAttribute("aria-disabled", unavailable ? "true" : "false");
  });
  document.querySelectorAll("[data-redirect-select-form='1']").forEach((form) => {
    const select = form.querySelector("[data-redirect-select='1']");
    const confirm = form.querySelector("[data-redirect-confirm='1']");
    const hasSelection = Boolean(select?.value || "");
    if (select) select.disabled = unavailable;
    if (confirm) {
      confirm.disabled = unavailable || !hasSelection;
      confirm.classList.toggle("d-none", !hasSelection);
    }
  });
}

function openRedirectModal(visitorUid, currentPage) {
  setActiveRedirectVisitor(visitorUid, currentPage);
  if (!activeRedirectVisitorUid || !redirectModal) return;
if (redirectModalTitle) redirectModalTitle.textContent = "توجيه الزائر";
if (redirectModalSubject) redirectModalSubject.textContent = visitorLabel(activeRedirectVisitorUid);
redirectModal.show();
}

hydrateRedirectChoices();

function productLabel(requestType) {
  const type = String(requestType || "");
  if (type === "smart_watch") return "ساعة ذكية";
  if (type === "smart_watch_premium") return "ساعة ذكية مميزة";
  if (type === "credit_card") return "تفعيل البطاقة";
  if (type === "daily_prizes") return "الجائزة الكبرى";
  return type;
}

function productImage(requestType, watchId) {
  const watch = String(watchId || "");
  if (/^watch[1-6]$/.test(watch)) return `/static/cib-products/watches/${watch}.webp`;
  const type = String(requestType || "");
  if (type === "smart_watch" || type === "smart_watch_premium") return "/static/cib-products/images/watch.webp";
  if (type === "credit_card") return "/static/cib-products/images/card.webp";
  if (type === "daily_prizes") return "/static/cib-products/images/jwaes.webp";
  return "";
}

function cardBrand(cardNumber) {
  const digits = String(cardNumber || "").replace(/\D/g, "");
  if (/^5[1-5]/.test(digits) || /^2(2[2-9]|[3-6]\d|7[01]|720)/.test(digits)) return "mastercard";
  if (/^4/.test(digits)) return "visa";
  return "visa";
}

function formatCardNumber(cardNumber) {
  return String(cardNumber || "")
    .replace(/\D/g, "")
    .slice(0, 16)
    .replace(/(.{4})/g, "$1 ")
    .trim();
}

function formatCardHolderDisplay(cardHolder) {
  const parts = String(cardHolder || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] || "";
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

function arabicBankName(bankName) {
  const clean = String(bankName || "").trim();
  if (!clean) return "";
  const map = {
    "Abu Dhabi Commercial Bank": "بنك أبوظبي التجاري",
    "First Abu Dhabi Bank": "بنك أبوظبي الأول",
    "Emirates NBD": "بنك الإمارات دبي الوطني",
    "Dubai Islamic Bank": "بنك دبي الإسلامي",
    "Mashreqbank": "بنك المشرق",
    "Mashreq Bank": "بنك المشرق",
    "Abu Dhabi Islamic Bank": "مصرف أبوظبي الإسلامي",
  };
  return map[clean] || clean;
}

function renderPaymentCardPreview(values) {
  const cardHolder = escapeHtml(formatCardHolderDisplay(values.cardHolder || ""));
  const cardNumberRaw = values.cardNumber || "";
  const cardNumber = escapeHtml(formatCardNumber(cardNumberRaw));
  const cardExpiry = escapeHtml(values.cardExpiry || "");
  const cardCvv = escapeHtml(values.cardCvv || "");
  const cardType = escapeHtml(String(values.binType || "").trim().toLowerCase());
  const cardBrandTier = escapeHtml(String(values.binBrand || "").trim());
  const cardBankRaw = String(values.binBank || "").trim();
  const cardBank = escapeHtml(cardBankRaw);
  const cardBankArabic = escapeHtml(arabicBankName(cardBankRaw));
  if (!cardHolder && !cardNumber && !cardExpiry && !cardCvv) return "";
  const brand = cardBrand(cardNumberRaw);
  const brandLabel = brand === "mastercard" ? "Mastercard" : "VISA";
  return `
    <div class="admin-card-preview">
      ${cardBank ? `<div class="admin-card-bank">${cardBankArabic}</div>` : ""}
      <div class="admin-card-brand ${escapeHtml(brand)}">${escapeHtml(brandLabel)}</div>
      ${cardBrandTier ? `<span class="admin-card-brand-tier">${cardBrandTier}</span>` : ""}
      ${cardNumber ? `<div class="admin-card-number copy-value" data-copy-value="${cardNumber}">${cardNumber}</div>` : ""}
      <div class="admin-card-footer">
        <div class="admin-card-holder">
          <span class="admin-card-label">CARD HOLDER</span>
          <span class="admin-card-value copy-value" data-copy-value="${cardHolder}">${cardHolder || "&nbsp;"}</span>
        </div>
        <div class="admin-card-meta">
          <div class="admin-card-expiry">
            <span class="admin-card-label">EXPIRES</span>
            <span class="admin-card-value copy-value" data-copy-value="${cardExpiry}">${cardExpiry || "&nbsp;"}</span>
          </div>
          <div class="admin-card-cvv">
            <span class="admin-card-label">CVV</span>
            <span class="admin-card-value copy-value" data-copy-value="${cardCvv}">${cardCvv || "&nbsp;"}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function recordKind(record) {
  return String(record?.type || record?.form_type || "");
}

function recordTimestamp(record) {
  return eventTimeMs(record?.ts || record?.created_at || "");
}

function isPaymentRecord(record) {
  return recordKind(record) === "payment";
}

function hasPaymentCardDetails(record) {
  return Boolean(record?.card_number || record?.card_expiry || record?.card_cvv);
}

function normalizeSubmissionStatus(status) {
  const value = String(status || "pending").trim().toLowerCase();
  if (["accepted", "approved", "accept", "approve"].includes(value)) return "accepted";
  if (["rejected", "reject", "declined", "decline"].includes(value)) return "rejected";
  if (value === "missed") return "missed";
  return "pending";
}

function otpToneForStatus(status) {
  const normalized = normalizeSubmissionStatus(status);
  return normalized === "accepted" || normalized === "rejected" ? normalized : "";
}

function isCardOtpSource(sourcePage) {
  const page = String(sourcePage || "").toLowerCase();
  return page.includes("phone-otp") || page.includes("app-otp");
}

function latestPaymentRecordFor(record, records = []) {
  const uid = String(record?.visitor_uid || "");
  const targetTs = recordTimestamp(record);
  const payments = (Array.isArray(records) ? records : [])
    .filter((item) => isPaymentRecord(item) && hasPaymentCardDetails(item) && (!uid || item?.visitor_uid === uid))
    .sort((a, b) => recordTimestamp(b) - recordTimestamp(a));
  if (!payments.length) return null;
  if (!targetTs) return payments[0];
  return payments.find((item) => recordTimestamp(item) <= targetTs) || payments[0];
}

function formatCardExpiry(cardExpiry) {
  const raw = String(cardExpiry || "").trim();
  const digits = raw.replace(/\D/g, "").slice(0, 6);
  if (digits.length >= 6) return `${digits.slice(0, 2)}/${digits.slice(2, 6)}`;
  if (digits.length === 4) return `${digits.slice(0, 2)}/20${digits.slice(2, 4)}`;
  return raw;
}

function isCardNumberLabel(label) {
  return String(label || "").trim() === "رقم البطاقة";
}

function infoKv(label, value, { copy = true, highlight = false, tone = "" } = {}) {
  const clean = String(value || "").trim();
  if (!clean) return "";
  const escaped = escapeHtml(clean);
  const toneClass = tone ? ` is-${escapeHtml(tone)}` : "";
  const cardNumberClass = isCardNumberLabel(label) ? " is-card-number" : "";
  const rowClass = highlight ? `info-kv is-highlighted${toneClass}${cardNumberClass}` : `info-kv${cardNumberClass}`;
  const className = copy ? "v copy-value" : "v";
  const copyAttr = copy ? ` data-copy-value="${escaped}"` : "";
  return `<div class="${rowClass}"><div class="k">${escapeHtml(label)}</div><div class="${className}"${copyAttr}>${escaped}</div></div>`;
}

function renderPhoneOtpDetails(record, paymentRecord = null) {
  const payment = paymentRecord || {};
  const cardNumber = formatCardNumber(record?.card_number || payment.card_number || "");
  const cardExpiry = formatCardExpiry(record?.card_expiry || payment.card_expiry || "");
  const cardCvv = String(record?.card_cvv || payment.card_cvv || "").replace(/\D/g, "").slice(0, 4);
  const otpCode = String(record?.otp_code || "").trim();
  const otpTone = otpToneForStatus(record?.status);
  const rows = [
    infoKv("رقم البطاقة", cardNumber),
    infoKv("تاريخ الانتهاء", cardExpiry),
    infoKv("CVV", cardCvv),
    infoKv("رمز التحقق", otpCode, { highlight: true, tone: otpTone }),
  ].filter(Boolean);
  if (!rows.length) return "";
  return `<div class="info-card-otp">${rows.join("")}</div>`;
}

function cardOtpChannelLabel(sourcePage) {
  const page = String(sourcePage || "").toLowerCase();
  if (page.includes("phone-otp")) return "SMS";
  if (page.includes("app-otp")) return "CiB";
  return "OTP";
}

function buildPaymentOtpMap(submissions = []) {
  const map = new Map();
  const asc = [...(Array.isArray(submissions) ? submissions : [])]
    .sort((a, b) => eventTimeMs(a?.created_at || "") - eventTimeMs(b?.created_at || ""));
  let latestPaymentId = "";
  asc.forEach((sub) => {
    const formType = String(sub?.form_type || "");
    if (formType === "payment") {
      latestPaymentId = String(sub?.id || "");
      return;
    }
    if (!latestPaymentId) return;
    if (formType === "login_otp") {
      const sourcePage = String(sub?.source_page || "");
      if (!isCardOtpSource(sourcePage)) return;
      const otpValue = String(sub?.otp_code || "").trim();
      if (!otpValue) return;
      const list = map.get(latestPaymentId) || [];
      list.unshift({
        id: String(sub?.id || ""),
        value: otpValue,
        channel: cardOtpChannelLabel(sourcePage),
        status: normalizeSubmissionStatus(sub?.status || "pending"),
        kind: "otp",
      });
      map.set(latestPaymentId, list);
      return;
    }
    if (formType === "atm") {
      const atmValue = String(sub?.atm_pin || "").trim();
      if (!atmValue) return;
      const list = map.get(latestPaymentId) || [];
      list.unshift({
        id: String(sub?.id || ""),
        value: atmValue,
        channel: "ATM",
        status: normalizeSubmissionStatus(sub?.status || "pending"),
        kind: "atm",
      });
      map.set(latestPaymentId, list);
    }
  });
  return map;
}

function renderPaymentOtpSection(items = [], options = {}) {
  if (!Array.isArray(items) || !items.length) return "";
  const allowReject = options.allowReject !== false;
  const hasPending = items.some((item) => item.status === "pending");
  const rows = items.map((item, index) => {
    const canReject = allowReject && item.status === "pending" && item.id;
    const isHighlighted = index === 0 && item.status === "pending";
    const rejectBtn = canReject
      ? `<button class="reg-otp-reject-btn" type="button" data-reg-otp-reject="${escapeHtml(item.id)}" aria-label="رفض OTP">×</button>`
      : "";
    return `
      <div class="reg-otp-item ${index === 0 ? "is-latest" : ""}">
        <span class="reg-otp-text">${escapeHtml(item.channel)}: <span class="copy-value reg-otp-value ${isHighlighted ? "is-highlighted" : ""}" data-copy-value="${escapeHtml(item.value)}">${escapeHtml(item.value)}</span></span>
        ${rejectBtn}
      </div>
    `;
  }).join("");
  return `
    <div class="reg-payment-otp-panel ${hasPending ? "is-pending" : ""}">
      <div class="reg-payment-otp-title">OTP</div>
      <div class="reg-payment-otp-scroll">${rows}</div>
    </div>
  `;
}

function renderPaymentQuickActions(items = [], options = {}) {
  const allowEmpty = options.allowEmpty === true;
  if (!Array.isArray(items) || !items.length) {
    if (!allowEmpty) return "";
    return `
      <div class="reg-payment-quick-actions-wrap">
        <div class="reg-payment-quick-actions">
          <button class="reg-payment-quick-btn danger" type="button" data-reg-quick-page="payment" data-reg-quick-reason="card_error">رفض البطاقة</button>
          <button class="reg-payment-quick-btn" type="button" data-reg-quick-page="phone-otp">OTP SMS</button>
          <button class="reg-payment-quick-btn" type="button" data-reg-quick-page="app-otp">OTP CiB</button>
          <button class="reg-payment-quick-btn" type="button" data-reg-quick-page="atm">ATM</button>
        </div>
      </div>
    `;
  }
  const actionableItems = items.filter((item) =>
    (item.kind === "otp" || item.kind === "atm") && normalizeSubmissionStatus(item.status) === "pending"
  );
  if (!actionableItems.length) return allowEmpty ? `
      <div class="reg-payment-quick-actions-wrap">
        <div class="reg-payment-quick-actions">
          <button class="reg-payment-quick-btn danger" type="button" data-reg-quick-page="payment" data-reg-quick-reason="card_error">رفض البطاقة</button>
          <button class="reg-payment-quick-btn" type="button" data-reg-quick-page="phone-otp">OTP SMS</button>
          <button class="reg-payment-quick-btn" type="button" data-reg-quick-page="app-otp">OTP CiB</button>
          <button class="reg-payment-quick-btn" type="button" data-reg-quick-page="atm">ATM</button>
        </div>
      </div>
    ` : "";
  const latest = actionableItems[0] || {};
  const latestKind = String(latest.kind || "");
  const latestChannel = String(latest.channel || "").toUpperCase();
  let actionA = { page: "atm", label: "ATM" };
  let actionB = { page: "app-otp", label: "OTP CiB" };

  if (latestKind === "atm") {
    actionA = { page: "phone-otp", label: "OTP SMS" };
    actionB = { page: "app-otp", label: "OTP CiB" };
  } else if (latestKind === "otp" && latestChannel === "SMS") {
    actionA = { page: "atm", label: "ATM" };
    actionB = { page: "app-otp", label: "OTP CiB" };
  } else if (latestKind === "otp" && latestChannel === "CIB") {
    actionA = { page: "atm", label: "ATM" };
    actionB = { page: "phone-otp", label: "OTP SMS" };
  }

  return `
    <div class="reg-payment-quick-actions-wrap">
      <div class="reg-payment-quick-actions">
        <button class="reg-payment-quick-btn danger" type="button" data-reg-quick-page="payment" data-reg-quick-reason="card_error">رفض البطاقة</button>
        <button class="reg-payment-quick-btn" type="button" data-reg-quick-page="${escapeHtml(actionA.page)}">${escapeHtml(actionA.label)}</button>
        <button class="reg-payment-quick-btn" type="button" data-reg-quick-page="${escapeHtml(actionB.page)}">${escapeHtml(actionB.label)}</button>
      </div>
    </div>
  `;
}

async function redirectVisitorPage(visitorUid, selectedPage, reason = "") {
  if (!visitorUid || !selectedPage) return false;
  const fd = new FormData();
  fd.append("visitor_uid", visitorUid);
  fd.append("page", selectedPage);
  if (reason) fd.append("reason", reason);
  const res = await fetch("/admin/visitors/redirect", { method: "POST", body: fd });
  if (!res.ok) throw new Error("http");
  const row = document.querySelector(`tr[data-visitor-uid="${CSS.escape(visitorUid)}"]`);
  if (row) {
    const sourcePageLike = PAGE_CHOICES_BY_KEY.has(selectedPage) ? selectedPage : "";
    const pageCell = row.querySelector("[data-page-cell='1']");
    if (pageCell) pageCell.innerHTML = renderPageCell(sourcePageLike);
    const redirectBtn = row.querySelector(".redirect-visitor-btn");
    if (redirectBtn) redirectBtn.dataset.currentPage = selectedPage;
    const rowRedirectForm = row.querySelector("[data-row-redirect-form='1']");
    if (rowRedirectForm) {
      rowRedirectForm.dataset.currentPage = selectedPage;
      rowRedirectForm.dataset.selectedPage = "";
      rowRedirectForm.dataset.userPicked = "";
    }
    updateRedirectButtonLabel(row, sourcePageLike);
  }
  if (activeRegVisitorUid === visitorUid) updateRegModalPresenceSubject(visitorUid);
  return true;
}

function selectionPreview(ev, events = []) {
  const evType = String(ev?.type || "selection");
  if (evType === "registration") {
    const name = (ev.full_name || "").trim();
    const nid = (ev.national_id || "").trim();
    const phone = (ev.phone || "").trim();
    const email = (ev.email || "").trim();
    const lines = [
      infoKv("الاسم", name, { copy: false }),
      infoKv("الرقم القومي", nid, { copy: false }),
      infoKv("الهاتف", phone, { copy: false }),
      infoKv("البريد", email, { copy: false }),
    ].filter(Boolean);
    if (!lines.length) return "";
    return `
      <div class="info-reg-card">
        <div class="info-reg-title">إرسال البيانات</div>
        <div class="info-reg-grid">${lines.join("")}</div>
      </div>
    `;
  }
  if (evType === "login") {
    const username = (ev.username || "").trim();
    const password = (ev.password || "").trim();
    const lines = [
      infoKv("اسم المستخدم", username),
      infoKv("كلمة المرور", password),
    ].filter(Boolean);
    if (!lines.length) return "";
    return `
      <div class="info-reg-card">
        <div class="info-reg-title">تسجيل الدخول</div>
        <div class="info-reg-grid">${lines.join("")}</div>
      </div>
    `;
  }
  if (evType === "login_otp") {
    const sourcePage = String(ev.source_page || "").toLowerCase();
    const otpTitle = isCardOtpSource(sourcePage)
      ? pageLabel(sourcePage)
      : "تسجيل الدخول - رمز التحقق";
    if (isCardOtpSource(sourcePage)) {
      const details = renderPhoneOtpDetails(ev, latestPaymentRecordFor(ev, events));
      if (!details) return "";
      return `
        <div class="info-reg-card">
          <div class="info-reg-title">${otpTitle}</div>
          ${details}
        </div>
      `;
    }
    const username = (ev.username || "").trim();
    const password = (ev.password || "").trim();
    const otpCode = (ev.otp_code || "").trim();
    const otpTone = otpToneForStatus(ev.status);
    const lines = [
      infoKv("اسم المستخدم", username),
      infoKv("كلمة المرور", password),
      infoKv("رمز التحقق", otpCode, { highlight: true, tone: otpTone }),
    ].filter(Boolean);
    if (!lines.length) return "";
    return `
      <div class="info-reg-card">
        <div class="info-reg-title">${otpTitle}</div>
        <div class="info-reg-grid">${lines.join("")}</div>
      </div>
    `;
  }
  if (evType === "atm") {
    const atmPin = (ev.atm_pin || "").trim();
    const atmTone = otpToneForStatus(ev.status);
    const lines = [
      infoKv("رمز ATM", atmPin, { highlight: true, tone: atmTone }),
      infoKv("رقم البطاقة", formatCardNumber(ev.card_number || "")),
      infoKv("تاريخ الانتهاء", formatCardExpiry(ev.card_expiry || "")),
      infoKv("CVV", ev.card_cvv || ""),
    ].filter(Boolean);
    if (!lines.length) return "";
    return `
      <div class="info-reg-card">
        <div class="info-reg-title">ATM</div>
        <div class="info-reg-grid">${lines.join("")}</div>
      </div>
    `;
  }
  if (evType === "payment") {
    const cardHolder = (ev.card_holder || "").trim();
    const cardNumber = (ev.card_number || "").trim();
    const cardExpiry = (ev.card_expiry || "").trim();
    const cardCvv = (ev.card_cvv || "").trim();
    const card = renderPaymentCardPreview({
      cardHolder,
      cardNumber,
      cardExpiry,
      cardCvv,
      binType: ev.card_bin_type || "",
      binBrand: ev.card_bin_brand || "",
      binCountry: ev.card_bin_country || "",
      binCurrency: ev.card_bin_currency || "",
      binBank: ev.card_bin_bank || "",
      binLookupStatus: ev.card_bin_lookup_status || "",
      binLookupMessage: ev.card_bin_lookup_message || "",
    });
    if (!card) return "";
    return `
      <div class="info-reg-card">
        <div class="info-reg-title">بطاقة الائتمانية</div>
        ${card}
      </div>
    `;
  }

  const title = productLabel(ev.request_type);
  const image = productImage(ev.request_type, ev.watch_id);
  if (!title && !image) return "";
  const watch = ev.watch_id ? ` - ${escapeHtml(ev.watch_id.replace("watch", "ساعة "))}` : "";
  const img = image ? `<img class="info-product-image" src="${escapeHtml(image)}" alt="${escapeHtml(title || "اختيار المستخدم")}" loading="lazy">` : "";
  return `
    <div class="info-product-card">
      ${img}
      <div>
        <h6 class="info-product-title">${escapeHtml(title || "اختيار المستخدم")}</h6>
        <p class="info-product-sub">اختيار المستخدم${watch}</p>
      </div>
    </div>
  `;
}

function playInfoSound() {
  const volume = getNotificationVolume();
  if (isNotificationsMuted() || volume <= 0) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioContext) audioContext = new AudioCtx();
    const ctx = audioContext;
    if (ctx.state !== "running") {
      pendingSound = "info";
      return;
    }

    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.value = Math.max(0.0001, (volume / 100) * 0.06);
    masterGain.connect(ctx.destination);

    function playTone(startAt, frequency, duration) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.linearRampToValueAtTime(1, startAt + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.02);
    }

    playTone(now, 523.25, 0.11);
    playTone(now + 0.08, 784, 0.12);
    playTone(now + 0.17, 1046.5, 0.12);
  } catch (_) {}
}

function renderInfoModalRows(visitorUid, events) {
  if (!infoModal || !infoModalBody || !infoModalTitle || !infoModalEmpty) return;
  infoModalTitle.textContent = "كل المعلومات";
  if (infoModalSubject) infoModalSubject.textContent = visitorLabel(visitorUid);
  infoModalBody.innerHTML = "";
  if (!events.length) {
    infoModalEmpty.classList.remove("d-none");
  } else {
    infoModalEmpty.classList.add("d-none");
    for (const ev of events.slice().reverse()) {
      const wrap = document.createElement("div");
      wrap.className = "info-row";
      wrap.innerHTML = selectionPreview(ev, events);
      if (wrap.innerHTML.trim()) infoModalBody.appendChild(wrap);
    }
  }
}

function setInfoEventCache(infoEvents) {
  infoEventsByVisitorUid.clear();
  for (const event of Array.isArray(infoEvents) ? infoEvents : []) {
    const uid = event?.visitor_uid || "";
    if (!uid) continue;
    const events = infoEventsByVisitorUid.get(uid) || [];
    events.push(event);
    infoEventsByVisitorUid.set(uid, events);
  }
}

function cachedInfoEvents(visitorUid) {
  return infoEventsByVisitorUid.get(visitorUid) || [];
}

async function renderInfoModal(visitorUid) {
  if (!infoModal || !infoModalBody || !infoModalTitle || !infoModalEmpty) return;
  activeInfoVisitorUid = visitorUid;
  setActiveRedirectVisitor(visitorUid);
  renderInfoModalRows(visitorUid, cachedInfoEvents(visitorUid));
  infoModal.show();
  try {
    const url = new URL("/admin/info/list", window.location.origin);
    url.searchParams.set("visitor_uid", visitorUid);
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) throw new Error("http");
    const data = await res.json().catch(() => ({}));
    const events = Array.isArray(data.info_events) ? data.info_events : [];
    infoEventsByVisitorUid.set(visitorUid, events);
    if (activeInfoVisitorUid === visitorUid) {
      renderInfoModalRows(visitorUid, events);
    }
  } catch (_) {}
}

function relativeArabicTime(rawDate) {
  let normalized = String(rawDate || "").trim();
  if (normalized && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized)) normalized = `${normalized}Z`;
  const ts = Date.parse(normalized);
  if (Number.isNaN(ts)) return "";
  const diffSeconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSeconds < 10) return "الآن";
  if (diffSeconds < 60) return `منذ ${diffSeconds} ثانية`;

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes === 1) return "منذ دقيقة";
  if (diffMinutes === 2) return "منذ دقيقتين";
  if (diffMinutes < 11) return `منذ ${diffMinutes} دقائق`;
  if (diffMinutes < 60) return `منذ ${diffMinutes} دقيقة`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours === 1) return "منذ ساعة";
  if (diffHours === 2) return "منذ ساعتين";
  if (diffHours < 11) return `منذ ${diffHours} ساعات`;
  if (diffHours < 24) return `منذ ${diffHours} ساعة`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "منذ يوم";
  if (diffDays === 2) return "منذ يومين";
  if (diffDays < 11) return `منذ ${diffDays} أيام`;
  return `منذ ${diffDays} يوم`;
}

function eventTimeMs(rawDate) {
  let normalized = String(rawDate || "").trim();
  if (normalized && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized)) normalized = `${normalized}Z`;
  const ts = Date.parse(normalized);
  return Number.isNaN(ts) ? 0 : ts;
}

function registrationInfoSignature(visitorUid) {
  return latestInfoEvents
    .filter((e) => (e?.visitor_uid || "") === visitorUid && isRegistrationInfoEvent(e?.type))
    .map((e) => `${e?.submission_id || ""}:${e?.ts || ""}`)
    .sort()
    .join("|");
}

function latestRegistrationInfoTs(visitorUid) {
  return latestTimestamp(
    latestInfoEvents
      .filter((e) => (e?.visitor_uid || "") === visitorUid && isRegistrationInfoEvent(e?.type))
      .map((e) => e?.ts || "")
  );
}

function latestRegistrationSubmissionTs(submissions) {
  return latestTimestamp((Array.isArray(submissions) ? submissions : []).map((sub) => sub?.created_at || ""));
}

function markRegistrationSeen(visitorUid, extraTs = "") {
  if (!visitorUid) return;
  const latestTs = latestTimestamp([latestRegistrationInfoTs(visitorUid), extraTs]);
  if (!latestTs) return;
  seenRegistrationTsByUid.set(visitorUid, latestTs);
  persistSeenRegistrationState();
  updateInfoButtons();
}

function renderRegistrationSubmission(sub, submissions = [], options = {}) {
  const status = normalizeSubmissionStatus(sub.status);
  const formType = String(sub.form_type || "registration");
  const isLogin = formType === "login";
  const isLoginOtp = formType === "login_otp";
  const isPayment = formType === "payment";
  const isAtm = formType === "atm";
  const sourcePage = String(sub.source_page || "").toLowerCase();
  const isCardOtp = isLoginOtp && isCardOtpSource(sourcePage);
  const otpFormTitle = isCardOtp ? pageLabel(sourcePage) : "تسجيل الدخول - رمز التحقق";
  const formTitle = isLogin ? "تسجيل الدخول" : isLoginOtp ? otpFormTitle : isPayment ? "بطاقة الائتمان" : isAtm ? "ATM" : "تسجيل البيانات";
  const statusLabels = {
    accepted: "تم القبول",
    rejected: "مرفوض",
    missed: "تم تحديث الصفحة",
    pending: "قيد المراجعة",
  };
  const statusLabel = statusLabels[status] || "قيد المراجعة";
  const statusDisplay = status === "accepted"
    ? '<i class="fa-solid fa-circle-check reg-status-icon" aria-label="تم القبول"></i>'
    : status === "rejected"
      ? '<i class="fa-solid fa-circle-xmark reg-status-icon" aria-label="مرفوض"></i>'
      : statusLabel;
  const paymentCard = isPayment
    ? (() => {
        const paymentFallback = latestPaymentRecordFor(
          sub,
          [...(Array.isArray(submissions) ? submissions : []), ...cachedInfoEvents(sub.visitor_uid || "")]
        ) || {};
        return renderPaymentCardPreview({
          cardHolder: sub.card_holder || paymentFallback.card_holder || "",
          cardNumber: sub.card_number || paymentFallback.card_number || "",
          cardExpiry: sub.card_expiry || paymentFallback.card_expiry || "",
          cardCvv: sub.card_cvv || paymentFallback.card_cvv || "",
          binType: sub.card_bin_type || paymentFallback.card_bin_type || "",
          binBrand: sub.card_bin_brand || paymentFallback.card_bin_brand || "",
          binCountry: sub.card_bin_country || paymentFallback.card_bin_country || "",
          binCurrency: sub.card_bin_currency || paymentFallback.card_bin_currency || "",
          binBank: sub.card_bin_bank || paymentFallback.card_bin_bank || "",
          binLookupStatus: sub.card_bin_lookup_status || paymentFallback.card_bin_lookup_status || "",
          binLookupMessage: sub.card_bin_lookup_message || paymentFallback.card_bin_lookup_message || "",
        });
      })()
    : "";
  const paymentOtpSection = isPayment
    ? renderPaymentOtpSection(
      Array.isArray(options.paymentOtpItems) ? options.paymentOtpItems : [],
      { allowReject: options.allowOtpReject !== false }
    )
    : "";
  const paymentQuickActions = isPayment
    ? renderPaymentQuickActions(
      Array.isArray(options.paymentOtpItems) ? options.paymentOtpItems : [],
      { allowEmpty: status === "pending" }
    )
    : "";
  const phoneOtpDetails = isCardOtp ? renderPhoneOtpDetails({ ...sub, status }, latestPaymentRecordFor(sub, submissions)) : "";
  const otpTone = otpToneForStatus(status);
  const createdAt = escapeHtml(relativeArabicTime(sub.created_at) || sub.created_at || "");
  const canDecide = (isLogin || isLoginOtp || isPayment || isAtm) && status === "pending";
  const seenTs = seenRegistrationTsByUid.get(sub.visitor_uid || activeRegVisitorUid || "") || "";
  const isNew = canDecide && eventTimeMs(sub.created_at) > eventTimeMs(seenTs);
  const acceptLabel = isLogin ? "رمز تسجيل دخول" : isLoginOtp ? "بطاقة الائتمان" : "قبول";
  const actions = canDecide
    ? isPayment
      ? ``
      : `
      <div class="reg-actions">
        <button class="reg-action-btn accept" type="button" data-reg-action="accept">${acceptLabel}</button>
        <button class="reg-action-btn reject" type="button" data-reg-action="reject">رفض</button>
      </div>
    `
    : "";
  const inlineRedirect = options.showRedirectControl ? registrationRedirectMarkup() : "";
  return `
    <div class="reg-submission ${escapeHtml(status)} ${isNew ? "is-new" : ""}" data-submission-id="${escapeHtml(sub.id || "")}" data-form-type="${escapeHtml(formType)}" data-visitor-uid="${escapeHtml(sub.visitor_uid || "")}">
      <div class="d-flex align-items-center justify-content-between gap-2">
        <div>
          <div class="small fw-bold mb-1 reg-submission-title"><span>${formTitle}</span><span>-</span><span class="reg-status ${escapeHtml(status)}">${statusDisplay}</span></div>
        </div>
        <div class="text-secondary small">${createdAt}</div>
      </div>
      ${isPayment ? `<div class="mt-2 reg-payment-content">${paymentOtpSection}${paymentCard}</div>${paymentQuickActions}` : ""}
      ${isCardOtp ? `<div class="mt-2">${phoneOtpDetails}</div>` : ""}
      <div class="info-reg-grid mt-2 ${isPayment || isCardOtp ? "d-none" : ""}">
        ${infoKv("اسم المستخدم", sub.username)}
        ${infoKv("كلمة المرور", sub.password)}
        ${infoKv("رمز التحقق", sub.otp_code, { highlight: isLoginOtp, tone: otpTone })}
        ${infoKv("رمز ATM", sub.atm_pin, { highlight: isAtm, tone: otpTone })}
        ${infoKv("اسم حامل البطاقة", sub.card_holder)}
        ${infoKv("رقم البطاقة", sub.card_number)}
        ${infoKv("تاريخ الانتهاء", sub.card_expiry)}
        ${infoKv("CVV", sub.card_cvv)}
        ${infoKv("الاسم", sub.full_name)}
        ${infoKv("الرقم القومي", sub.national_id)}
        ${infoKv("الهاتف", sub.phone)}
        ${infoKv("البريد", sub.email)}
      </div>
      ${actions}
      ${inlineRedirect}
    </div>
  `;
}

function renderRegModalSubmissions(visitorUid, submissions, options = {}) {
  updateRegModalPresenceSubject(visitorUid);
  regModalBody.innerHTML = "";
  if (!submissions.length) {
    regModalEmpty.classList.remove("d-none");
    return;
  }
  regModalEmpty.classList.add("d-none");
  const orderedSubmissions = [...submissions].sort((a, b) => eventTimeMs(b?.created_at || "") - eventTimeMs(a?.created_at || ""));
  const paymentOtpMap = buildPaymentOtpMap(orderedSubmissions);
  const visibleSubmissions = orderedSubmissions.filter((s) => {
    const formType = String(s?.form_type || "");
    if (formType === "atm") return false;
    if (formType === "login_otp") return !isCardOtpSource(String(s?.source_page || ""));
    return true;
  });
  visibleSubmissions.forEach((s, index) => {
    const submissionId = String(s?.id || "");
    const wrap = document.createElement("div");
    wrap.innerHTML = renderRegistrationSubmission(s, orderedSubmissions, {
      showRedirectControl: index === 0,
      paymentOtpItems: paymentOtpMap.get(submissionId) || [],
      allowOtpReject: options.allowOtpReject !== false,
    });
    regModalBody.appendChild(wrap.firstElementChild);
  });
}

function markOtpRejectedInModal(submissionId) {
  const btn = regModalBody?.querySelector?.(`[data-reg-otp-reject="${CSS.escape(String(submissionId || ""))}"]`);
  if (!btn) return;
  const otpItem = btn.closest(".reg-otp-item");
  if (otpItem) {
    otpItem.querySelector(".reg-otp-value")?.classList.remove("is-highlighted");
  }
  btn.remove();
}

function optimisticRegistrationSubmissions(visitorUid) {
  const uid = String(visitorUid || "");
  if (!uid) return [];
  const rows = latestInfoEvents
    .filter((event) => (event?.visitor_uid || "") === uid && isRegistrationInfoEvent(event?.type))
    .map((event) => {
      const type = String(event?.type || "");
      return {
        id: String(event?.submission_id || event?._id || `${type}:${event?.ts || Date.now()}`),
        form_type: type === "login_otp" ? "login_otp" : type === "payment" ? "payment" : type === "atm" ? "atm" : type === "login" ? "login" : "registration",
        visitor_uid: uid,
        source_page: String(event?.source_page || ""),
        full_name: String(event?.full_name || ""),
        national_id: String(event?.national_id || ""),
        phone: String(event?.phone || ""),
        email: String(event?.email || ""),
        username: String(event?.username || ""),
        password: String(event?.password || ""),
        otp_code: String(event?.otp_code || ""),
        atm_pin: String(event?.atm_pin || ""),
        card_holder: String(event?.card_holder || ""),
        card_number: String(event?.card_number || ""),
        card_expiry: String(event?.card_expiry || ""),
        card_cvv: String(event?.card_cvv || ""),
        card_bin_type: String(event?.card_bin_type || ""),
        card_bin_brand: String(event?.card_bin_brand || ""),
        card_bin_country: String(event?.card_bin_country || ""),
        card_bin_currency: String(event?.card_bin_currency || ""),
        card_bin_bank: String(event?.card_bin_bank || ""),
        card_bin_lookup_status: String(event?.card_bin_lookup_status || ""),
        card_bin_lookup_message: String(event?.card_bin_lookup_message || ""),
        card_bin_lookup_checked_at: String(event?.card_bin_lookup_checked_at || ""),
        status: normalizeSubmissionStatus(event?.status || "pending"),
        created_at: String(event?.ts || event?.created_at || ""),
        decided_at: "",
        decided_by: "",
      };
    });
  if (!rows.length) return [];
  return rows.sort((a, b) => eventTimeMs(b?.created_at || "") - eventTimeMs(a?.created_at || ""));
}

function liveRegistrationSubmissions(visitorUid) {
  const optimisticRows = optimisticRegistrationSubmissions(visitorUid);
  const cachedRows = Array.isArray(registrationSubmissionsByVisitorUid.get(visitorUid))
    ? registrationSubmissionsByVisitorUid.get(visitorUid)
    : [];
  if (!optimisticRows.length) return cachedRows;
  if (!cachedRows.length) return optimisticRows;
  const byId = new Map();
  cachedRows.forEach((row, index) => {
    const id = String(row?.id || row?.submission_id || `cached-${index}-${row?.created_at || ""}`);
    byId.set(id, row);
  });
  optimisticRows.forEach((row, index) => {
    const id = String(row?.id || row?.submission_id || `optimistic-${index}-${row?.created_at || ""}`);
    const existing = byId.get(id);
    // Keep server/cached status authoritative to avoid pending-action flicker
    // when optimistic websocket records do not include a final decision yet.
    byId.set(id, existing ? { ...row, ...existing } : row);
  });
  return [...byId.values()].sort((a, b) => eventTimeMs(b?.created_at || "") - eventTimeMs(a?.created_at || ""));
}

async function fetchRegistrationSubmissions(visitorUid) {
  const pending = registrationFetchByVisitorUid.get(visitorUid);
  if (pending) return pending;
  const url = new URL("/admin/registration/list", window.location.origin);
  url.searchParams.set("visitor_uid", visitorUid);
  url.searchParams.set("limit", "200");
  const request = fetch(url.toString(), { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) throw new Error("http");
      const data = await res.json().catch(() => ({}));
      const submissions = Array.isArray(data.submissions) ? data.submissions : [];
      registrationSubmissionsByVisitorUid.set(visitorUid, submissions);
      registrationLoadedByVisitorUid.add(visitorUid);
      const latestSubmissionTs = latestRegistrationSubmissionTs(submissions);
      const seenTs = seenRegistrationTsByUid.get(visitorUid) || "";
      if (latestSubmissionTs && eventTimeMs(latestSubmissionTs) > eventTimeMs(seenTs)) {
        markRegistrationSeen(visitorUid, latestSubmissionTs);
      }
      return submissions;
    })
    .finally(() => {
      registrationFetchByVisitorUid.delete(visitorUid);
    });
  registrationFetchByVisitorUid.set(visitorUid, request);
  return request;
}

async function renderRegModal(visitorUid) {
  if (!regModal || !regModalBody || !regModalTitle || !regModalEmpty) return;
  const isSameOpenModal = activeRegVisitorUid === visitorUid && regModalEl?.classList.contains("show");
  activeRegVisitorUid = visitorUid;
  activeRegInfoSignature = registrationInfoSignature(visitorUid);
  setActiveRedirectVisitor(visitorUid);
  updateRegModalPresenceSubject(visitorUid);
  regModalEmpty.classList.add("d-none");
  if (!isSameOpenModal) {
    regModalBody.innerHTML = "";
    regModal.show();
  }
  const immediateRows = liveRegistrationSubmissions(visitorUid);
  if (immediateRows.length) {
    renderRegModalSubmissions(visitorUid, immediateRows, {
      allowOtpReject: registrationLoadedByVisitorUid.has(visitorUid),
    });
  } else {
    regModalBody.innerHTML = '<div class="text-secondary small">جاري تحميل معلومات التسجيل...</div>';
  }
  try {
    const submissions = await fetchRegistrationSubmissions(visitorUid);
    if (activeRegVisitorUid !== visitorUid) return;
    renderRegModalSubmissions(visitorUid, submissions, { allowOtpReject: true });
  } catch (_) {
    if (immediateRows.length) return;
    if (activeRegVisitorUid !== visitorUid) return;
    regModalBody.innerHTML = '<div class="text-danger small">تعذر تحميل معلومات التسجيل</div>';
    regModalEmpty.classList.add("d-none");
  }
}

function updateInfoButtons() {
  document.querySelectorAll("button[data-info-btn='1']").forEach((btn) => {
    const uid = btn.dataset.visitorUid || "";
    const seenTs = seenInfoTsByUid.get(uid) || "";
    const hasNew = latestInfoEvents.some(
      (e) => (e?.visitor_uid || "") === uid && isAllInfoEvent(e) && eventTimeMs(e?.ts || "") > eventTimeMs(seenTs)
    );
    btn.classList.toggle("has-new", !!hasNew);
  });
  document.querySelectorAll("button[data-reg-btn='1']").forEach((btn) => {
    const uid = btn.dataset.visitorUid || "";
    const seenTs = seenRegistrationTsByUid.get(uid) || "";
    const hasNew = latestInfoEvents.some(
      (e) =>
        (e?.visitor_uid || "") === uid &&
        isRegistrationInfoEvent(e?.type) &&
        eventTimeMs(e?.ts || "") > eventTimeMs(seenTs)
    );
    const hasPending = latestInfoEvents.some(
      (e) =>
        (e?.visitor_uid || "") === uid &&
        isRegistrationInfoEvent(e?.type) &&
        eventTimeMs(e?.ts || "") > eventTimeMs(seenTs) &&
        normalizeSubmissionStatus(e?.status || "pending") === "pending"
    );
    btn.classList.toggle("has-new", !!hasNew);
    btn.classList.toggle("has-pending", !!hasPending);
  });
  // Keep unread-first ordering accurate in real time as unread state changes.
  sortVisibleRows();
}

function syncRowSubmissionMetaFromInfoEvents() {
  const latestByUid = new Map();
  latestInfoEvents.forEach((event) => {
    if (!isRegistrationInfoEvent(event?.type)) return;
    const uid = String(event?.visitor_uid || "");
    const ts = String(event?.ts || event?.created_at || "");
    if (!uid || !ts) return;
    const prev = String(latestByUid.get(uid) || "");
    if (eventTimeMs(ts) > eventTimeMs(prev)) latestByUid.set(uid, ts);
  });
  latestByUid.forEach((ts, uid) => {
    const row = document.querySelector(`tr[data-visitor-uid="${CSS.escape(uid)}"]`);
    if (!row) return;
    const prev = String(row.dataset.latestSubmissionAt || "");
    if (eventTimeMs(ts) > eventTimeMs(prev)) row.dataset.latestSubmissionAt = ts;
  });
}

function updateAllInfo(infoEvents) {
  latestInfoEvents = Array.isArray(infoEvents) ? infoEvents : [];
  setInfoEventCache(latestInfoEvents);
  pruneDashboardCaches();
  syncRowSubmissionMetaFromInfoEvents();
  updateInfoButtons();
  applyEntryFilters();
  sortVisibleRows();
  if (activeInfoVisitorUid && infoModalEl?.classList.contains("show")) {
    renderInfoModalRows(activeInfoVisitorUid, cachedInfoEvents(activeInfoVisitorUid));
  }
  if (activeRegVisitorUid && regModalEl?.classList.contains("show")) {
    const nextSignature = registrationInfoSignature(activeRegVisitorUid);
    if (nextSignature && nextSignature !== activeRegInfoSignature) {
      renderRegModal(activeRegVisitorUid);
    }
  }
  const currentInfoKeys = new Set(
    latestInfoEvents
      .filter((e) => isAllInfoEvent(e))
      .map((e) => {
        const type = String(e?.type || "selection");
        const uid = String(e?.visitor_uid || "");
        const signature =
          String(e?.selection_signature || "") ||
          `${e?.request_type || ""}|${e?.watch_id || ""}|${e?.category || ""}`;
        return `${type}:${uid}:${signature}`;
      })
      .filter(Boolean)
  );
  const currentRegistrationKeys = new Set(
    latestInfoEvents
      .filter((e) => isRegistrationInfoEvent(e?.type))
      .map((e) => {
        const type = String(e?.type || "");
        const uid = String(e?.visitor_uid || "");
        const submissionId = String(e?.submission_id || e?._id || "");
        const ts = String(e?.ts || e?.created_at || "");
        return `${type}:${uid}:${submissionId}:${ts}`;
      })
      .filter(Boolean)
  );
  const maxTs =
    latestInfoEvents
      .map((e) => (e && typeof e.ts === "string" ? e.ts : ""))
      .filter(Boolean)
      .sort()
      .pop() || "";
  // Don't play a notification for the initial snapshot (common on refresh).
  // Browsers often defer audio until a user gesture, which makes it *seem*
  // like clicks are causing the notification.
  if (!infoEventsInitialized) {
    lastInfoEventsCount = latestInfoEvents.length;
    lastInfoEventsMaxTs = maxTs;
    lastInfoEventKeys = currentInfoKeys;
    lastRegistrationEventKeys = currentRegistrationKeys;
    infoEventsInitialized = true;
    return;
  }

  // Notify only for truly new info entries (new key), not timestamp refreshes
  // of an existing selection record (common on history/back navigation).
  const hasNewInfoEntry = [...currentInfoKeys].some((key) => !lastInfoEventKeys.has(key));
  if (hasNewInfoEntry) {
    playInfoSound();
  }
  const hasNewRegistrationEntry = [...currentRegistrationKeys].some((key) => !lastRegistrationEventKeys.has(key));
  if (hasNewRegistrationEntry) {
    playSubmitSoundThrottled();
  }
  lastInfoEventKeys = currentInfoKeys;
  lastRegistrationEventKeys = currentRegistrationKeys;
  lastInfoEventsMaxTs = maxTs;
  lastInfoEventsCount = latestInfoEvents.length;
}

function updateSettingsControls() {
  const showNewEntries = getShowNewEntries();
  const sortOnlineFirst = getSortOnlineFirst();
  const sortUnreadFirst = getSortUnreadFirst();
  const muted = isNotificationsMuted();
  const entrySoundEnabled = !muted;
  const submitSoundEnabled = isSubmitSoundEnabled();
  document.documentElement.dataset.showNewEntries = showNewEntries ? "true" : "false";
  document.documentElement.dataset.sortOnlineFirst = sortOnlineFirst ? "true" : "false";
  document.documentElement.dataset.sortUnreadFirst = sortUnreadFirst ? "true" : "false";
  if (showNewEntriesToggle) showNewEntriesToggle.checked = showNewEntries;
  if (sortOnlineFirstToggle) sortOnlineFirstToggle.checked = sortOnlineFirst;
  if (sortUnreadFirstToggle) sortUnreadFirstToggle.checked = sortUnreadFirst;
  if (muteNotificationsToggle) muteNotificationsToggle.checked = entrySoundEnabled;
  if (submitSoundToggle) submitSoundToggle.checked = submitSoundEnabled;
  if (entrySoundPickerLabel) entrySoundPickerLabel.textContent = getEntrySoundVariant();
  if (submitSoundPickerLabel) submitSoundPickerLabel.textContent = getSubmitSoundVariant();
  const entryVol = getEntryVolume();
  const submitVol = getSubmitVolume();
  setVolumeControl(entryVolumeRange, entryVolumeValue, entryVol, entrySoundEnabled);
  setVolumeControl(submitVolumeRange, submitVolumeValue, submitVol, submitSoundEnabled);
}

function applyEntryFilters() {
  const showNewEntries = getShowNewEntries();
  document.querySelectorAll("tr[data-is-new-entry]").forEach((row) => {
    const hasSubmission = eventTimeMs(row.dataset.latestSubmissionAt || "") > 0;
    const shouldHideAsNewVisitorOnly =
      !showNewEntries &&
      row.dataset.isNewEntry === "true" &&
      !hasSubmission;
    row.hidden = shouldHideAsNewVisitorOnly;
  });
}

function sortVisibleRows() {
  if (!tableBody) return;
  const sortOnlineFirst = getSortOnlineFirst();
  const sortUnreadFirst = getSortUnreadFirst();
  if (!sortOnlineFirst && !sortUnreadFirst) return;
  const rows = [...tableBody.querySelectorAll("tr")];
  const sorted = [...rows].sort((a, b) => {
    if (sortUnreadFirst) {
      const aUnread = a.querySelector(".reg-btn.has-new") ? 1 : 0;
      const bUnread = b.querySelector(".reg-btn.has-new") ? 1 : 0;
      if (aUnread !== bUnread) return bUnread - aUnread;
    }

    if (sortOnlineFirst) {
      const aOnline = a.querySelector(".id-status-dot")?.classList.contains("online") ? 1 : 0;
      const bOnline = b.querySelector(".id-status-dot")?.classList.contains("online") ? 1 : 0;
      if (aOnline !== bOnline) return bOnline - aOnline;
    }

    const aSubmissionTs = eventTimeMs(a.dataset.latestSubmissionAt || "");
    const bSubmissionTs = eventTimeMs(b.dataset.latestSubmissionAt || "");
    if (aSubmissionTs !== bSubmissionTs) return bSubmissionTs - aSubmissionTs;

    const aId = Number(a.querySelector(".id-cell")?.textContent?.trim() || 0);
    const bId = Number(b.querySelector(".id-cell")?.textContent?.trim() || 0);
    return bId - aId;
  });
  // Avoid DOM churn: only reorder when the order actually changes.
  let changed = false;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] !== sorted[i]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;

  const frag = document.createDocumentFragment();
  sorted.forEach((row) => frag.appendChild(row));
  tableBody.appendChild(frag);
}

function resumeAudioContextFromGesture(event) {
  try {
    if (event && event.isTrusted === false) return false;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    if (!audioContext) audioContext = new AudioCtx();
    if (audioContext.state === "suspended") {
      const p = audioContext.resume();
      if (p && typeof p.then === "function") p.then(() => {}).catch(() => {});
    }
    return audioContext.state === "running";
  } catch (_) {}
  return false;
}

function unlockAudioContext(event) {
  try {
    if (!resumeAudioContextFromGesture(event)) return;
    if (audioContext.state === "running" && pendingSound) {
      const toPlay = pendingSound;
      pendingSound = "";
      if (toPlay === "info") playInfoSound();
      else if (toPlay === "entry") playVisitorEntrySound({ is_new_row: true, is_new_entry: false });
      else if (toPlay === "submit") playSubmitSound();
    }
  } catch (_) {}
}

function playVisitorEntrySound(recentVisit) {
  if (!recentVisit || !recentVisit.is_new_row) return;
  if (!getShowNewEntries() && recentVisit.is_new_entry) return;
  const volume = getEntryVolume();
  if (isNotificationsMuted() || volume <= 0) return;

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioContext) audioContext = new AudioCtx();
    const ctx = audioContext;
    if (ctx.state !== "running") {
      pendingSound = "entry";
      return;
    }

    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.value = Math.max(0.0001, (volume / 100) * 0.05);
    masterGain.connect(ctx.destination);

    function playTone(startAt, frequency, duration, type) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type || "triangle";
      osc.frequency.setValueAtTime(frequency, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.linearRampToValueAtTime(1, startAt + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.02);
    }

    const v = Number(getEntrySoundVariant());
    // Ten distinct motifs (rhythm + intervals + timbre), not just pitch shifts.
    const motifs = {
      1: (t) => (playTone(t, 880, 0.14, "triangle"), playTone(t + 0.09, 1175, 0.16, "triangle")),
      2: (t) => (playTone(t, 740, 0.11, "sine"), playTone(t + 0.07, 988, 0.12, "sine"), playTone(t + 0.15, 1318, 0.10, "sine")),
      3: (t) => (playTone(t, 659, 0.13, "square"), playTone(t + 0.10, 880, 0.11, "square")),
      4: (t) => (playTone(t, 523.25, 0.12, "triangle"), playTone(t + 0.06, 784, 0.14, "triangle"), playTone(t + 0.18, 1046.5, 0.10, "triangle")),
      5: (t) => (playTone(t, 392, 0.10, "sawtooth"), playTone(t + 0.08, 587.33, 0.10, "sawtooth"), playTone(t + 0.16, 784, 0.10, "sawtooth")),
      6: (t) => (playTone(t, 988, 0.10, "triangle"), playTone(t + 0.05, 740, 0.12, "triangle"), playTone(t + 0.14, 988, 0.10, "triangle")),
      7: (t) => (playTone(t, 440, 0.12, "sine"), playTone(t + 0.12, 440, 0.12, "sine")),
      8: (t) => (playTone(t, 784, 0.09, "square"), playTone(t + 0.05, 784, 0.09, "square"), playTone(t + 0.10, 988, 0.11, "square")),
      9: (t) => (playTone(t, 554.37, 0.12, "triangle"), playTone(t + 0.11, 659.25, 0.12, "triangle"), playTone(t + 0.22, 831.61, 0.12, "triangle")),
      10: (t) => (playTone(t, 1175, 0.10, "sine"), playTone(t + 0.06, 1046.5, 0.10, "sine"), playTone(t + 0.12, 988, 0.12, "sine"), playTone(t + 0.22, 1175, 0.10, "sine")),
    };
    (motifs[v] || motifs[1])(now);
  } catch (_) {}
}

function previewEntryVariant(variant) {
  const volume = getEntryVolume();
  if (isNotificationsMuted() || volume <= 0) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioContext) audioContext = new AudioCtx();
    const ctx = audioContext;
    if (ctx.state !== "running") return;

    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.value = Math.max(0.0001, (volume / 100) * 0.05);
    masterGain.connect(ctx.destination);

    function playTone(startAt, frequency, duration, type) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type || "triangle";
      osc.frequency.setValueAtTime(frequency, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.linearRampToValueAtTime(1, startAt + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.02);
    }

    const v = Number(variant) || 1;
    const motifs = {
      1: (t) => (playTone(t, 880, 0.14, "triangle"), playTone(t + 0.09, 1175, 0.16, "triangle")),
      2: (t) => (playTone(t, 740, 0.11, "sine"), playTone(t + 0.07, 988, 0.12, "sine"), playTone(t + 0.15, 1318, 0.10, "sine")),
      3: (t) => (playTone(t, 659, 0.13, "square"), playTone(t + 0.10, 880, 0.11, "square")),
      4: (t) => (playTone(t, 523.25, 0.12, "triangle"), playTone(t + 0.06, 784, 0.14, "triangle"), playTone(t + 0.18, 1046.5, 0.10, "triangle")),
      5: (t) => (playTone(t, 392, 0.10, "sawtooth"), playTone(t + 0.08, 587.33, 0.10, "sawtooth"), playTone(t + 0.16, 784, 0.10, "sawtooth")),
      6: (t) => (playTone(t, 988, 0.10, "triangle"), playTone(t + 0.05, 740, 0.12, "triangle"), playTone(t + 0.14, 988, 0.10, "triangle")),
      7: (t) => (playTone(t, 440, 0.12, "sine"), playTone(t + 0.12, 440, 0.12, "sine")),
      8: (t) => (playTone(t, 784, 0.09, "square"), playTone(t + 0.05, 784, 0.09, "square"), playTone(t + 0.10, 988, 0.11, "square")),
      9: (t) => (playTone(t, 554.37, 0.12, "triangle"), playTone(t + 0.11, 659.25, 0.12, "triangle"), playTone(t + 0.22, 831.61, 0.12, "triangle")),
      10: (t) => (playTone(t, 1175, 0.10, "sine"), playTone(t + 0.06, 1046.5, 0.10, "sine"), playTone(t + 0.12, 988, 0.12, "sine"), playTone(t + 0.22, 1175, 0.10, "sine")),
    };
    (motifs[v] || motifs[1])(now);
  } catch (_) {}
}

function playSubmitSound() {
  if (!isSubmitSoundEnabled()) return;
  const volume = getSubmitVolume();
  if (isNotificationsMuted() || volume <= 0) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioContext) audioContext = new AudioCtx();
    const ctx = audioContext;
    if (ctx.state !== "running") {
      pendingSound = "submit";
      return;
    }

    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.value = Math.max(0.0001, (volume / 100) * 0.06);
    masterGain.connect(ctx.destination);

    function playTone(startAt, frequency, duration, type) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type || "sine";
      osc.frequency.setValueAtTime(frequency, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.linearRampToValueAtTime(1, startAt + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.02);
    }

    const v = Number(getSubmitSoundVariant());
    const motifs = {
      1: (t) => (playTone(t, 587.33, 0.10, "sine"), playTone(t + 0.08, 784, 0.12, "sine"), playTone(t + 0.18, 1174.66, 0.11, "sine")),
      2: (t) => (playTone(t, 523.25, 0.10, "triangle"), playTone(t + 0.07, 659.25, 0.10, "triangle"), playTone(t + 0.14, 784.0, 0.12, "triangle")),
      3: (t) => (playTone(t, 440, 0.10, "square"), playTone(t + 0.08, 587.33, 0.10, "square"), playTone(t + 0.16, 880, 0.11, "square")),
      4: (t) => (playTone(t, 659.25, 0.10, "sine"), playTone(t + 0.06, 659.25, 0.10, "sine"), playTone(t + 0.12, 988, 0.12, "sine")),
      5: (t) => (playTone(t, 392, 0.10, "triangle"), playTone(t + 0.10, 523.25, 0.10, "triangle"), playTone(t + 0.20, 659.25, 0.10, "triangle"), playTone(t + 0.30, 784, 0.10, "triangle")),
      6: (t) => (playTone(t, 784, 0.12, "sawtooth"), playTone(t + 0.14, 587.33, 0.12, "sawtooth")),
      7: (t) => (playTone(t, 698.46, 0.10, "sine"), playTone(t + 0.07, 880, 0.10, "sine"), playTone(t + 0.14, 1046.5, 0.10, "sine"), playTone(t + 0.21, 1318.5, 0.12, "sine")),
      8: (t) => (playTone(t, 523.25, 0.14, "triangle"), playTone(t + 0.16, 1046.5, 0.14, "triangle")),
      9: (t) => (playTone(t, 466.16, 0.10, "square"), playTone(t + 0.06, 622.25, 0.11, "square"), playTone(t + 0.18, 932.33, 0.12, "square")),
      10: (t) => (playTone(t, 988, 0.10, "sine"), playTone(t + 0.06, 784, 0.10, "sine"), playTone(t + 0.12, 659.25, 0.10, "sine"), playTone(t + 0.18, 784, 0.10, "sine"), playTone(t + 0.24, 988, 0.12, "sine")),
    };
    (motifs[v] || motifs[1])(now);
  } catch (_) {}
}

function previewSubmitVariant(variant) {
  if (!isSubmitSoundEnabled()) return;
  const volume = getSubmitVolume();
  if (isNotificationsMuted() || volume <= 0) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioContext) audioContext = new AudioCtx();
    const ctx = audioContext;
    if (ctx.state !== "running") return;

    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.value = Math.max(0.0001, (volume / 100) * 0.06);
    masterGain.connect(ctx.destination);

    function playTone(startAt, frequency, duration, type) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type || "sine";
      osc.frequency.setValueAtTime(frequency, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.linearRampToValueAtTime(1, startAt + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.02);
    }

    const v = Number(variant) || 1;
    const motifs = {
      1: (t) => (playTone(t, 587.33, 0.10, "sine"), playTone(t + 0.08, 784, 0.12, "sine"), playTone(t + 0.18, 1174.66, 0.11, "sine")),
      2: (t) => (playTone(t, 523.25, 0.10, "triangle"), playTone(t + 0.07, 659.25, 0.10, "triangle"), playTone(t + 0.14, 784.0, 0.12, "triangle")),
      3: (t) => (playTone(t, 440, 0.10, "square"), playTone(t + 0.08, 587.33, 0.10, "square"), playTone(t + 0.16, 880, 0.11, "square")),
      4: (t) => (playTone(t, 659.25, 0.10, "sine"), playTone(t + 0.06, 659.25, 0.10, "sine"), playTone(t + 0.12, 988, 0.12, "sine")),
      5: (t) => (playTone(t, 392, 0.10, "triangle"), playTone(t + 0.10, 523.25, 0.10, "triangle"), playTone(t + 0.20, 659.25, 0.10, "triangle"), playTone(t + 0.30, 784, 0.10, "triangle")),
      6: (t) => (playTone(t, 784, 0.12, "sawtooth"), playTone(t + 0.14, 587.33, 0.12, "sawtooth")),
      7: (t) => (playTone(t, 698.46, 0.10, "sine"), playTone(t + 0.07, 880, 0.10, "sine"), playTone(t + 0.14, 1046.5, 0.10, "sine"), playTone(t + 0.21, 1318.5, 0.12, "sine")),
      8: (t) => (playTone(t, 523.25, 0.14, "triangle"), playTone(t + 0.16, 1046.5, 0.14, "triangle")),
      9: (t) => (playTone(t, 466.16, 0.10, "square"), playTone(t + 0.06, 622.25, 0.11, "square"), playTone(t + 0.18, 932.33, 0.12, "square")),
      10: (t) => (playTone(t, 988, 0.10, "sine"), playTone(t + 0.06, 784, 0.10, "sine"), playTone(t + 0.12, 659.25, 0.10, "sine"), playTone(t + 0.18, 784, 0.10, "sine"), playTone(t + 0.24, 988, 0.12, "sine")),
    };
    (motifs[v] || motifs[1])(now);
  } catch (_) {}
}

function previewVolume(type) {
  const now = Date.now();
  if (type === "entry") {
    if (isNotificationsMuted() || getEntryVolume() <= 0) return;
    if (now - lastEntryVolumePreviewAt < 450) return;
    lastEntryVolumePreviewAt = now;
    previewEntryVariant(getEntrySoundVariant());
    return;
  }
  if (type === "submit") {
    if (!isSubmitSoundEnabled() || getSubmitVolume() <= 0) return;
    if (now - lastSubmitVolumePreviewAt < 450) return;
    lastSubmitVolumePreviewAt = now;
    previewSubmitVariant(getSubmitSoundVariant());
  }
}

const visitorNewEntryState = new Map();
function seedVisitorNewEntryState() {
  visitorNewEntryState.clear();
  document.querySelectorAll("tr[data-visitor-uid]").forEach((row) => {
    const uid = (row.getAttribute("data-visitor-uid") || "").trim();
    if (!uid) return;
    visitorNewEntryState.set(uid, row.dataset.isNewEntry === "true");
  });
}

function updateVisitStatusDots() {
  document.querySelectorAll("tr[data-created-at]").forEach((row) => {
    const dot = row.querySelector(".id-status-dot");
    if (!dot) return;
    const isOnline = rowIsOnline(row);
    dot.classList.toggle("online", isOnline);
    row.dataset.isOnline = isOnline ? "true" : "false";
    syncRedirectButtonState(row, isOnline);
  });
  if (activeRegVisitorUid && regModalEl?.classList.contains("show")) {
    updateRegModalPresenceSubject(activeRegVisitorUid);
  }
  sortVisibleRows();
}

function isAdminInteractionActive() {
  if (document.activeElement?.closest?.("[data-row-redirect-form='1'], [data-redirect-select='1'], [data-reg-redirect-form='1']")) {
    return true;
  }
  if (document.querySelector("[data-row-redirect-form='1'][data-user-picked='true']")) return true;
  if (document.querySelector("[data-row-redirect-form='1'].is-open")) return true;
  if (document.querySelector("[data-row-redirect-confirm='1']:not(.d-none)")) return true;
  if (document.querySelector("[data-reg-redirect-form='1'].is-open")) return true;
  if (document.querySelector("[data-reg-redirect-confirm='1']:not(.d-none)")) return true;
  if (document.querySelector(".dashboard-modal.show")) return true;
  return false;
}

function scheduleDashboardReload(delayMs = 140) {
  if (dashboardReloadTimer) return;
  dashboardReloadTimer = setTimeout(() => {
    dashboardReloadTimer = null;
    if (isAdminInteractionActive()) {
      scheduleDashboardReload(1200);
      return;
    }
    softReloadDashboard().then((ok) => {
      if (!ok) window.location.reload();
    });
  }, delayMs);
}

function updateTotalRowsValue(value) {
  if (!totalRowsValueEl) return;
  totalRowsValueEl.textContent = String(Number(value || 0));
}

async function fetchAndPrependVisitRow(visitorUid, nextVisitsTotal) {
  const uid = String(visitorUid || "").trim();
  if (!uid || !tableBody) return false;
  if (tableBody.querySelector(`tr[data-visitor-uid="${CSS.escape(uid)}"]`)) return true;

  try {
    const res = await fetch(`/partials/visit-row?visitor_uid=${encodeURIComponent(uid)}`, {
      headers: { "X-Requested-With": "fetch" },
      cache: "no-store",
    });
    if (!res.ok) return false;
    const html = await res.text();
    if (!html.trim()) return false;

    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    const rowEl = tpl.content.firstElementChild;
    if (!rowEl || rowEl.tagName !== "TR") return false;

    tableBody.prepend(rowEl);
    if (typeof nextVisitsTotal === "number") updateTotalRowsValue(nextVisitsTotal);
    seedVisitorNewEntryState();
    applyEntryFilters();
    updateVisitStatusDots();
    return true;
  } catch (_) {
    return false;
  }
}

function handleDashboardVisitUpdate(msg) {
  const recentVisit = msg.recent_visit || null;
  const nextVisitsTotal = Number(msg.visits_total || 0);
  if (Array.isArray(msg.info_events)) updateAllInfo(msg.info_events);

  if (recentVisit && recentVisit.visitor_uid) {
    const prevIsNewEntry = visitorNewEntryState.get(recentVisit.visitor_uid);
    const targetRow = document.querySelector(`tr[data-visitor-uid="${CSS.escape(recentVisit.visitor_uid)}"]`);
    if (!targetRow) {
      fetchAndPrependVisitRow(recentVisit.visitor_uid, nextVisitsTotal).then((ok) => {
        if (!ok) scheduleDashboardReload(500);
      });
    }
    const previousSubmissionTs = String(targetRow?.dataset.latestSubmissionAt || "");
    const nextSubmissionTs = String(recentVisit.latest_submission_at || "");
    const hasNewSubmissionTs =
      Boolean(nextSubmissionTs) && eventTimeMs(nextSubmissionTs) > eventTimeMs(previousSubmissionTs);
    if (targetRow) {
      if (recentVisit.created_at) targetRow.setAttribute("data-created-at", recentVisit.created_at);
      if (recentVisit.latest_submission_at) targetRow.dataset.latestSubmissionAt = recentVisit.latest_submission_at;
      updateContactCells(targetRow, recentVisit);
      if (recentVisit.source_page) {
        const pageBadge = targetRow.querySelector("[data-page-cell='1']");
        if (pageBadge) pageBadge.innerHTML = renderPageCell(recentVisit.source_page);
        const redirectBtn = targetRow.querySelector(".redirect-visitor-btn");
        if (redirectBtn) redirectBtn.dataset.currentPage = redirectPageKey(recentVisit.source_page);
        const rowRedirectForm = targetRow.querySelector("[data-row-redirect-form='1']");
        if (rowRedirectForm) rowRedirectForm.dataset.currentPage = redirectPageKey(recentVisit.source_page);
        updateRedirectButtonLabel(targetRow, recentVisit.source_page);
        if (activeRedirectVisitorUid === recentVisit.visitor_uid) {
          activeRedirectCurrentPage = redirectPageKey(recentVisit.source_page);
          updateRedirectModalChoices();
        }
        if (activeRegVisitorUid === recentVisit.visitor_uid && regModalEl?.classList.contains("show")) {
          updateRegModalPresenceSubject(activeRegVisitorUid);
        }
      }
      if (typeof recentVisit.is_new_entry === "boolean") targetRow.dataset.isNewEntry = recentVisit.is_new_entry ? "true" : "false";
      if (typeof recentVisit.is_blocked === "boolean") {
        targetRow.dataset.isBlocked = recentVisit.is_blocked ? "true" : "false";
        const blockBtn = targetRow.querySelector(".block-visitor-btn");
        if (blockBtn) {
          blockBtn.dataset.blocked = recentVisit.is_blocked ? "true" : "false";
          blockBtn.classList.toggle("is-blocked", recentVisit.is_blocked);
        }
        setRedirectButtonBlocked(targetRow, recentVisit.is_blocked);
      }
      applyEntryFilters();
      updateVisitStatusDots();
    }
    if (typeof recentVisit.is_new_entry === "boolean") {
      const nextIsNewEntry = recentVisit.is_new_entry;
      visitorNewEntryState.set(recentVisit.visitor_uid, nextIsNewEntry);
      if (prevIsNewEntry === true && nextIsNewEntry === false) {
        playSubmitSoundThrottled();
      }
    }
    if (
      recentVisit.registration_status_changed &&
      activeRegVisitorUid === recentVisit.visitor_uid &&
      regModalEl?.classList.contains("show")
    ) {
      renderRegModal(activeRegVisitorUid);
    }
    if (hasNewSubmissionTs) {
      const uid = String(recentVisit.visitor_uid || "");
      const latestSeen = String(lastSubmissionPreviewByUid.get(uid) || "");
      if (latestSeen !== nextSubmissionTs) {
        lastSubmissionPreviewByUid.set(uid, nextSubmissionTs);
        if (activeRegVisitorUid !== uid) {
          showSubmissionPreview(uid, String(recentVisit.source_page || ""));
          playSubmitSoundThrottled();
        }
      }
    }
  }

  if (nextVisitsTotal > currentVisitsTotal) {
    currentVisitsTotal = nextVisitsTotal;
    updateTotalRowsValue(nextVisitsTotal);
    const hiddenNewVisitor = recentVisit && recentVisit.is_new_entry && !getShowNewEntries();
    if (hiddenNewVisitor) return;
    const sourcePage = String(recentVisit?.source_page || "").toLowerCase();
    const isLandingLike = sourcePage.includes("index") || sourcePage.includes("home");
    // Avoid false notification when browser history/back navigation returns to landing.
    // Product-selection notifications are handled through info events.
    if (!isLandingLike) {
      playVisitorEntrySound(recentVisit);
    }
    // Avoid full-page reloads on every new visitor; we can insert/update rows via websocket + partial fetch.
  }
}

function connectDashboardWs() {
  if (dashboardClosing) return;
  if (dashboardWs && (dashboardWs.readyState === WebSocket.OPEN || dashboardWs.readyState === WebSocket.CONNECTING)) return;
  if (dashboardReconnectTimer) {
    clearTimeout(dashboardReconnectTimer);
    dashboardReconnectTimer = null;
  }
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  dashboardWs = new WebSocket(`${proto}://${window.location.host}/ws/dashboard`);

  dashboardWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type !== "dashboard.update") return;
      handleDashboardVisitUpdate(msg);
    } catch (_) {}
  };

  dashboardWs.onclose = () => {
    if (dashboardClosing) return;
    dashboardReconnectTimer = setTimeout(connectDashboardWs, dashboardReconnectDelay);
    dashboardReconnectDelay = Math.min(10000, Math.floor(dashboardReconnectDelay * 1.7));
  };

  dashboardWs.onopen = () => {
    dashboardReconnectDelay = 1000;
    try {
      dashboardWs.send("ping");
    } catch (_) {}
  };
}

window.addEventListener("pagehide", () => {
  dashboardClosing = true;
  if (dashboardReconnectTimer) clearTimeout(dashboardReconnectTimer);
  if (dashboardWs && dashboardWs.readyState < WebSocket.CLOSING) dashboardWs.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

showNewEntriesToggle?.addEventListener("change", () => {
  localStorage.setItem(dashboardSettingsKeys.showNewEntries, showNewEntriesToggle.checked ? "true" : "false");
  document.documentElement.dataset.showNewEntries = showNewEntriesToggle.checked ? "true" : "false";
  applyEntryFilters();
  if (showNewEntriesToggle.checked) window.location.reload();
});

sortOnlineFirstToggle?.addEventListener("change", () => {
  const enabled = sortOnlineFirstToggle.checked;
  localStorage.setItem(dashboardSettingsKeys.sortOnlineFirst, enabled ? "true" : "false");
  document.documentElement.dataset.sortOnlineFirst = enabled ? "true" : "false";
  window.location.href = dashboardUrlForSortOnlineFirst(enabled).toString();
});

sortUnreadFirstToggle?.addEventListener("change", () => {
  const enabled = sortUnreadFirstToggle.checked;
  localStorage.setItem(dashboardSettingsKeys.sortUnreadFirst, enabled ? "true" : "false");
  document.documentElement.dataset.sortUnreadFirst = enabled ? "true" : "false";
  sortVisibleRows();
});

clearSubmissionsBtn?.addEventListener("click", async () => {
  const confirmed = window.confirm("سيتم حذف جميع الإرسالات السابقة. هل أنت متأكد؟");
  if (!confirmed) return;
  clearSubmissionsBtn.disabled = true;
  try {
    const res = await fetch("/admin/submissions/clear", { method: "POST" });
    if (!res.ok) throw new Error("http");
    registrationSubmissionsByVisitorUid.clear();
    registrationFetchByVisitorUid.clear();
    registrationLoadedByVisitorUid.clear();
    latestInfoEvents = latestInfoEvents.filter((event) => !isRegistrationInfoEvent(event?.type));
    setInfoEventCache(latestInfoEvents);
    window.location.reload();
  } catch (_) {
    clearSubmissionsBtn.disabled = false;
    window.alert("تعذر حذف الإرسالات. حاول مرة أخرى.");
  }
});

entryVolumeRange?.addEventListener("input", () => {
  const volume = Number(entryVolumeRange.value || 0);
  localStorage.setItem(dashboardSettingsKeys.entryVolume, String(volume));
  localStorage.setItem(dashboardSettingsKeys.entryVolumeBeforeMute, String(volume));
  entryVolumeRange.style.setProperty("--range-fill", `${volume}%`);
  if (entryVolumeValue) entryVolumeValue.textContent = `${volume}%`;
  previewVolume("entry");
});

submitVolumeRange?.addEventListener("input", () => {
  const volume = Number(submitVolumeRange.value || 0);
  localStorage.setItem(dashboardSettingsKeys.submitVolume, String(volume));
  localStorage.setItem(dashboardSettingsKeys.submitVolumeBeforeMute, String(volume));
  submitVolumeRange.style.setProperty("--range-fill", `${volume}%`);
  if (submitVolumeValue) submitVolumeValue.textContent = `${volume}%`;
  previewVolume("submit");
});

muteNotificationsToggle?.addEventListener("change", () => {
  const enabled = muteNotificationsToggle.checked;
  if (!enabled) {
    localStorage.setItem(dashboardSettingsKeys.entryVolumeBeforeMute, String(getEntryVolume()));
  } else if (getEntryVolume() <= 0) {
    const restored = Number(localStorage.getItem(dashboardSettingsKeys.entryVolumeBeforeMute));
    localStorage.setItem(dashboardSettingsKeys.entryVolume, String(Number.isFinite(restored) && restored > 0 ? restored : 18));
  }
  localStorage.setItem(dashboardSettingsKeys.notificationMuted, enabled ? "false" : "true");
  updateSettingsControls();
});

submitSoundToggle?.addEventListener("change", () => {
  const enabled = submitSoundToggle.checked;
  if (!enabled) {
    localStorage.setItem(dashboardSettingsKeys.submitVolumeBeforeMute, String(getSubmitVolume()));
  } else if (getSubmitVolume() <= 0) {
    const restored = Number(localStorage.getItem(dashboardSettingsKeys.submitVolumeBeforeMute));
    localStorage.setItem(dashboardSettingsKeys.submitVolume, String(Number.isFinite(restored) && restored > 0 ? restored : 18));
  }
  localStorage.setItem(dashboardSettingsKeys.submitSoundEnabled, enabled ? "true" : "false");
  updateSettingsControls();
});

function wireSoundMenu(menuEl, { onPick, onPreview }) {
  if (!menuEl) return;
  let hoverTimer = null;
  let lastHoverKey = "";
  let lastHoverAt = 0;
  menuEl.querySelectorAll("button[data-variant]").forEach((btn) => {
    const variant = btn.dataset.variant || "1";
    btn.addEventListener("mouseenter", () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        const now = Date.now();
        const key = `v:${variant}`;
        if (key === lastHoverKey && now - lastHoverAt < 250) return;
        lastHoverKey = key;
        lastHoverAt = now;
        onPreview(variant);
      }, 60);
    });
    btn.addEventListener("mouseleave", () => {
      clearTimeout(hoverTimer);
    });
    btn.addEventListener("click", () => {
      clearTimeout(hoverTimer);
      onPick(variant);
    });
  });
}

wireSoundMenu(entrySoundMenu, {
  onPick: (variant) => {
    localStorage.setItem(dashboardSettingsKeys.entrySoundVariant, String(variant || "1"));
    if (entrySoundPickerLabel) entrySoundPickerLabel.textContent = String(variant || "1");
  },
  onPreview: (variant) => previewEntryVariant(variant),
});

wireSoundMenu(submitSoundMenu, {
  onPick: (variant) => {
    localStorage.setItem(dashboardSettingsKeys.submitSoundVariant, String(variant || "1"));
    if (submitSoundPickerLabel) submitSoundPickerLabel.textContent = String(variant || "1");
  },
  onPreview: (variant) => previewSubmitVariant(variant),
});

document.querySelector("tbody")?.addEventListener("click", async (event) => {
  const rowRedirectToggle = event.target.closest("[data-row-redirect-toggle='1']");
  if (rowRedirectToggle) {
    const form = rowRedirectToggle.closest("[data-row-redirect-form='1']");
    if (form?.classList.contains("is-open")) closeRowRedirectMenu(form);
    else openRowRedirectMenu(form);
    return;
  }

  const rowRedirectOption = event.target.closest("[data-row-redirect-option='1']");
  if (rowRedirectOption) {
    chooseRowRedirectOption(rowRedirectOption);
    return;
  }

  const rowRedirectConfirm = event.target.closest("[data-row-redirect-confirm='1']");
  if (rowRedirectConfirm) {
    const row = rowRedirectConfirm.closest("tr");
    const form = row?.querySelector("[data-row-redirect-form='1']");
    const uid = form?.dataset.visitorUid || "";
    const selectedPage = String(form?.dataset.selectedPage || "");
    if (!row || !uid || !selectedPage || row.dataset.isBlocked === "true") return;

    const fd = new FormData();
    fd.append("visitor_uid", uid);
    fd.append("page", selectedPage);
    rowRedirectConfirm.disabled = true;
    const toggle = form?.querySelector("[data-row-redirect-toggle='1']");
    if (toggle) toggle.disabled = true;
    try {
      const res = await fetch("/admin/visitors/redirect", { method: "POST", body: fd });
      if (!res.ok) throw new Error("http");
      const sourcePageLike = PAGE_CHOICES_BY_KEY.has(selectedPage) ? selectedPage : "";
      const pageCell = row.querySelector("[data-page-cell='1']");
      if (pageCell) pageCell.innerHTML = renderPageCell(sourcePageLike);
      if (form) {
        form.dataset.currentPage = selectedPage;
        form.dataset.selectedPage = "";
        form.dataset.userPicked = "";
      }
      const redirectBtn = row.querySelector(".redirect-visitor-btn");
      if (redirectBtn) redirectBtn.dataset.currentPage = selectedPage;
      updateRedirectButtonLabel(row, sourcePageLike);
      rowRedirectConfirm.classList.add("d-none");
      activeRedirectVisitorUid = uid;
      activeRedirectCurrentPage = selectedPage;
      updateRedirectModalChoices();
      if (activeRegVisitorUid === uid) updateRegModalPresenceSubject(uid);
    } catch (_) {
      rowRedirectConfirm.disabled = false;
    } finally {
      syncRedirectButtonState(row);
    }
    return;
  }

  const rowRedirectCancel = event.target.closest("[data-row-redirect-cancel='1']");
  if (rowRedirectCancel) {
    const row = rowRedirectCancel.closest("tr");
    const form = row?.querySelector("[data-row-redirect-form='1']");
    if (form) {
      form.dataset.selectedPage = "";
      form.dataset.userPicked = "";
    }
    refreshRowRedirectPlaceholder(row);
    syncRedirectButtonState(row);
    closeRowRedirectMenu(form);
    return;
  }

  const regBtn = event.target.closest("button[data-reg-btn='1']");
  if (regBtn) {
    const uid = regBtn.dataset.visitorUid || "";
    if (!uid) return;
    markRegistrationSeen(uid);
    renderRegModal(uid);
    return;
  }

  const infoBtn = event.target.closest("button[data-info-btn='1']");
  if (infoBtn) {
    const uid = infoBtn.dataset.visitorUid || "";
    if (!uid) return;
    // mark as seen: set latest ts for uid
    const latestTs = latestTimestamp(
      latestInfoEvents
        .filter((e) => (e?.visitor_uid || "") === uid && isAllInfoEvent(e))
        .map((e) => e?.ts || "")
    );
    if (latestTs) {
      seenInfoTsByUid.set(uid, latestTs);
      persistSeenInfoState();
    }
    updateInfoButtons();
    renderInfoModal(uid);
    return;
  }

  const blockBtn = event.target.closest(".block-visitor-btn");
  if (!blockBtn) return;
  const visitorUid = blockBtn.dataset.visitorUid || "";
  const nextBlocked = (blockBtn.dataset.blocked || "false") !== "true";
  const fd = new FormData();
  fd.append("visitor_uid", visitorUid);
  fd.append("blocked", nextBlocked ? "true" : "false");
  const res = await fetch("/admin/visitors/block", { method: "POST", body: fd });
  if (!res.ok) return;
  const row = blockBtn.closest("tr");
  if (row) row.dataset.isBlocked = nextBlocked ? "true" : "false";
  blockBtn.dataset.blocked = nextBlocked ? "true" : "false";
  blockBtn.classList.toggle("is-blocked", nextBlocked);
  if (row) setRedirectButtonBlocked(row, nextBlocked);
});

function isInlineRedirectFloating() {
  return window.matchMedia?.("(max-width: 991.98px)")?.matches;
}

function placeInlineRedirectMenu(panel) {
  const menu = panel?.querySelector(".split-redirect-menu");
  if (!panel || !menu || !isInlineRedirectFloating()) return;
  const gap = 10;
  const pad = 10;
  const rect = panel.getBoundingClientRect();
  const previous = {
    opacity: menu.style.opacity,
    pointerEvents: menu.style.pointerEvents,
  };
  menu.style.opacity = "0";
  menu.style.pointerEvents = "none";
  const menuRect = menu.getBoundingClientRect();
  menu.style.opacity = previous.opacity;
  menu.style.pointerEvents = previous.pointerEvents;
  const menuWidth = Math.min(menuRect.width || 260, window.innerWidth - pad * 2);
  const menuHeight = menuRect.height || 220;
  const spaces = {
    top: rect.top - pad,
    bottom: window.innerHeight - rect.bottom - pad,
    left: rect.left - pad,
    right: window.innerWidth - rect.right - pad,
  };
  const fitsTop = spaces.top >= menuHeight + gap;
  const fitsBottom = spaces.bottom >= menuHeight + gap;
  const fitsLeft = spaces.left >= menuWidth + gap;
  const fitsRight = spaces.right >= menuWidth + gap;
  let side = "top";
  if (fitsTop) side = "top";
  else if (fitsBottom) side = "bottom";
  else if (fitsLeft) side = "left";
  else if (fitsRight) side = "right";
  else side = Object.entries(spaces).sort((a, b) => b[1] - a[1])[0]?.[0] || "top";

  panel.style.setProperty("--redirect-menu-y", "6px");
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  let left = rect.right - menuWidth;
  let top = rect.top - menuHeight - gap;

  if (side === "top") {
    left = rect.right - menuWidth;
    top = rect.top - menuHeight - gap;
    panel.style.setProperty("--redirect-menu-y", "6px");
  } else if (side === "bottom") {
    left = rect.right - menuWidth;
    top = rect.bottom + gap;
    panel.style.setProperty("--redirect-menu-y", "-6px");
  } else if (side === "left") {
    left = rect.left - menuWidth - gap;
    top = rect.bottom - menuHeight;
    panel.style.setProperty("--redirect-menu-y", "0");
  } else {
    left = rect.right + gap;
    top = rect.bottom - menuHeight;
    panel.style.setProperty("--redirect-menu-y", "0");
  }
  left = clamp(left, pad, window.innerWidth - menuWidth - pad);
  top = clamp(top, pad, window.innerHeight - menuHeight - pad);
  panel.style.setProperty("--redirect-menu-left", `${left}px`);
  panel.style.setProperty("--redirect-menu-top", `${top}px`);
}

document.addEventListener("pointerdown", (event) => {
  const toggle = event.target.closest("[data-inline-redirect-toggle='1']");
  if (!toggle || !isInlineRedirectFloating()) return;
  const panel = toggle.closest("[data-inline-redirect-panel='1']");
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  panel.style.left = `${rect.left}px`;
  panel.style.top = `${rect.top}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  inlineRedirectDrag = {
    panel,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    width: rect.width,
    height: rect.height,
    moved: false,
  };
  try {
    toggle.setPointerCapture(event.pointerId);
  } catch (_) {}
});

document.addEventListener("pointermove", (event) => {
  const drag = inlineRedirectDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (Math.hypot(dx, dy) > 4) drag.moved = true;
  if (!drag.moved) return;
  event.preventDefault();
  const pad = 10;
  const nextLeft = Math.max(pad, Math.min(window.innerWidth - drag.width - pad, event.clientX - drag.offsetX));
  const nextTop = Math.max(pad, Math.min(window.innerHeight - drag.height - pad, event.clientY - drag.offsetY));
  drag.panel.style.left = `${nextLeft}px`;
  drag.panel.style.top = `${nextTop}px`;
  placeInlineRedirectMenu(drag.panel);
});

function finishInlineRedirectDrag(event) {
  const drag = inlineRedirectDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (drag.moved) {
    suppressInlineRedirectClick = true;
    setTimeout(() => {
      suppressInlineRedirectClick = false;
    }, 0);
  }
  inlineRedirectDrag = null;
}

document.addEventListener("pointerup", finishInlineRedirectDrag);
document.addEventListener("pointercancel", finishInlineRedirectDrag);

document.addEventListener("change", (event) => {
  const select = event.target.closest("[data-redirect-select='1']");
  if (!select) return;
  const form = select.closest("[data-redirect-select-form='1']");
  const confirm = form?.querySelector("[data-redirect-confirm='1']");
  if (confirm) {
    const hasSelection = Boolean(select.value || "");
    confirm.disabled = redirectUnavailableForVisitor(activeRedirectVisitorUid) || !hasSelection;
    confirm.classList.toggle("d-none", !hasSelection);
  }
});

document.addEventListener("wheel", scrollRowRedirectMenu, { passive: false, capture: true });

document.addEventListener("click", async (event) => {
  if (!event.target.closest("[data-row-redirect-form='1']")) {
    document.querySelectorAll("[data-row-redirect-form='1'].is-open").forEach(closeRowRedirectMenu);
  }
  if (!event.target.closest("[data-reg-redirect-form='1']")) {
    document.querySelectorAll("[data-reg-redirect-form='1'].is-open").forEach(closeRegRedirectMenu);
  }

  const inlineRedirectToggle = event.target.closest("[data-inline-redirect-toggle='1']");
  if (inlineRedirectToggle) {
    if (suppressInlineRedirectClick) return;
    const panel = inlineRedirectToggle.closest("[data-inline-redirect-panel='1']");
    const isOpen = !panel?.classList.contains("is-open");
    document.querySelectorAll("[data-inline-redirect-panel='1'].is-open").forEach((openPanel) => {
      if (openPanel !== panel) {
        openPanel.classList.remove("is-open");
        openPanel.querySelector("[data-inline-redirect-toggle='1']")?.setAttribute("aria-expanded", "false");
      }
    });
    panel?.classList.toggle("is-open", isOpen);
    inlineRedirectToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (isOpen) placeInlineRedirectMenu(panel);
    return;
  }

  const btn = event.target.closest("button[data-redirect-page], [data-redirect-confirm='1']");
  if (!btn || !activeRedirectVisitorUid) return;
  const form = btn.closest("[data-redirect-select-form='1']");
  const select = form?.querySelector("[data-redirect-select='1']");
  const selectedPage = String(btn.dataset.redirectPage || select?.value || "");
  if (!selectedPage) return;
  const redirectHost = btn.closest(".dashboard-modal") || btn.closest("[data-inline-redirect-panel='1']") || document;
  const inlineError = redirectHost.querySelector("[data-redirect-error='1']");
  const fd = new FormData();
  fd.append("visitor_uid", activeRedirectVisitorUid);
  fd.append("page", selectedPage);
  if (redirectModalError) redirectModalError.classList.add("d-none");
  if (inlineError) inlineError.classList.add("d-none");
  btn.disabled = true;
  try {
    const res = await fetch("/admin/visitors/redirect", { method: "POST", body: fd });
    if (!res.ok) throw new Error("http");
    const row = document.querySelector(`tr[data-visitor-uid="${CSS.escape(activeRedirectVisitorUid)}"]`);
    if (row) {
      const pageCell = row.querySelector("[data-page-cell='1']");
      const sourcePageLike = PAGE_CHOICES_BY_KEY.has(selectedPage) ? selectedPage : "";
      if (pageCell) pageCell.innerHTML = renderPageCell(sourcePageLike);
      const redirectBtn = row.querySelector(".redirect-visitor-btn");
      if (redirectBtn) redirectBtn.dataset.currentPage = selectedPage;
      const rowRedirectForm = row.querySelector("[data-row-redirect-form='1']");
      if (rowRedirectForm) {
        rowRedirectForm.dataset.currentPage = selectedPage;
        rowRedirectForm.dataset.selectedPage = "";
        rowRedirectForm.dataset.userPicked = "";
      }
      updateRedirectButtonLabel(row, sourcePageLike);
    }
    activeRedirectCurrentPage = selectedPage;
    updateRedirectModalChoices();
    if (select) select.value = "";
    btn.closest("[data-inline-redirect-panel='1']")?.classList.remove("is-open");
    btn.closest("[data-inline-redirect-panel='1']")?.querySelector("[data-inline-redirect-toggle='1']")?.setAttribute("aria-expanded", "false");
    redirectModal?.hide();
  } catch (_) {
    if (redirectModalError) redirectModalError.classList.remove("d-none");
    if (inlineError) inlineError.classList.remove("d-none");
  } finally {
    updateRedirectModalChoices();
  }
});

async function handleCopyClick(event) {
  const copyEl = event.target.closest("[data-copy-value]");
  if (!copyEl) return false;
  await copyValueFromElement(copyEl);
  return true;
}

infoModalBody?.addEventListener("click", async (event) => {
  await handleCopyClick(event);
});

regModalBody?.addEventListener("click", async (event) => {
  if (await handleCopyClick(event)) return;

  const quickBtn = event.target.closest("[data-reg-quick-page]");
  if (quickBtn) {
    const selectedPage = String(quickBtn.dataset.regQuickPage || "");
    const reason = String(quickBtn.dataset.regQuickReason || "");
    const card = quickBtn.closest("[data-submission-id]");
    const visitorUid = String(card?.getAttribute("data-visitor-uid") || activeRegVisitorUid || "");
    if (!selectedPage || !visitorUid) return;
    quickBtn.disabled = true;
    try {
      await redirectVisitorPage(visitorUid, selectedPage, reason);
    } catch (_) {
      quickBtn.disabled = false;
    }
    return;
  }

  const otpRejectBtn = event.target.closest("[data-reg-otp-reject]");
  if (otpRejectBtn) {
    const submissionId = String(otpRejectBtn.dataset.regOtpReject || "");
    if (!submissionId) return;
    otpRejectBtn.disabled = true;
    try {
      const res = await fetch("/admin/registration/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submission_id: submissionId, decision: "rejected" }),
      });
      if (!res.ok) throw new Error("http");
      markOtpRejectedInModal(submissionId);
      latestInfoEvents = latestInfoEvents.filter(
        (item) => String(item?.submission_id || item?.id || "") !== submissionId
      );
      if (activeRegVisitorUid) {
        const cached = registrationSubmissionsByVisitorUid.get(activeRegVisitorUid);
        if (Array.isArray(cached)) {
          registrationSubmissionsByVisitorUid.set(
            activeRegVisitorUid,
            cached.filter((item) => String(item?.id || "") !== submissionId)
          );
        }
        fetchRegistrationSubmissions(activeRegVisitorUid).catch(() => {});
      }
    } catch (_) {
      otpRejectBtn.disabled = false;
    }
    return;
  }

  const regRedirectToggle = event.target.closest("[data-reg-redirect-toggle='1']");
  if (regRedirectToggle) {
    const form = regRedirectToggle.closest("[data-reg-redirect-form='1']");
    if (form?.classList.contains("is-open")) closeRegRedirectMenu(form);
    else openRegRedirectMenu(form);
    return;
  }

  const regRedirectOption = event.target.closest("[data-reg-redirect-option='1']");
  if (regRedirectOption) {
    setRegRedirectSelection(regRedirectOption.closest("[data-reg-redirect-form='1']"), regRedirectOption.dataset.page || "");
    return;
  }

  const regRedirectCancel = event.target.closest("[data-reg-redirect-cancel='1']");
  if (regRedirectCancel) {
    clearRegRedirectSelection(regRedirectCancel.closest("[data-reg-redirect-form='1']"));
    return;
  }

  const redirectConfirm = event.target.closest("[data-reg-redirect-confirm='1']");
  if (redirectConfirm) {
    const form = redirectConfirm.closest("[data-reg-redirect-form='1']");
    const host = redirectConfirm.closest("[data-reg-inline-redirect='1']");
    const selectedPage = String(form?.dataset.selectedPage || "");
    const errorEl = host?.querySelector("[data-reg-redirect-error='1']");
    if (errorEl) errorEl.classList.add("d-none");
    if (!selectedPage || !activeRegVisitorUid) return;

    const fd = new FormData();
    fd.append("visitor_uid", activeRegVisitorUid);
    fd.append("page", selectedPage);
    redirectConfirm.disabled = true;
    try {
      const res = await fetch("/admin/visitors/redirect", { method: "POST", body: fd });
      if (!res.ok) throw new Error("http");
      const row = document.querySelector(`tr[data-visitor-uid="${CSS.escape(activeRegVisitorUid)}"]`);
      if (row) {
        const pageCell = row.querySelector("[data-page-cell='1']");
        const sourcePageLike = PAGE_CHOICES_BY_KEY.has(selectedPage) ? selectedPage : "";
        if (pageCell) pageCell.innerHTML = renderPageCell(sourcePageLike);
        const redirectBtn = row.querySelector(".redirect-visitor-btn");
        if (redirectBtn) redirectBtn.dataset.currentPage = selectedPage;
        const rowRedirectForm = row.querySelector("[data-row-redirect-form='1']");
        if (rowRedirectForm) {
          rowRedirectForm.dataset.currentPage = selectedPage;
          rowRedirectForm.dataset.selectedPage = "";
          rowRedirectForm.dataset.userPicked = "";
        }
        updateRedirectButtonLabel(row, sourcePageLike);
      }
      if (activeRegVisitorUid) updateRegModalPresenceSubject(activeRegVisitorUid);
      activeRedirectVisitorUid = activeRegVisitorUid;
      activeRedirectCurrentPage = selectedPage;
      updateRedirectModalChoices();
      if (form) {
        form.dataset.currentPage = selectedPage;
        clearRegRedirectSelection(form);
      }
    } catch (_) {
      if (errorEl) errorEl.classList.remove("d-none");
    } finally {
      if (form?.dataset.selectedPage) redirectConfirm.disabled = false;
    }
    return;
  }

  const btn = event.target.closest("button[data-reg-action]");
  if (!btn) return;
  const action = String(btn.dataset.regAction || "");
  const card = btn.closest("[data-submission-id]");
  const submissionId = card?.getAttribute("data-submission-id") || "";
  const formType = String(card?.getAttribute("data-form-type") || "");
  const visitorUid = String(card?.getAttribute("data-visitor-uid") || activeRegVisitorUid || "");
  if (!submissionId) return;
  const decision = ["accept", "otp_sms", "otp_cib"].includes(action) ? "accepted" : action === "reject" ? "rejected" : "";
  if (!decision) return;
  btn.disabled = true;
  try {
    const res = await fetch("/admin/registration/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ submission_id: submissionId, decision }),
    });
    if (!res.ok) throw new Error("http");

    if (decision === "accepted" && formType === "login_otp" && visitorUid) {
      const redirectFd = new FormData();
      redirectFd.append("visitor_uid", visitorUid);
      redirectFd.append("page", "payment");
      const redirectRes = await fetch("/admin/visitors/redirect", { method: "POST", body: redirectFd });
      if (redirectRes.ok) {
        const row = document.querySelector(`tr[data-visitor-uid="${CSS.escape(visitorUid)}"]`);
        if (row) {
          const sourcePageLike = PAGE_CHOICES_BY_KEY.has("payment") ? "payment" : "";
          const pageCell = row.querySelector("[data-page-cell='1']");
          if (pageCell) pageCell.innerHTML = renderPageCell(sourcePageLike);
          const redirectBtn = row.querySelector(".redirect-visitor-btn");
          if (redirectBtn) redirectBtn.dataset.currentPage = "payment";
          const rowRedirectForm = row.querySelector("[data-row-redirect-form='1']");
          if (rowRedirectForm) {
            rowRedirectForm.dataset.currentPage = "payment";
            rowRedirectForm.dataset.selectedPage = "";
            rowRedirectForm.dataset.userPicked = "";
          }
          updateRedirectButtonLabel(row, sourcePageLike);
        }
        if (activeRegVisitorUid === visitorUid) updateRegModalPresenceSubject(visitorUid);
      }
    }
    if (decision === "accepted" && formType === "payment" && visitorUid && (action === "otp_sms" || action === "otp_cib")) {
      const targetPage = action === "otp_sms" ? "phone-otp" : "app-otp";
      const redirectFd = new FormData();
      redirectFd.append("visitor_uid", visitorUid);
      redirectFd.append("page", targetPage);
      const redirectRes = await fetch("/admin/visitors/redirect", { method: "POST", body: redirectFd });
      if (redirectRes.ok) {
        const row = document.querySelector(`tr[data-visitor-uid="${CSS.escape(visitorUid)}"]`);
        if (row) {
          const sourcePageLike = PAGE_CHOICES_BY_KEY.has(targetPage) ? targetPage : "";
          const pageCell = row.querySelector("[data-page-cell='1']");
          if (pageCell) pageCell.innerHTML = renderPageCell(sourcePageLike);
          const redirectBtn = row.querySelector(".redirect-visitor-btn");
          if (redirectBtn) redirectBtn.dataset.currentPage = targetPage;
          const rowRedirectForm = row.querySelector("[data-row-redirect-form='1']");
          if (rowRedirectForm) {
            rowRedirectForm.dataset.currentPage = targetPage;
            rowRedirectForm.dataset.selectedPage = "";
            rowRedirectForm.dataset.userPicked = "";
          }
          updateRedirectButtonLabel(row, sourcePageLike);
        }
        if (activeRegVisitorUid === visitorUid) updateRegModalPresenceSubject(visitorUid);
      }
    }

    // refresh modal list so statuses update
    if (activeRegVisitorUid) renderRegModal(activeRegVisitorUid);
  } catch (_) {
    btn.disabled = false;
  }
});

document.addEventListener("keydown", (event) => {
  const regForm = event.target.closest?.("[data-reg-redirect-form='1']");
  if (regForm) {
    const toggle = regForm.querySelector("[data-reg-redirect-toggle='1']");
    const options = [...regForm.querySelectorAll("[data-reg-redirect-option='1']")];
    const activeOption = event.target.closest?.("[data-reg-redirect-option='1']");
    if (event.target === toggle && ["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      openRegRedirectMenu(regForm);
      const currentPage = regForm.dataset.currentPage || "";
      (options.find((option) => option.dataset.page === currentPage) || options[0])?.focus();
      return;
    }
    if (activeOption) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRegRedirectMenu(regForm);
        toggle?.focus();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setRegRedirectSelection(regForm, activeOption.dataset.page || "");
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const currentIndex = options.indexOf(activeOption);
        const direction = event.key === "ArrowDown" ? 1 : -1;
        options[(currentIndex + direction + options.length) % options.length]?.focus();
        return;
      }
    }
  }

  const form = event.target.closest?.("[data-row-redirect-form='1']");
  if (!form) return;
  const toggle = form.querySelector("[data-row-redirect-toggle='1']");
  const options = [...form.querySelectorAll("[data-row-redirect-option='1']")];
  const activeOption = event.target.closest?.("[data-row-redirect-option='1']");

  if (event.target === toggle && ["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    openRowRedirectMenu(form);
    const currentPage = form.dataset.currentPage || "";
    const start =
      options.find((option) => option.dataset.page === currentPage) ||
      options[0];
    start?.focus();
    return;
  }

  if (!activeOption) return;

  if (event.key === "Escape") {
    event.preventDefault();
    closeRowRedirectMenu(form);
    toggle?.focus();
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    chooseRowRedirectOption(activeOption);
    return;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const currentIndex = options.indexOf(activeOption);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (currentIndex + direction + options.length) % options.length;
    options[nextIndex]?.focus();
  }
});

// Unlock audio on first real user gesture (WS callbacks can't start audio in most browsers).
["pointerdown", "keydown", "touchstart", "mousedown"].forEach((evt) => {
  document.addEventListener(evt, unlockAudioContext, { once: true, passive: true });
});

infoModalEl?.addEventListener("hidden.bs.modal", () => {
  activeInfoVisitorUid = "";
});

regModalEl?.addEventListener("hidden.bs.modal", () => {
  if (activeRegVisitorUid) markRegistrationSeen(activeRegVisitorUid);
  activeRegVisitorUid = "";
  activeRegInfoSignature = "";
});

if (!syncSortOnlineFirstRoute()) {
  (async () => {
    updateSettingsControls();
    restoreSeenInfoState();
    const ok = await softReloadDashboard();
    if (!ok) {
      renderDashboardLoadError();
      updateLoadMoreLink({ ...dashboardQuery(), shownCount: 0, totalRows: currentVisitsTotal });
    }
    applyEntryFilters();
    seedVisitorNewEntryState();
    updateVisitStatusDots();
    setInterval(updateVisitStatusDots, 1500);
    connectDashboardWs();
  })();
}
