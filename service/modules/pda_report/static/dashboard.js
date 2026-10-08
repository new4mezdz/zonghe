"use strict";

const byId = (id) => document.getElementById(id);
const form = byId("filters");
const storageKey = "warehouse-api-key";
let apiKey = "";
try { apiKey = sessionStorage.getItem(storageKey) || ""; } catch (_) { /* Session storage can be unavailable. */ }
byId("api-key").value = apiKey;

let page = 1;
let report = null;
let requestVersion = 0;
let activeController = null;
let loading = false;
let stale = false;
let exporting = false;
let lastUpdated = "";
let appliedFilters = new URLSearchParams();
let displayedFilters = new URLSearchParams();
const formatNumber = (value) => Number(value).toLocaleString("zh-CN");
const beijingDateTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

function today() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({type, value}) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function setToday() { byId("start-date").value = today(); byId("end-date").value = today(); }
function captureFilters() { appliedFilters = new URLSearchParams(new FormData(form)); page = 1; }
function message(text) { byId("message").textContent = text; byId("message").hidden = !text; }
function headers() { return apiKey ? {"X-API-Key": apiKey} : {}; }

function status(ok, text) {
  byId("indicator").className = `dot ${ok ? "ok" : "error"}`;
  byId("connection").textContent = text;
}

function updateControls() {
  byId("refresh").disabled = loading;
  byId("refresh").textContent = loading ? "正在刷新…" : "立即刷新";
  byId("previous").disabled = loading || stale || !report || report.page <= 1;
  byId("next").disabled = loading || stale || !report || report.page >= report.pages;
  byId("export").disabled = loading || stale || !report || exporting;
  byId("report-content").setAttribute("aria-busy", String(loading));
}

function cell(row, text, className = "") {
  const td = document.createElement("td"); td.textContent = text; td.className = className;
  row.appendChild(td); return td;
}

function showEmptyRows(text) {
  const tr = document.createElement("tr"); const td = cell(tr, text, "empty"); td.colSpan = 6;
  byId("rows").replaceChildren(tr);
}

function describeFilters(filters) {
  const start = filters.get("start_date"), end = filters.get("end_date");
  const dates = start && end ? (start === end ? start : `${start} 至 ${end}`) :
    start ? `${start} 起` : end ? `截至 ${end}` : "全部日期";
  const source = {reader: "读码器", pda: "PDA"}[filters.get("source")] || "全部来源";
  const operation = {inbound: "入库", return: "返回"}[filters.get("operation")] || "全部操作";
  const keyword = filters.get("keyword");
  return `当前报表范围：${dates} · ${source} · ${operation}${keyword ? ` · 条码包含“${keyword}”` : ""}`;
}

function render(data) {
  report = data; page = data.page;
  for (const key of ["total", "inbound", "returned", "reader", "pda"]) byId(key).textContent = formatNumber(data.stats[key]);
  byId("unique-barcodes").textContent = formatNumber(data.stats.unique_barcodes);
  byId("devices").textContent = `${formatNumber(data.stats.devices)} 台扫码设备`;
  for (const source of ["reader", "pda"]) {
    byId(`${source}-bar`).max = Math.max(1, data.stats.total);
    byId(`${source}-bar`).value = data.stats[source];
  }
  byId("rows").replaceChildren();
  if (!data.items.length) showEmptyRows("当前筛选条件下暂无扫码记录");
  for (const item of data.items) {
    const tr = document.createElement("tr");
    cell(tr, item.local_scanned_at.slice(0, 19).replace("T", " "));
    cell(tr, item.barcode, "barcode");
    const operation = cell(tr, ""); const badge = document.createElement("span");
    badge.className = `badge ${item.operation === "return" ? "return" : ""}`;
    badge.textContent = item.operation === "return" ? "返回" : "入库"; operation.appendChild(badge);
    cell(tr, item.source === "reader" ? "读码器" : "PDA");
    cell(tr, item.device_id, "device-id");
    cell(tr, item.reader_host ? `${item.reader_host}${item.reader_port ? ":" + item.reader_port : ""}` : "—", "reader-address");
    byId("rows").appendChild(tr);
  }
  byId("page-info").textContent = `共 ${formatNumber(data.total)} 条 · 第 ${data.page} / ${data.pages} 页`;
  const trend = byId("trend"); trend.replaceChildren();
  if (!data.daily.length) {
    const empty = document.createElement("p"); empty.className = "empty";
    empty.textContent = "暂无趋势数据"; trend.appendChild(empty);
  }
  const max = Math.max(1, ...data.daily.map((day) => Math.max(day.inbound, day.returned)));
  for (const day of data.daily) {
    const column = document.createElement("div"); column.className = "trend-day";
    column.title = `${day.date}：入库 ${day.inbound}，返回 ${day.returned}`;
    const count = document.createElement("b"); count.textContent = day.total; column.appendChild(count);
    const bars = document.createElement("div"); bars.className = "trend-bars";
    for (const operation of ["inbound", "returned"]) {
      const bar = document.createElement("progress"); bar.max = max; bar.value = day[operation];
      bar.setAttribute("aria-label", `${day.date} ${operation === "inbound" ? "入库" : "返回"} ${day[operation]} 次`);
      bars.appendChild(bar);
    }
    column.appendChild(bars);
    const label = document.createElement("small"); label.textContent = day.date.slice(5);
    column.appendChild(label); trend.appendChild(column);
  }
}

