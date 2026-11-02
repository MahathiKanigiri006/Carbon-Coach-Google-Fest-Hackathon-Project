const SESSION_KEY = "carbon-coach-session";
const CHAT_KEY = "carbon-coach-chat";
const CATEGORY_COLORS = ["#5b9a69", "#d9a64d", "#d17b67", "#568f84"];
const CATEGORIES = ["Travel", "Electricity", "Food", "Waste"];
const CATEGORY_ICONS = {
  Travel: { className: "blue", path: '<path d="M5 17h14l1-8H4l1 8Z"/><path d="M7 9V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3M7 17v2m10-2v2M6 13h.01M18 13h.01"/>' },
  Electricity: { className: "amber", path: '<path d="M13 2 4.5 13h6L10 22l9.5-12h-6L13 2Z"/>' },
  Food: { className: "coral", path: '<path d="M3 11h18a8 8 0 0 1-16 0ZM12 3v2m6-1-1 2M6 4l1 2"/>' },
  Waste: { className: "mint", path: '<path d="M3 6h18m-2 0-1 14H6L5 6m4 0V4h6v2m-5 4v6m4-6v6"/>' },
};
const TRAVEL_MODE_NOTES = {
  bus: "Passenger-km estimate using a UK bus proxy; not India-specific.",
  car: "Whole petrol hatchback emissions per vehicle-km; not divided among passengers.",
  motorcycle: "Whole-vehicle scooter estimate under 110 cc; not divided among passengers.",
  auto_rickshaw: "Whole CNG auto-rickshaw estimate per vehicle-km; not divided among passengers.",
  train: "Indian Railways passenger-km estimate based on 2012–13 data.",
  metro: "Approximate rail passenger-km proxy; this is not a metro-specific factor.",
};

let sessionId = localStorage.getItem(SESSION_KEY);
let categoryChart;
let comparisonChart;
let dashboardData;
let busy = false;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(numeric);
}

function iconSvg(path) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.innerHTML = `<span class="toast-icon">${type === "error" ? "!" : "✓"}</span><span>${escapeHtml(message)}</span>`;
  $("#toast-region").append(toast);
  window.setTimeout(() => toast.remove(), 4500);
}

async function api(path, options = {}, recoverExpiredSession = true) {
  const headers = new Headers(options.headers || {});
  if (sessionId) headers.set("X-Session-ID", sessionId);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    throw new Error("Could not reach Carbon Coach. Check that the backend is running.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data.detail === "string" ? data.detail : "Something went wrong. Please try again.";
    const isSessionCheck = path.startsWith("/api/session/");
    if (
      recoverExpiredSession
      && sessionId
      && !isSessionCheck
      && response.status === 404
      && /session (?:has )?expired|session not found/i.test(detail)
    ) {
      localStorage.removeItem(`${CHAT_KEY}:${sessionId}`);
      let sessionResponse;
      try {
        sessionResponse = await fetch("/api/session", { method: "POST" });
      } catch {
        throw new Error("Your session expired, and Carbon Coach could not start a new one. Check that the backend is running.");
      }
      const newSession = await sessionResponse.json().catch(() => ({}));
      if (!sessionResponse.ok || !newSession.session_id) {
        const sessionError = typeof newSession.detail === "string"
          ? newSession.detail
          : "Could not start a new Carbon Coach session.";
        throw new Error(sessionError);
      }
      sessionId = newSession.session_id;
      localStorage.setItem(SESSION_KEY, sessionId);
      showToast(
        "Your previous session expired, likely after a server restart. Its activities could not be restored; a new session was started and your request was retried.",
        "error",
      );
      if (path.endsWith("/clear-chat")) return { session_id: sessionId };
      return api(path, options, false);
    }
    throw new Error(detail);
  }
  return data;
}

async function ensureSession() {
  if (sessionId) {
    try {
      await api(`/api/session/${encodeURIComponent(sessionId)}`);
      return;
    } catch (error) {
      if (!/expired|not found/i.test(error.message)) throw error;
      localStorage.removeItem(SESSION_KEY);
      sessionId = null;
    }
  }
  const session = await api("/api/session", { method: "POST" });
  sessionId = session.session_id;
  localStorage.setItem(SESSION_KEY, sessionId);
}

