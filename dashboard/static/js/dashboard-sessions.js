const sessionsBody = document.getElementById("sessionsBody");
const activeSessionsCountEl = document.getElementById("activeSessionsCount");
const openSessionsBtn = document.getElementById("openSessionsBtn");
let latestSessions = [];
let adminWs = null;
let adminReconnectTimer = null;
let adminReconnectDelay = 1000;
let adminClosing = false;

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function applySummary(count) {
  if (activeSessionsCountEl) activeSessionsCountEl.textContent = String(count || 0);
  if (!openSessionsBtn) return;
  if ((count || 0) > 0) openSessionsBtn.classList.add("is-active");
  else openSessionsBtn.classList.remove("is-active");
}

const sessionsModal = document.getElementById("sessionsModal");
const openCreateAdminBtn = document.getElementById("openCreateAdminBtn");
const createAdminPanel = document.getElementById("createAdminPanel");
const closeCreateAdminBtn = document.getElementById("closeCreateAdminBtn");
const createAdminForm = document.getElementById("createAdminForm");
const createAdminMsg = document.getElementById("createAdminMsg");
const sessionsActionMsg = document.getElementById("sessionsActionMsg");
const logoutForm = document.getElementById("logoutForm");
const usernameInput = createAdminForm?.querySelector('input[name=\"username\"]');
const usernameInlineError = document.getElementById("usernameInlineError");

function renderSessions(sessions) {
  if (!sessions || !sessions.length) {
    sessionsBody.innerHTML = '<tr><td colspan="5" class="text-center text-secondary py-4">لا توجد جلسات نشطة</td></tr>';
    return;
  }
  sessionsBody.innerHTML = sessions.map((s) => `
    <tr>
      <td>${escapeHtml(s.username)}</td>
        <td>${s.last_activity === "الآن" ? '<span class="live-now-dot" title="الآن"></span>' : escapeHtml(s.last_activity)}</td>
        <td>${escapeHtml(s.device)}</td>
        <td>
          ${!s.is_root
            ? `<div class="d-flex align-items-center justify-content-center gap-1">
                 <input class="form-control form-control-sm mini-input inline-pass-input" style="max-width:160px;min-height:30px" data-username="${escapeHtml(s.username)}" value="" placeholder="${escapeHtml(s.password || '')}" />
                 <button class="eye-btn save-password-btn" data-username="${escapeHtml(s.username)}" aria-label="حفظ"><i class="fa-solid fa-check"></i></button>
                 <button class="eye-btn cancel-password-btn" data-username="${escapeHtml(s.username)}" aria-label="إلغاء"><i class="fa-solid fa-xmark"></i></button>
               </div>`
            : ""}
        </td>
        <td>
        <div class="d-flex gap-1 justify-content-center align-items-center">
          ${!s.is_root ? `<button class="block-admin-btn ${s.is_blocked ? 'is-blocked' : ''}" data-username="${escapeHtml(s.username)}" data-blocked="${s.is_blocked ? 'true' : 'false'}" aria-label="${s.is_blocked ? 'إلغاء حظر المشرف' : 'حظر المشرف'}"><i class="fa-solid fa-ban"></i></button>` : '<span class="text-secondary">-</span>'}
        </div>
      </td>
    </tr>
  `).join("");
}

function connectAdminWs() {
  if (adminClosing) return;
  if (adminWs && (adminWs.readyState === WebSocket.OPEN || adminWs.readyState === WebSocket.CONNECTING)) return;
  if (adminReconnectTimer) {
    clearTimeout(adminReconnectTimer);
    adminReconnectTimer = null;
  }
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  adminWs = new WebSocket(`${proto}://${window.location.host}/ws/admin`);

  adminWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type !== "admin.update") return;
      const count = Number(msg.active_sessions_count || 0);
      applySummary(count);
      latestSessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      if (sessionsModal.classList.contains("show")) renderSessions(latestSessions);
    } catch (_) {}
  };

  adminWs.onclose = () => {
    if (adminClosing) return;
    adminReconnectTimer = setTimeout(connectAdminWs, adminReconnectDelay);
    adminReconnectDelay = Math.min(10000, Math.floor(adminReconnectDelay * 1.7));
  };

  adminWs.onopen = () => {
    adminReconnectDelay = 1000;
    try {
      adminWs.send("ping");
    } catch (_) {}
  };
}

window.addEventListener("pagehide", () => {
  adminClosing = true;
  if (adminReconnectTimer) clearTimeout(adminReconnectTimer);
  if (adminWs && adminWs.readyState < WebSocket.CLOSING) adminWs.close();
});

async function warmSessionsFallback() {
  if (latestSessions.length) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch("/admin/sessions/list", { signal: controller.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!res.ok) return;
    const data = await res.json();
    latestSessions = Array.isArray(data.sessions) ? data.sessions : [];
  } catch (_) {}
}