async function readReportResponse(response) {
  if (response.status === 401) {
    byId("auth-panel").hidden = false;
    throw new Error("请输入正确的服务访问密钥。");
  }
  let data;
  try { data = await response.json(); }
  catch (_) { throw new Error(`服务响应无法读取（HTTP ${response.status}），请稍后重试。`); }
  if (!response.ok || !data.ok) throw new Error(data.error || "读取扫码记录失败。");
  return data;
}

async function refresh() {
  const version = ++requestVersion;
  if (activeController) activeController.abort();
  const controller = new AbortController(); activeController = controller; loading = true;
  const requestedFilters = new URLSearchParams(appliedFilters);
  const query = new URLSearchParams(requestedFilters);
  query.set("page", String(page)); query.set("page_size", "50");
  const timeout = setTimeout(() => controller.abort(), 15000);
  updateControls();
  try {
    const response = await fetch(`/api/report?${query}`, {headers: headers(), cache: "no-store", signal: controller.signal});
    if (version !== requestVersion) return;
    const data = await readReportResponse(response);
    if (version !== requestVersion) return;
    render(data); displayedFilters = requestedFilters; stale = false;
    lastUpdated = beijingDateTime.format(new Date());
    message(""); status(true, "服务已连接");
    byId("updated").textContent = `最近更新 ${lastUpdated}`;
    byId("scope-summary").textContent = describeFilters(displayedFilters);
    byId("report-state").hidden = false; byId("stale-label").hidden = true;
  } catch (error) {
    if (version !== requestVersion) return;
    stale = true;
    const detail = error.name === "AbortError" ? "连接服务超时。" : error.message || "连接服务失败。";
    message(`${detail} ${report ? "以下仍为上次成功读取的报表，筛选范围以“当前报表范围”为准。" : "尚未获取扫码报表。"} 每 10 秒自动重试，也可点击立即刷新。`);
    status(false, "连接异常");
    byId("updated").textContent = report ? `上次成功读取 ${lastUpdated}` : "尚未读取报表";
    byId("stale-label").hidden = !report;
    if (!report) showEmptyRows("暂时无法读取扫码记录，请检查连接或服务密钥");
  } finally {
    clearTimeout(timeout);
    if (version === requestVersion) { loading = false; activeController = null; updateControls(); }
  }
}

function applyAndRefresh() {
  const start = byId("start-date").value, end = byId("end-date").value;
  if (start && end && start > end) { message("开始日期不能晚于结束日期，请调整后查询。"); return; }
  captureFilters(); refresh();
}

form.addEventListener("submit", (event) => { event.preventDefault(); applyAndRefresh(); });
byId("today").addEventListener("click", () => { setToday(); applyAndRefresh(); });
byId("all-dates").addEventListener("click", () => {
  byId("start-date").value = ""; byId("end-date").value = ""; applyAndRefresh();
});
byId("refresh").addEventListener("click", () => refresh());
byId("previous").addEventListener("click", () => { if (report && report.page > 1) { page = report.page - 1; refresh(); } });
byId("next").addEventListener("click", () => { if (report && report.page < report.pages) { page = report.page + 1; refresh(); } });
byId("auth-form").addEventListener("submit", (event) => {
  event.preventDefault(); apiKey = byId("api-key").value.trim();
  try { sessionStorage.setItem(storageKey, apiKey); } catch (_) { /* Keep the key in memory for this page. */ }
  refresh();
});

byId("export").addEventListener("click", async () => {
  const button = byId("export"); exporting = true; button.textContent = "正在导出…"; updateControls();
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`/api/export.csv?${displayedFilters}`, {headers: headers(), cache: "no-store", signal: controller.signal});
    if (!response.ok) {
      if (response.status === 401) byId("auth-panel").hidden = false;
      let data = {};
      try { data = await response.json(); } catch (_) { /* A gateway may return plain text. */ }
      throw new Error(data.error || (response.status === 401 ? "请输入正确的服务访问密钥。" : `导出失败（HTTP ${response.status}）。`));
    }
    const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `扫码记录-${today()}.csv`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    if (!stale) message("");
  } catch (error) {
    const detail = error.name === "AbortError" ? "导出超时，请缩小日期范围后重试。" : error.message;
    message(`${detail}${stale ? " 当前仍显示上次成功读取的报表。" : ""}`);
  } finally { clearTimeout(timer); exporting = false; button.textContent = "导出 CSV"; updateControls(); }
});

setToday(); captureFilters(); refresh();
fetch("/api/health", {cache: "no-store"})
  .then((response) => response.json())
  .then((data) => { if (data.auth_required) byId("auth-panel").hidden = false; })
  .catch(() => { /* The report request displays connection errors. */ });
setInterval(() => { if (!document.hidden && !loading) refresh(); }, 10000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