function setLoading(loading) {
  busy = loading;
  $("#global-loading").classList.toggle("hidden", !loading);
  $("#global-loading").setAttribute("aria-hidden", String(!loading));
}

function switchPage(page) {
  const validPages = ["dashboard", "track", "recommendations", "assistant"];
  if (!validPages.includes(page)) return;
  $$(".page-view").forEach((view) => view.classList.toggle("active", view.id === `page-${page}`));
  $$(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.page === page));
  $("#breadcrumb-current").textContent = ({
    dashboard: "Overview",
    track: "Track activity",
    recommendations: "AI recommendations",
    assistant: "Carbon Coach AI",
  })[page];
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
  document.body.classList.remove("nav-open");
  if (page === "recommendations" && dashboardData) renderRecommendations(dashboardData);
}

function renderActivityList(activities) {
  const list = $("#activity-list");
  if (!activities.length) {
    list.innerHTML = '<div class="activity-empty"><strong>Your first activity starts here</strong><span>Log an activity to see your footprint take shape.</span></div>';
    return;
  }
  list.innerHTML = activities.slice().reverse().slice(0, 4).map((activity) => {
    const category = CATEGORIES.includes(activity.category) ? activity.category : "Travel";
    const icon = CATEGORY_ICONS[category];
    const description = activity.note
      ? `${category} · ${activity.note}`
      : category;
    return `<div class="activity-row">
      <span class="activity-category-icon ${icon.className}">${iconSvg(icon.path)}</span>
      <span class="activity-info"><strong>${escapeHtml(activity.details)}</strong><span>${escapeHtml(description)}</span></span>
      <span class="activity-emission">${formatNumber(activity.emissions)}<small>kg CO₂e</small></span>
    </div>`;
  }).join("");
}

function renderPreview(recommendations, empty) {
  const target = $("#recommendation-preview");
  if (empty || !recommendations.length) {
    target.innerHTML = '<div class="no-recommendation">Record an activity to receive a personal next step.</div>';
    return;
  }
  const recommendation = recommendations[0];
  const category = recommendation.category || "Personalized";
  target.innerHTML = `<div class="preview-recommendation">
    <span class="preview-category">${escapeHtml(category)} · estimated savings ${formatNumber(recommendation.estimated_savings_kg_co2e)} kg CO₂e</span>
    <strong>${escapeHtml(recommendation.suggestion)}</strong>
    <p>${escapeHtml(recommendation.assumption)}</p>
  </div>`;
}

function renderCharts(data) {
  const breakdown = data.category_breakdown || {};
  const values = CATEGORIES.map((category) => Number(breakdown[category] || 0));
  const hasActivities = !data.empty && values.some((value) => value > 0);
  $("#category-chart-wrap").classList.toggle("hidden", !hasActivities);
  $("#category-empty").classList.toggle("hidden", hasActivities);
  $("#comparison-chart-wrap").classList.toggle("hidden", !hasActivities);
  $("#comparison-empty").classList.toggle("hidden", hasActivities);
  if (!hasActivities || typeof Chart === "undefined") {
    categoryChart?.destroy();
    comparisonChart?.destroy();
    return;
  }
  categoryChart?.destroy();
  comparisonChart?.destroy();
  const chartText = getComputedStyle(document.body).getPropertyValue("--text-secondary").trim();
  const gridColor = getComputedStyle(document.body).getPropertyValue("--line").trim();
  categoryChart = new Chart($("#category-chart"), {
    type: "doughnut",
    data: {
      labels: CATEGORIES,
      datasets: [{ data: values, backgroundColor: CATEGORY_COLORS, borderWidth: 0, hoverOffset: 5 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "73%",
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => ` ${context.label}: ${formatNumber(context.raw)} kg CO₂e` } } },
    },
  });
  comparisonChart = new Chart($("#comparison-chart"), {
    type: "bar",
    data: {
      labels: CATEGORIES,
      datasets: [{ data: values, backgroundColor: CATEGORY_COLORS, borderRadius: 5, maxBarThickness: 26 }],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => ` ${formatNumber(context.raw)} kg CO₂e` } } },
      scales: {
        x: { beginAtZero: true, grid: { color: gridColor }, border: { display: false }, ticks: { color: chartText, font: { family: "DM Sans", size: 9 } } },
        y: { grid: { display: false }, border: { display: false }, ticks: { color: chartText, font: { family: "DM Sans", size: 9 } } },
      },
    },
  });
}

