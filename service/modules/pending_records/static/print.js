"use strict";

const paperSizes = {
  "a5": { page: "210mm 148mm", className: "size-a5" },
  "150x100": { page: "150mm 100mm", className: "size-150x100" },
  "200x100": { page: "200mm 100mm", className: "size-200x100" },
};

let currentRecord = null;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function formatQuantity(record) {
  const parts = [];
  if (record.case_count) parts.push(`${record.case_count} 件`);
  if (record.strip_count) parts.push(`${record.strip_count} 条`);
  return parts.join("　") || "0 件　0 条";
}

function formatDateTime(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(parsed).replaceAll("/", "-");
}

function createLabel(record) {
  const fragment = $("#labelTemplate").content.cloneNode(true);
  const sheet = $(".label-sheet", fragment);
  const dispositionEntries = record.disposition_entries || [];
  const dispositionText = dispositionEntries.map((entry, index) => {
    const handled = formatQuantity(entry);
    return `第${index + 1}次：处理${handled}，${entry.disposition}（${entry.disposer}）`;
  }).join("；");
  const totalQuantity = record.total_quantity || record;
  const values = {
    record_no: record.record_no,
    record_date: record.record_date,
    shift: record.shift || "未设置",
    product: record.product,
    machines: record.machines.join("、"),
    quantity: formatQuantity(totalQuantity),
    custodian: record.custodian,
    disposition: dispositionText,
    disposer: dispositionEntries.length ? dispositionEntries[dispositionEntries.length - 1].disposer : "",
    created_at: formatDateTime(record.created_at),
  };
  Object.entries(values).forEach(([field, value]) => {
    $(`[data-field="${field}"]`, fragment).textContent = value;
  });
  $('[data-field="shift_watermark"]', fragment).textContent = (record.shift || "").replace("班", "");
  const reasons = $('[data-field="reasons"]', fragment);
  record.reasons.forEach((reason) => {
    const item = document.createElement("span");
    item.className = "reason-item";
    item.textContent = reason.detail ? `${reason.type}：${reason.detail}` : reason.type;
    reasons.appendChild(item);
  });
  return sheet;
}

function renderCopies() {
  if (!currentRecord) return;
  const count = Math.max(1, Math.min(20, Number($("#copyCount").value) || 1));
  $("#copyCount").value = String(count);
  const container = $("#printPages");
  container.innerHTML = "";
  for (let index = 0; index < count; index += 1) container.appendChild(createLabel(currentRecord));
  applyPaperSize();
}

function applyPaperSize() {
  const size = paperSizes[$("#paperSize").value] || paperSizes.a5;
  $("#pageSizeStyle").textContent = `@page { size: ${size.page}; margin: 0; }`;
  $$(".label-sheet").forEach((sheet) => {
    Object.values(paperSizes).forEach((paper) => sheet.classList.remove(paper.className));
    sheet.classList.add(size.className);
  });
}

async function initialise() {
  $("#backButton").addEventListener("click", () => {
    if (window.opener) window.close();
    else window.location.href = "/pending_records/";
  });
  $("#printButton").addEventListener("click", () => window.print());
  $("#paperSize").addEventListener("change", applyPaperSize);
  $("#copyCount").addEventListener("change", renderCopies);

  const recordId = new URLSearchParams(window.location.search).get("id");
  if (!recordId || !/^\d+$/.test(recordId)) {
    showError("缺少要打印的记录编号，请从记录台账重新点击“打印”。");
    return;
  }
  try {
    const response = await fetch(`/pending_records/api/records/${recordId}`, { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || "记录读取失败");
    currentRecord = result.record;
    document.title = `打印 ${currentRecord.record_no}`;
    $("#toolbarNumber").textContent = `${currentRecord.record_no} · A5 横向 · 真实尺寸铺满`;
    renderCopies();
    $("#loadingState").classList.add("hidden");
    $("#printPages").classList.remove("hidden");
  } catch (error) {
    showError(error.message);
  }
}

function showError(message) {
  $("#loadingState").className = "error-state";
  $("#loadingState").textContent = message;
}

document.addEventListener("DOMContentLoaded", initialise);
