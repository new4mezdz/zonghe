"use strict";

const API_BASE = "/pending_records/api";

const state = {
  config: null,
  records: [],
  editId: null,
  savedId: null,
  deleteId: null,
  workflowRecordId: null,
  pendingSummary: [],
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function localDateString(value = new Date()) {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  let result;
  try {
    result = await response.json();
  } catch (_) {
    throw new Error("服务器返回内容无法读取");
  }
  if (!response.ok || !result.success) {
    throw new Error(result.message || "操作失败");
  }
  return result;
}

function toast(message, type = "") {
  const item = document.createElement("div");
  item.className = `toast ${type}`.trim();
  item.textContent = message;
  $("#toastRegion").appendChild(item);
  window.setTimeout(() => item.remove(), 3600);
}

function switchTab(name) {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  $("#entryView").classList.toggle("active", name === "entry");
  $("#ledgerView").classList.toggle("active", name === "ledger");
  $("#pendingSummaryView").classList.toggle("active", name === "pending-summary");
  if (name === "ledger") loadRecords();
  if (name === "pending-summary") loadPendingSummary();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderConfig() {
  const productSelect = $("#productSelect");
  state.config.products.forEach((product) => {
    const option = document.createElement("option");
    option.value = product;
    option.textContent = product;
    productSelect.appendChild(option);
  });

  const shiftSelect = $("#shiftSelect");
  state.config.shifts.forEach((shift) => {
    const option = document.createElement("option");
    option.value = shift;
    option.textContent = shift;
    shiftSelect.appendChild(option);
  });

  $("#machineOptions").innerHTML = state.config.machines.map((machine) => `
    <label class="choice-chip">
      <input type="checkbox" name="machines" value="${escapeHtml(machine)}">
      <span>${escapeHtml(machine)}</span>
    </label>`).join("");

  const reasonLabels = {
    "待关联": "待关联",
    "关联异常": "关联异常",
    "待检": "待检",
    "缺陷": "缺陷",
    "其他": "其他",
  };
  $("#reasonOptions").innerHTML = state.config.reason_types.map((type) => {
    const needsDetail = ["待检", "缺陷", "其他"].includes(type);
    const placeholder = type === "待检" ? "请填写待检项目" : type === "缺陷" ? "请填写缺陷内容" : "请填写其他原因";
    return `
      <div class="reason-option ${needsDetail ? "" : "simple"}" data-reason="${escapeHtml(type)}">
        <label>
          <input type="checkbox" name="reason" value="${escapeHtml(type)}">
          <span>${escapeHtml(reasonLabels[type])}</span>
        </label>
        ${needsDetail ? `<input type="text" class="reason-detail" maxlength="100" placeholder="${placeholder}" aria-label="${escapeHtml(type)}说明" disabled>` : ""}
      </div>`;
  }).join("");

  $$(".reason-option").forEach((row) => {
    const checkbox = $('input[type="checkbox"]', row);
    const detail = $(".reason-detail", row);
    checkbox.addEventListener("change", () => {
      if (!detail) return;
      detail.disabled = !checkbox.checked;
      if (!checkbox.checked) detail.value = "";
      if (checkbox.checked) detail.focus();
    });
  });
}

async function updateNumberPreview() {
  const recordDate = $("#recordDate").value;
  const preview = $("#numberPreview strong");
  if (state.editId) return;
  if (!recordDate) {
    preview.textContent = "选择日期后生成";
    return;
  }
  preview.textContent = "正在生成…";
  try {
    const result = await api(`${API_BASE}/next-number?date=${encodeURIComponent(recordDate)}`);
    preview.textContent = result.record_no;
  } catch (_) {
    preview.textContent = "暂时无法预览";
  }
}

function collectForm() {
  const form = $("#recordForm");
  const reasons = $$(".reason-option").flatMap((row) => {
    const checked = $('input[type="checkbox"]', row);
    if (!checked.checked) return [];
    return [{
      type: checked.value,
      detail: $(".reason-detail", row)?.value.trim() || "",
    }];
  });
  return {
    record_date: form.elements.record_date.value,
    shift: form.elements.shift.value,
    product: form.elements.product.value,
    machines: $$('input[name="machines"]:checked', form).map((input) => input.value),
    case_count: form.elements.case_count.value,
    strip_count: form.elements.strip_count.value,
    custodian: form.elements.custodian.value.trim(),
    reasons,
  };
}

function validateClient(payload) {
  if (!payload.record_date) return "请选择日期";
  if (!payload.shift) return "请选择班组";
  if (!payload.product) return "请选择牌号";
  if (!payload.machines.length) return "请至少选择一个机台号";
  const cases = Number(payload.case_count || 0);
  const strips = Number(payload.strip_count || 0);
  if (cases < 0 || strips < 0 || (!cases && !strips)) return "件数和条数不能同时为 0";
  if (!payload.custodian) return "请填写存放人";
  if (!payload.reasons.length) return "请至少选择一项待处理原因";
  const missingDetail = payload.reasons.find((reason) => ["待检", "缺陷", "其他"].includes(reason.type) && !reason.detail);
  if (missingDetail) return `请填写“${missingDetail.type}”的具体说明`;
  return "";
}

async function saveRecord(event) {
  event.preventDefault();
  const payload = collectForm();
  const validationMessage = validateClient(payload);
  if (validationMessage) {
    toast(validationMessage, "error");
    return;
  }
  const button = $("#saveButton");
  button.disabled = true;
  button.classList.add("loading");
  try {
    const result = await api(state.editId ? `${API_BASE}/records/${state.editId}` : `${API_BASE}/records`, {
      method: state.editId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    state.savedId = result.record.id;
    $("#savedNumber").textContent = result.record.record_no;
    $("#successTitle").textContent = state.editId ? "记录已更新，可以打印了" : "可以打印了";
    $("#successModal").classList.remove("hidden");
    state.editId = null;
    await loadRecords(false);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.classList.remove("loading");
  }
}

function resetForm({ preserveDate = true } = {}) {
  const dateValue = preserveDate ? ($("#recordDate").value || localDateString()) : localDateString();
  $("#recordForm").reset();
  $("#recordDate").value = dateValue;
  $("#recordForm").elements.case_count.value = "0";
  $("#recordForm").elements.strip_count.value = "0";
  $$(".reason-detail").forEach((input) => { input.disabled = true; });
  state.editId = null;
  $("#formTitle").textContent = "新建记录";
  $("#cancelEdit").classList.add("hidden");
  $("#saveButton .button-label").textContent = "保存记录";
  updateNumberPreview();
}

function fillForm(record) {
  const form = $("#recordForm");
  state.editId = record.id;
  form.elements.record_date.value = record.record_date;
  form.elements.shift.value = record.shift || "";
  form.elements.product.value = record.product;
  form.elements.case_count.value = record.case_count;
  form.elements.strip_count.value = record.strip_count;
  form.elements.custodian.value = record.custodian;
  $$('input[name="machines"]', form).forEach((input) => { input.checked = record.machines.includes(input.value); });
  $$(".reason-option").forEach((row) => {
    const checkbox = $('input[type="checkbox"]', row);
    const matching = record.reasons.find((reason) => reason.type === checkbox.value);
    checkbox.checked = Boolean(matching);
    const detail = $(".reason-detail", row);
    if (detail) {
      detail.disabled = !matching;
      detail.value = matching?.detail || "";
    }
  });
  $("#numberPreview strong").textContent = record.record_no;
  $("#formTitle").textContent = `编辑记录 ${record.record_no}`;
  $("#cancelEdit").classList.remove("hidden");
  $("#saveButton .button-label").textContent = "更新记录";
  switchTab("entry");
}

function reasonText(reasons) {
  return reasons.map((reason) => reason.detail ? `${reason.type}：${reason.detail}` : reason.type).join("；");
}

function quantityText(quantity) {
  const parts = [];
  if (quantity.case_count) parts.push(`${quantity.case_count}件`);
  if (quantity.strip_count) parts.push(`${quantity.strip_count}条`);
  return parts.join(" ") || "0件 0条";
}

function formatTimestamp(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(parsed).replaceAll("/", "-");
}

function renderQuantityHistory(record) {
  const initial = record.initial_quantity || { case_count: record.case_count, strip_count: record.strip_count };
  const additions = (record.quantity_additions || []).map((entry, index) => `
    <div class="quantity-line addition" title="${escapeHtml(entry.note || "")}">
      <span>新增 ${index + 1}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}</span>
      <strong>＋${escapeHtml(quantityText(entry))}</strong>
    </div>`).join("");
  const total = record.total_quantity || initial;
  return `
    <div class="quantity-history">
      <div class="quantity-line initial"><span>首次</span><strong>${escapeHtml(quantityText(initial))}</strong></div>
      ${additions}
      <div class="quantity-total"><span>累计</span><strong>${escapeHtml(quantityText(total))}</strong></div>
    </div>`;
}

function renderDispositionHistory(record) {
  const entries = (record.disposition_entries || []).map((entry, index) => {
    const handled = Number(entry.case_count || 0) || Number(entry.strip_count || 0)
      ? `处理 ${quantityText(entry)}`
      : "历史处置记录（未填写数量）";
    return `
      <div class="disposition-entry">
        <strong>第 ${index + 1} 次 · ${escapeHtml(handled)}</strong>
        <span>${escapeHtml(entry.disposition)} · ${escapeHtml(entry.disposer)} · ${escapeHtml(formatTimestamp(entry.created_at))}</span>
      </div>`;
  }).join("");
  const remaining = record.remaining_quantity || { case_count: record.case_count, strip_count: record.strip_count };
  const complete = remaining.case_count === 0 && remaining.strip_count === 0;
  return `
    <div class="disposition-history">
      ${entries || '<div class="disposition-entry"><span>尚未补录处理记录</span></div>'}
      <div class="remaining-quantity ${complete ? "complete" : ""}"><span>剩余</span><strong>${escapeHtml(quantityText(remaining))}</strong></div>
    </div>`;
}

function shiftClass(shift) {
  if (shift === "甲班") return "shift-a";
  if (shift === "乙班") return "shift-b";
  if (shift === "丙班") return "shift-c";
  return "shift-unknown";
}

function renderRecords() {
  const rows = $("#recordRows");
  $("#emptyState").classList.toggle("hidden", state.records.length > 0);
  rows.innerHTML = state.records.map((record) => `
    <tr>
      <td><span class="record-primary">${escapeHtml(record.record_date)}</span><span class="record-secondary">${escapeHtml(record.record_no)}</span></td>
      <td><span class="shift-badge ${shiftClass(record.shift)}">${escapeHtml(record.shift || "未设置")}</span></td>
      <td class="table-product">${escapeHtml(record.product)}</td>
      <td><div class="table-machines">${record.machines.map((machine) => `<span>${escapeHtml(machine)}</span>`).join("")}</div></td>
      <td>${renderQuantityHistory(record)}</td>
      <td>${escapeHtml(record.custodian)}</td>
      <td><div class="reason-summary" title="${escapeHtml(reasonText(record.reasons))}">${escapeHtml(reasonText(record.reasons))}</div></td>
      <td>${renderDispositionHistory(record)}</td>
      <td><span class="status-badge ${record.status}">${record.status === "completed" ? "已处置" : "待处置"}</span></td>
      <td class="action-column"><div class="row-actions">
        <button class="row-button" type="button" data-action="edit" data-id="${record.id}">编辑基础</button>
        <button class="row-button" type="button" data-action="add-quantity" data-id="${record.id}">补充数量</button>
        <button class="row-button" type="button" data-action="add-disposition" data-id="${record.id}" ${record.status === "completed" ? "disabled" : ""}>补录处理</button>
        <button class="row-button" type="button" data-action="print" data-id="${record.id}">打印</button>
        <button class="row-button danger" type="button" data-action="delete" data-id="${record.id}">删除</button>
      </div></td>
    </tr>`).join("");
  $("#tableNote").textContent = state.records.length ? `当前显示 ${state.records.length} 条，最多显示最近 500 条。` : "";
}

function filteredUrl() {
  const params = new URLSearchParams({ limit: "500" });
  const values = {
    q: $("#searchInput").value.trim(),
    date_from: $("#dateFrom").value,
    date_to: $("#dateTo").value,
    status: $("#statusFilter").value,
    shift: $("#shiftFilter").value,
  };
  Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
  return `${API_BASE}/records?${params}`;
}

async function loadRecords(render = true) {
  try {
    const allResult = await api(`${API_BASE}/records?limit=500`);
    updateSummary(allResult.records);
    if (render) {
      const result = await api(filteredUrl());
      state.records = result.records;
      renderRecords();
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

function updateSummary(records) {
  const today = localDateString();
  const month = today.slice(0, 7);
  $("#todayCount").textContent = records.filter((record) => record.record_date === today).length;
  $("#pendingCount").textContent = records.filter((record) => record.status === "pending").length;
  $("#pendingSummaryCount").textContent = records.filter((record) => record.status === "pending").length;
  $("#monthCount").textContent = records.filter((record) => record.record_date.startsWith(month)).length;
  $("#allCount").textContent = records.length;
}

function renderPendingSummary() {
  const grid = $("#pendingStatsGrid");
  grid.innerHTML = state.pendingSummary.map((item) => {
    const watermark = item.shift.replace("班", "");
    const productRows = item.products.length
      ? item.products.map((product) => `
        <div class="pending-brand-row">
          <div class="pending-brand-name">${escapeHtml(product.product)}<br><small>${product.record_count} 条待处置记录</small></div>
          <div class="pending-brand-counts">
            <span>${product.case_count} 件</span>
            <span>${product.strip_count} 条</span>
          </div>
        </div>`).join("")
      : '<div class="pending-brand-empty">当前没有未补录的待处置记录</div>';
    return `
      <article class="pending-shift-card">
        <header class="pending-shift-head" data-watermark="${escapeHtml(watermark)}">
          <div><h3>${escapeHtml(item.shift)}</h3><p>按牌号汇总</p></div>
          <div class="pending-shift-total">
            <strong>${item.case_count} 件 · ${item.strip_count} 条</strong>
            <span>${item.record_count} 条待处置记录</span>
          </div>
        </header>
        <div class="pending-brand-list">${productRows}</div>
      </article>`;
  }).join("");
}

async function loadPendingSummary() {
  const refreshButton = $("#refreshPendingSummary");
  refreshButton.disabled = true;
  try {
    const result = await api(`${API_BASE}/pending-summary`);
    state.pendingSummary = result.summary;
    renderPendingSummary();
    const pendingRecords = result.summary.reduce((sum, item) => sum + item.record_count, 0);
    $("#pendingSummaryCount").textContent = pendingRecords;
    $("#pendingStatsNote").textContent = `统计更新时间：${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date())}`;
  } catch (error) {
    toast(error.message, "error");
  } finally {
    refreshButton.disabled = false;
  }
}

function openPrint(id) {
  window.open(`/pending_records/print?id=${encodeURIComponent(id)}`, "_blank", "noopener");
}

function openQuantityAddition(record) {
  state.workflowRecordId = record.id;
  $("#quantityRecordNumber").textContent = record.record_no;
  $("#quantityAdditionForm").reset();
  $("#supplementCaseCount").value = "0";
  $("#supplementStripCount").value = "0";
  $("#quantityModalError").classList.add("hidden");
  $("#quantityModal").classList.remove("hidden");
  window.setTimeout(() => $("#supplementCaseCount").focus(), 0);
}

function closeQuantityAddition() {
  state.workflowRecordId = null;
  $("#quantityModal").classList.add("hidden");
  $("#quantityAdditionForm").reset();
}

async function submitQuantityAddition(event) {
  event.preventDefault();
  if (!state.workflowRecordId) return;
  const payload = {
    case_count: $("#supplementCaseCount").value,
    strip_count: $("#supplementStripCount").value,
    note: $("#supplementNote").value.trim(),
  };
  const errorBox = $("#quantityModalError");
  if (!(Number(payload.case_count) || Number(payload.strip_count))) {
    errorBox.textContent = "补充件数和条数不能同时为 0";
    errorBox.classList.remove("hidden");
    return;
  }
  const button = $("#confirmQuantityAddition");
  button.disabled = true;
  errorBox.classList.add("hidden");
  try {
    await api(`${API_BASE}/records/${state.workflowRecordId}/quantity-additions`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    closeQuantityAddition();
    toast("补充数量已保存");
    await loadRecords();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove("hidden");
  } finally {
    button.disabled = false;
  }
}

function openDispositionEntry(record) {
  state.workflowRecordId = record.id;
  const remaining = record.remaining_quantity || { case_count: record.case_count, strip_count: record.strip_count };
  $("#dispositionRecordNumber").textContent = record.record_no;
  $("#dispositionRemaining").textContent = quantityText(remaining);
  $("#dispositionEntryForm").reset();
  $("#processedCaseCount").value = "0";
  $("#processedStripCount").value = "0";
  $("#processedCaseCount").max = String(remaining.case_count);
  $("#processedStripCount").max = String(remaining.strip_count);
  const history = $("#existingDispositionHistory");
  const entries = record.disposition_entries || [];
  history.classList.toggle("hidden", entries.length === 0);
  history.innerHTML = entries.length ? `
    <h4>已有处理记录</h4>
    ${entries.map((entry, index) => `<p>第 ${index + 1} 次：处理 ${escapeHtml(quantityText(entry))}；${escapeHtml(entry.disposition)}（${escapeHtml(entry.disposer)}）</p>`).join("")}` : "";
  $("#dispositionModalError").classList.add("hidden");
  $("#dispositionModal").classList.remove("hidden");
  window.setTimeout(() => $("#processedCaseCount").focus(), 0);
}

function closeDispositionEntry() {
  state.workflowRecordId = null;
  $("#dispositionModal").classList.add("hidden");
  $("#dispositionEntryForm").reset();
}

async function submitDispositionEntry(event) {
  event.preventDefault();
  if (!state.workflowRecordId) return;
  const payload = {
    case_count: $("#processedCaseCount").value,
    strip_count: $("#processedStripCount").value,
    disposition: $("#dispositionText").value.trim(),
    disposer: $("#dispositionPerson").value.trim(),
  };
  const errorBox = $("#dispositionModalError");
  if (!(Number(payload.case_count) || Number(payload.strip_count))) {
    errorBox.textContent = "处理件数和条数不能同时为 0";
    errorBox.classList.remove("hidden");
    return;
  }
  if (!payload.disposition || !payload.disposer) {
    errorBox.textContent = "请填写处置情况和处置人";
    errorBox.classList.remove("hidden");
    return;
  }
  const button = $("#confirmDispositionEntry");
  button.disabled = true;
  errorBox.classList.add("hidden");
  try {
    await api(`${API_BASE}/records/${state.workflowRecordId}/dispositions`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    closeDispositionEntry();
    toast("处理记录已保存");
    await loadRecords();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove("hidden");
  } finally {
    button.disabled = false;
  }
}

function openDelete(record) {
  state.deleteId = record.id;
  $("#deleteRecordNumber").textContent = record.record_no;
  $("#deletePassword").value = "";
  $("#deleteError").textContent = "";
  $("#deleteError").classList.add("hidden");
  $("#deleteModal").classList.remove("hidden");
  window.setTimeout(() => $("#deletePassword").focus(), 0);
}

function closeDelete() {
  state.deleteId = null;
  $("#deleteModal").classList.add("hidden");
  $("#deleteForm").reset();
}

async function deleteRecord(event) {
  event.preventDefault();
  if (!state.deleteId) return;
  const password = $("#deletePassword").value;
  const errorBox = $("#deleteError");
  if (!password) {
    errorBox.textContent = "请输入删除密码";
    errorBox.classList.remove("hidden");
    return;
  }
  const button = $("#confirmDelete");
  button.disabled = true;
  errorBox.classList.add("hidden");
  try {
    const result = await api(`${API_BASE}/records/${state.deleteId}`, {
      method: "DELETE",
      body: JSON.stringify({ password }),
    });
    closeDelete();
    toast(result.message || "记录已删除");
    await loadRecords();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove("hidden");
    $("#deletePassword").select();
  } finally {
    button.disabled = false;
  }
}

function bindEvents() {
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
  $("#recordDate").addEventListener("change", updateNumberPreview);
  $("#recordForm").addEventListener("submit", saveRecord);
  $("#resetForm").addEventListener("click", () => resetForm());
  $("#cancelEdit").addEventListener("click", () => resetForm());
  [$("#newRecordTop"), $("#newRecordLedger")].forEach((button) => button.addEventListener("click", () => {
    resetForm({ preserveDate: false });
    switchTab("entry");
  }));

  let filterTimer;
  const runFilter = () => {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => loadRecords(), 180);
  };
  $("#searchInput").addEventListener("input", runFilter);
  [$("#dateFrom"), $("#dateTo"), $("#statusFilter"), $("#shiftFilter")].forEach((input) => input.addEventListener("change", runFilter));
  $("#clearFilters").addEventListener("click", () => {
    $("#searchInput").value = "";
    $("#dateFrom").value = "";
    $("#dateTo").value = "";
    $("#statusFilter").value = "";
    $("#shiftFilter").value = "";
    loadRecords();
  });
  $("#recordRows").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const record = state.records.find((item) => item.id === Number(button.dataset.id));
    if (!record) return;
    if (button.dataset.action === "edit") fillForm(record);
    if (button.dataset.action === "add-quantity") openQuantityAddition(record);
    if (button.dataset.action === "add-disposition") openDispositionEntry(record);
    if (button.dataset.action === "print") openPrint(record.id);
    if (button.dataset.action === "delete") openDelete(record);
  });
  $("#printSaved").addEventListener("click", () => {
    if (state.savedId) openPrint(state.savedId);
  });
  $("#finishSaved").addEventListener("click", () => {
    $("#successModal").classList.add("hidden");
    resetForm({ preserveDate: false });
  });
  $("#deleteForm").addEventListener("submit", deleteRecord);
  $("#quantityAdditionForm").addEventListener("submit", submitQuantityAddition);
  $("#dispositionEntryForm").addEventListener("submit", submitDispositionEntry);
  $("#refreshPendingSummary").addEventListener("click", loadPendingSummary);
  $("#cancelQuantityAddition").addEventListener("click", closeQuantityAddition);
  $("#cancelDispositionEntry").addEventListener("click", closeDispositionEntry);
  $("#cancelDelete").addEventListener("click", closeDelete);
  $("#quantityModal").addEventListener("click", (event) => {
    if (event.target === $("#quantityModal")) closeQuantityAddition();
  });
  $("#dispositionModal").addEventListener("click", (event) => {
    if (event.target === $("#dispositionModal")) closeDispositionEntry();
  });
  $("#deleteModal").addEventListener("click", (event) => {
    if (event.target === $("#deleteModal")) closeDelete();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("#quantityModal").classList.contains("hidden")) closeQuantityAddition();
    if (!$("#dispositionModal").classList.contains("hidden")) closeDispositionEntry();
    if (!$("#deleteModal").classList.contains("hidden")) closeDelete();
  });
}

async function initialise() {
  const today = localDateString();
  $("#recordDate").value = today;
  $("#todayLabel").textContent = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date());
  bindEvents();
  try {
    const config = await api(`${API_BASE}/config`);
    state.config = config;
    renderConfig();
    await Promise.all([updateNumberPreview(), loadRecords(false)]);
    if (window.location.hash === "#pending-summary") switchTab("pending-summary");
    if (window.location.hash === "#ledger") switchTab("ledger");
  } catch (error) {
    toast(`系统初始化失败：${error.message}`, "error");
  }
}

document.addEventListener("DOMContentLoaded", initialise);