function renderDashboard(data) {
  dashboardData = data;
  const breakdown = data.category_breakdown || {};
  $("#stat-total").textContent = formatNumber(data.total_emissions_kg_co2e);
  $("#stat-travel").textContent = formatNumber(breakdown.Travel);
  $("#stat-electricity").textContent = formatNumber(breakdown.Electricity);
  $("#stat-food").textContent = formatNumber(breakdown.Food);
  $("#stat-waste").textContent = formatNumber(breakdown.Waste);
  $("#stat-count").textContent = formatNumber(data.activity_count);
  $("#stat-potential").textContent = formatNumber(data.reduction_potential_kg_co2e);
  renderCharts(data);
  renderActivityList(data.activities || []);
  renderPreview(data.recommendations || [], data.empty);
  if ($("#page-recommendations").classList.contains("active")) renderRecommendations(data);
}

function renderRecommendations(data) {
  const recommendations = data.recommendations || [];
  $("#recommendation-summary").innerHTML = `<div><span>Your estimated opportunity</span><h2>${data.empty ? "Your journey starts with one activity." : "A few thoughtful changes can add up."}</h2><p>${data.empty ? "Track an activity to get recommendations shaped around your impact." : "Based on the activities recorded in your current session."}</p></div><div class="potential-number">${formatNumber(data.reduction_potential_kg_co2e)}<span>kg CO₂e estimated savings</span></div>`;
  const target = $("#recommendation-list");
  if (!recommendations.length) {
    target.innerHTML = `<div class="recommendation-empty"><span class="empty-illustration"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M25 42c8-4 13-11 13-21A14 14 0 0 0 10 21c0 10 5 17 15 21Z"/><path d="M25 36V21m0 7-6-6m6 2 6-6"/></svg></span><h2>No recommendations yet</h2><p>${data.empty ? "Once you record an activity, your agent can suggest practical ways to reduce its impact." : "Your agent has no specific reduction recommendations for the activities recorded yet."}</p><button class="button button-primary" type="button" data-navigate="track">Track an activity <span aria-hidden="true">→</span></button></div>`;
    return;
  }
  target.innerHTML = recommendations.map((recommendation) => {
    const details = recommendation.activity || "";
    const category = recommendation.category || "Activity";
    return `<article class="panel recommendation-card">
      <div class="rec-card-top"><span class="category-pill">${escapeHtml(category)}</span><span class="savings-pill">${iconSvg('<path d="M12 19V5m-6 6 6-6 6 6"/>')}${formatNumber(recommendation.estimated_savings_kg_co2e)} kg CO₂e</span></div>
      <h3>${escapeHtml(recommendation.suggestion)}</h3>
      <p class="rec-activity">For: ${escapeHtml(details)}</p>
      <div class="assumption-box"><strong>Assumption</strong><p>${escapeHtml(recommendation.assumption)}</p></div>
      <span class="estimate-tag">${iconSvg('<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5m0 3h.01"/>')} Estimated savings — not guaranteed</span>
    </article>`;
  }).join("");
}

async function refreshDashboard(showErrors = true) {
  try {
    const data = await api("/api/dashboard");
    renderDashboard(data);
    return data;
  } catch (error) {
    if (showErrors) showToast(error.message, "error");
    throw error;
  }
}

function formPayload(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  for (const [key, value] of Object.entries(values)) {
    if (key === "mode" || key === "diet_type" || key === "disposal_method") continue;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) throw new Error("Enter a number greater than zero.");
    values[key] = numeric;
  }
  return values;
}

function showCalculationResult(form, result) {
  const output = $(".calculation-result", form);
  const title = document.createElement("strong");
  title.textContent = `${result.category}: ${formatNumber(result.emissions_kg_co2e)} kg CO₂e`;
  output.replaceChildren(title);
  const details = [result.factor_unit ? `Factor basis: ${result.factor_unit}` : "", result.source, result.note].filter(Boolean);
  details.forEach((detail) => {
    const line = document.createElement("p");
    line.textContent = detail;
    output.append(line);
  });
  output.classList.remove("hidden", "error");
  output.setAttribute("role", "status");
}