async function blockAdmin(username, nextBlocked) {
  const fd = new FormData();
  fd.append("username", username);
  fd.append("blocked", nextBlocked ? "true" : "false");
  const res = await fetch("/admin/admins/block", { method: "POST", body: fd });
  if (!res.ok) return;
  latestSessions = latestSessions.map((row) =>
    row.username === username ? { ...row, is_blocked: nextBlocked, can_terminate: nextBlocked ? false : row.can_terminate, token: nextBlocked ? "" : row.token } : row
  );
  if (sessionsModal.classList.contains("show")) renderSessions(latestSessions);
}

openCreateAdminBtn?.addEventListener("click", () => {
  createAdminPanel.classList.remove("d-none");
  createAdminMsg.textContent = "";
  usernameInput?.classList.remove("is-invalid");
  usernameInlineError?.classList.remove("show");
});

closeCreateAdminBtn?.addEventListener("click", () => {
  createAdminPanel.classList.add("d-none");
  createAdminMsg.textContent = "";
  usernameInput?.classList.remove("is-invalid");
  usernameInlineError?.classList.remove("show");
});

document.addEventListener("click", (e) => {
  if (!createAdminPanel || createAdminPanel.classList.contains("d-none")) return;
  if (createAdminPanel.contains(e.target)) return;
  if (openCreateAdminBtn && openCreateAdminBtn.contains(e.target)) return;
  createAdminPanel.classList.add("d-none");
  createAdminMsg.textContent = "";
  usernameInput?.classList.remove("is-invalid");
  usernameInlineError?.classList.remove("show");
});

createAdminForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(createAdminForm);
  createAdminMsg.textContent = "جاري الإنشاء...";
  usernameInput?.classList.remove("is-invalid");
  usernameInlineError?.classList.remove("show");
  const res = await fetch("/admin/admins/create", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    createAdminMsg.textContent = "تم إنشاء المشرف بنجاح";
    createAdminForm.reset();
    return;
  }
  if (data.error === "username_exists" || data.error === "invalid_username") {
    createAdminMsg.textContent = "";
    usernameInput?.classList.add("is-invalid");
    usernameInlineError.textContent = "اسم المستخدم غير صحيح";
    usernameInlineError?.classList.add("show");
  }
  else if (data.error === "invalid_input") createAdminMsg.textContent = "المدخلات غير صالحة";
  else createAdminMsg.textContent = "فشل إنشاء المشرف";
});

sessionsModal.addEventListener("show.bs.modal", () => {
  renderSessions(latestSessions);
  warmSessionsFallback().then(() => renderSessions(latestSessions));
});


sessionsBody.addEventListener("click", (e) => {
  const cancelBtn = e.target.closest(".cancel-password-btn");
  if (cancelBtn) {
    const rowEl = cancelBtn.closest("tr");
    const input = rowEl ? rowEl.querySelector(".inline-pass-input") : null;
    if (input) input.value = "";
    return;
  }
  const saveBtn = e.target.closest(".save-password-btn");
  if (saveBtn) {
    const u = saveBtn.dataset.username || "";
    const rowEl = saveBtn.closest("tr");
    const input = rowEl ? rowEl.querySelector(".inline-pass-input") : null;
    const newPassword = input ? input.value.trim() : "";
    if (!newPassword) return;
    const iconEl = saveBtn.querySelector("i");
    saveBtn.disabled = true;
    if (iconEl) iconEl.className = "fa-solid fa-spinner fa-spin";
    const fd = new FormData();
    fd.append("username", u);
    fd.append("password", newPassword);
    fetch("/admin/admins/update-password", { method: "POST", body: fd }).then(async (res) => {
      if (!res.ok) {
        if (iconEl) iconEl.className = "fa-solid fa-triangle-exclamation";
        setTimeout(() => {
          if (iconEl) iconEl.className = "fa-solid fa-check";
          saveBtn.disabled = false;
        }, 450);
        return;
      }
      latestSessions = latestSessions.map((row) => row.username === u ? { ...row, password: newPassword } : row);
      if (input) input.value = "";
      if (iconEl) iconEl.className = "fa-solid fa-check";
      saveBtn.disabled = false;
      renderSessions(latestSessions);
      if (sessionsActionMsg) {
        sessionsActionMsg.textContent = "تم تعديل كلمة المرور بنجاح";
        setTimeout(() => {
          if (sessionsActionMsg.textContent === "تم تعديل كلمة المرور بنجاح") {
            sessionsActionMsg.textContent = "";
          }
        }, 2200);
      }
    });
    return;
  }
  const blockBtn = e.target.closest(".block-admin-btn");
  if (blockBtn) {
    const current = (blockBtn.dataset.blocked || "false") === "true";
    blockAdmin(blockBtn.dataset.username || "", !current);
  }
});

connectAdminWs();
warmSessionsFallback();

logoutForm?.addEventListener("submit", (e) => {
  if (!adminWs || adminWs.readyState !== WebSocket.OPEN) return;
  e.preventDefault();
  try {
    adminWs.send("logout");
  } catch (_) {}
  setTimeout(() => {
    logoutForm.submit();
  }, 80);
});