function showCalculationError(form, message) {
  const output = $(".calculation-result", form);
  const title = document.createElement("strong");
  title.textContent = "Calculation could not be completed";
  const detail = document.createElement("p");
  detail.textContent = message;
  output.replaceChildren(title, detail);
  output.classList.remove("hidden");
  output.classList.add("error");
  output.setAttribute("role", "alert");
}

$$(".activity-form").forEach((form) => {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity() || busy) return;
    let payload;
    try {
      payload = formPayload(form);
    } catch (error) {
      showToast(error.message, "error");
      return;
    }
    const button = $(".form-submit", form);
    const label = $("span", button);
    const originalLabel = label.textContent;
    const output = $(".calculation-result", form);
    output.classList.add("hidden");
    output.classList.remove("error");
    button.disabled = true;
    label.textContent = "Calculating with your agent…";
    try {
      const result = await api(`/api/activities/${form.dataset.category}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      showCalculationResult(form, result);
      form.reset();
      showToast(`${result.category} activity recorded · ${formatNumber(result.emissions_kg_co2e)} kg CO₂e`);
      try {
        await refreshDashboard(false);
      } catch (error) {
        showToast(`Activity recorded, but the dashboard could not refresh: ${error.message}`, "error");
      }
    } catch (error) {
      showCalculationError(form, error.message);
      showToast(error.message, "error");
    } finally {
      button.disabled = false;
      label.textContent = originalLabel;
    }
  });
});

$("#travel-mode").addEventListener("change", (event) => {
  $("#travel-mode-help").textContent = TRAVEL_MODE_NOTES[event.target.value]
    || "Select a transport mode to see its calculation basis.";
});

function loadChat() {
  const stored = JSON.parse(localStorage.getItem(`${CHAT_KEY}:${sessionId}`) || "[]");
  if (!Array.isArray(stored)) return;
  stored.forEach(({ role, text }) => {
    if (role === "user" || role === "assistant") appendMessage(role, text, false);
  });
}

function saveChat(role, text) {
  const key = `${CHAT_KEY}:${sessionId}`;
  const history = JSON.parse(localStorage.getItem(key) || "[]");
  history.push({ role, text });
  localStorage.setItem(key, JSON.stringify(history.slice(-80)));
}

function appendMessage(role, text, persist = true) {
  const welcome = $("#chat-welcome");
  if (welcome) welcome.remove();
  const row = document.createElement("div");
  row.className = `chat-row ${role}`;
  if (role === "assistant") {
    const avatar = document.createElement("span");
    avatar.className = "chat-mini-avatar";
    avatar.innerHTML = '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M25.8 5.2C17.7 5 9.3 7 7 13.7c-1.6 4.7 2 8.2 6.2 7.5 6.3-1 9.9-9.2 12.6-16Z" fill="currentColor"/><path d="M5.5 27c3.4-7.1 8-11.3 14.2-15.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
    row.append(avatar);
  }
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = text;
  const time = document.createElement("span");
  time.className = "chat-time";
  time.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date());
  bubble.append(time);
  row.append(bubble);
  $("#chat-messages").append(row);
  $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
  if (persist) saveChat(role, text);
}

function showTyping() {
  const row = document.createElement("div");
  row.className = "chat-row assistant";
  row.id = "typing-row";
  row.innerHTML = '<span class="chat-mini-avatar"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M25.8 5.2C17.7 5 9.3 7 7 13.7c-1.6 4.7 2 8.2 6.2 7.5 6.3-1 9.9-9.2 12.6-16Z" fill="currentColor"/><path d="M5.5 27c3.4-7.1 8-11.3 14.2-15.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></span><span class="typing-indicator" aria-label="Carbon Coach is responding"><span></span><span></span><span></span></span>';
  $("#chat-messages").append(row);
  $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
}

async function sendChat(text) {
  const message = text.trim();
  if (!message || busy) return;
  appendMessage("user", message);
  $("#chat-input").value = "";
  $("#send-button").disabled = true;
  busy = true;
  showTyping();
  try {
    const result = await api("/api/chat", { method: "POST", body: JSON.stringify({ message }) });
    $("#typing-row")?.remove();
    appendMessage("assistant", result.response);
    refreshDashboard(false).catch((error) => showToast(error.message, "error"));
  } catch (error) {
    $("#typing-row")?.remove();
    showToast(error.message, "error");
    appendMessage("assistant", `I couldn't complete that request. ${error.message}`);
  } finally {
    busy = false;
    $("#send-button").disabled = false;
    $("#chat-input").focus();
  }
}

$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  sendChat($("#chat-input").value);
});
$$(".suggestion-chip").forEach((chip) => chip.addEventListener("click", () => sendChat(chip.dataset.prompt)));

$("#clear-chat").addEventListener("click", async () => {
  if (busy) return;
  $("#clear-chat").disabled = true;
  try {
    const result = await api(`/api/session/${encodeURIComponent(sessionId)}/clear-chat`, { method: "POST" });
    localStorage.removeItem(`${CHAT_KEY}:${sessionId}`);
    sessionId = result.session_id;
    localStorage.setItem(SESSION_KEY, sessionId);
    $("#chat-messages").innerHTML = "";
    const welcome = document.createElement("div");
    welcome.className = "welcome-message";
    welcome.id = "chat-welcome";
    welcome.innerHTML = '<div class="welcome-orb"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M25.8 5.2C17.7 5 9.3 7 7 13.7c-1.6 4.7 2 8.2 6.2 7.5 6.3-1 9.9-9.2 12.6-16Z" fill="currentColor"/><path d="M5.5 27c3.4-7.1 8-11.3 14.2-15.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></div><h2>A lighter footprint starts with a conversation.</h2><p>I can help you understand your emissions and find practical ways to reduce them.</p><div class="suggestion-label">TRY ASKING</div><div class="suggestion-list"><button class="suggestion-chip" type="button" data-prompt="Calculate my carbon footprint.">Calculate my carbon footprint <span>↗</span></button><button class="suggestion-chip" type="button" data-prompt="How can I reduce my emissions?">How can I reduce my emissions? <span>↗</span></button><button class="suggestion-chip" type="button" data-prompt="Show my total emissions.">Show my total emissions <span>↗</span></button><button class="suggestion-chip" type="button" data-prompt="How much carbon did I save?">How much carbon did I save? <span>↗</span></button><button class="suggestion-chip" type="button" data-prompt="Give me eco-friendly suggestions.">Give me eco-friendly suggestions <span>↗</span></button></div>';
    $("#chat-messages").append(welcome);
    $$(".suggestion-chip").forEach((chip) => chip.addEventListener("click", () => sendChat(chip.dataset.prompt)));
    await refreshDashboard(false);
    showToast("Chat cleared. Your recorded activities are still here.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    $("#clear-chat").disabled = false;
  }
});

$("#theme-toggle").addEventListener("click", () => {
  const enabled = document.body.classList.toggle("dark");
  localStorage.setItem("carbon-coach-theme", enabled ? "dark" : "light");
  $("#theme-toggle").setAttribute("aria-label", `Switch to ${enabled ? "light" : "dark"} mode`);
  $("#theme-toggle span:nth-child(2)").textContent = enabled ? "Light appearance" : "Dark appearance";
  if (dashboardData) renderCharts(dashboardData);
});

const savedTheme = localStorage.getItem("carbon-coach-theme");
if (savedTheme === "dark") {
  document.body.classList.add("dark");
  $("#theme-toggle").setAttribute("aria-label", "Switch to light mode");
  $("#theme-toggle span:nth-child(2)").textContent = "Light appearance";
}

document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-page], [data-navigate]");
  if (!nav) return;
  event.preventDefault();
  switchPage(nav.dataset.page || nav.dataset.navigate);
});

$("#mobile-menu").addEventListener("click", () => document.body.classList.add("nav-open"));
$("#mobile-backdrop").addEventListener("click", () => document.body.classList.remove("nav-open"));
window.addEventListener("hashchange", () => switchPage(location.hash.slice(1) || "dashboard"));

async function startApp() {
  const initialPage = location.hash.slice(1) || "dashboard";
  switchPage(initialPage);
  try {
    setLoading(true);
    await ensureSession();
    loadChat();
    await refreshDashboard();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setLoading(false);
  }
}

startApp();
