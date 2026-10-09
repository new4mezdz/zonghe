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
const readerForm = byId("reader-config-form");
const readerConfigKeys = ["host", "port", "framing", "encoding", "idle_ms", "fixed_length", "reconnect_seconds", "dedupe_seconds"];
let readerSnapshot = null;
let readerKnown = false;
let readerLoading = false;
let readerBusy = false;
let readerDirty = false;
let readerVersion = 0;
let readerController = null;
let readerSavedCount = null;
let readerReportTimer = null;
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
    message(""); status(true, "报表已更新");
    byId("updated").textContent = `最近更新 ${lastUpdated}`;
    byId("scope-summary").textContent = describeFilters(displayedFilters);
    byId("report-state").hidden = false; byId("stale-label").hidden = true;
  } catch (error) {
    if (version !== requestVersion) return;
    stale = true;
    const detail = error.name === "AbortError" ? "连接服务超时。" : error.message || "连接服务失败。";
    message(`${detail} ${report ? "以下仍为上次成功读取的报表，筛选范围以“当前报表范围”为准。" : "尚未获取扫码报表。"} 每 10 秒自动重试，也可点击立即刷新。`);
    status(false, "报表读取异常");
    byId("updated").textContent = report ? `上次成功读取 ${lastUpdated}` : "尚未读取报表";
    byId("stale-label").hidden = !report;
    if (!report) showEmptyRows("暂时无法读取扫码记录，请检查连接或服务密钥");
  } finally {
    clearTimeout(timeout);
    if (version === requestVersion) { loading = false; activeController = null; updateControls(); }
  }
}

function readerFeedback(text, error = false) {
  byId("reader-feedback").textContent = text;
  byId("reader-feedback").hidden = !text;
  byId("reader-feedback").className = `reader-feedback${error ? " is-error" : ""}`;
}

function updateReaderControls() {
  const running = Boolean(readerSnapshot && readerSnapshot.status.running);
  const enabled = Boolean(readerSnapshot && readerSnapshot.config.enabled);
  const unavailable = !readerKnown || readerBusy;
  byId("reader-start").disabled = unavailable || running || readerDirty;
  byId("reader-stop").disabled = unavailable || !(running || enabled);
  byId("reader-refresh").disabled = readerBusy || readerLoading;
  byId("reader-refresh").textContent = readerLoading ? "读取状态…" : "刷新状态";
  byId("reader-config-fields").disabled = unavailable || running;
  byId("reader-save").disabled = unavailable || running || !readerDirty;
  byId("reader-reset").disabled = unavailable || running || !readerDirty;
  byId("reader-dirty").hidden = !readerDirty;
  byId("reader-config-note").textContent = !readerKnown ? "当前采集状态未知，读取成功后才能修改配置。" :
    running ? "正在采集，请先停止采集再修改配置。" :
    readerDirty ? "配置尚未保存。请保存或恢复后，再连接采集。" : "保存配置后点击“连接采集”。启用状态会保存，服务重启后自动恢复采集。";
  byId("reader-panel").setAttribute("aria-busy", String(readerBusy));
}

function fillReaderConfig(config) {
  for (const key of readerConfigKeys) readerForm.elements.namedItem(key).value = String(config[key]);
}

function queueReaderReportRefresh() {
  if (readerReportTimer !== null) return;
  readerReportTimer = setTimeout(() => {
    readerReportTimer = null;
    if (document.hidden) return;
    if (loading) { queueReaderReportRefresh(); return; }
    refresh();
  }, 1000);
}

function renderReader(data, replaceDraft = false) {
  const current = data.status, config = data.config;
  const names = {stopped: "已停止", connecting: "连接中", connected: "已连接", retrying: "正在重连", error: "采集异常"};
  if (!config || !current || !Object.hasOwn(names, current.state)) throw new Error("采集状态响应不完整，请刷新状态。");
  readerSnapshot = data; readerKnown = true;
  byId("reader-state").className = `reader-state ${current.state}`;
  byId("reader-state").textContent = names[current.state];
  byId("reader-endpoint").textContent = `${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`;
  byId("reader-status-message").textContent = current.message || names[current.state];
  byId("reader-enabled-note").textContent = config.enabled ?
    "自动采集已启用，关闭网页仍会继续；综合服务重启后自动恢复采集。" :
    "自动采集未启用。点击“连接采集”后会保存启用状态；停止采集后将不再自动连接。";
  for (const [id, key] of [["reader-received", "received_count"], ["reader-saved", "saved_count"], ["reader-filtered", "filtered_count"], ["reader-rejected", "rejected_count"]]) {
    byId(id).textContent = formatNumber(current[key] || 0);
  }
  const pendingCount = Number(current.pending_count || 0), unsavedCount = Number(current.unsaved_count || 0);
  byId("reader-pending-note").hidden = pendingCount === 0 && unsavedCount === 0;
  byId("reader-pending-note").textContent = `待保存 ${formatNumber(pendingCount)} 条 · 未确认入库 ${formatNumber(unsavedCount)} 条。${unsavedCount ? "请核对最近异常与实际扫码记录，未确认的条码需要人工核对。" : "请等待保存完成。"}`;
  const scanTime = current.last_scan_at ? new Date(current.last_scan_at) : null;
  byId("reader-last-time").textContent = scanTime && !Number.isNaN(scanTime.getTime()) ? beijingDateTime.format(scanTime) : current.last_scan_at || "尚未收到条码";
  const barcode = current.last_barcode || "";
  byId("reader-last-barcode").textContent = barcode ? barcode.slice(0, 500) + (barcode.length > 500 ? "…（仅显示前 500 个字符）" : "") : "—";
  byId("reader-last-error").textContent = current.last_error ? `最近异常：${current.last_error}` : "";
  byId("reader-last-error").hidden = !current.last_error;
  if (replaceDraft || (!readerDirty && !readerForm.contains(document.activeElement))) {
    fillReaderConfig(config); readerDirty = false;
  }
  if (readerSavedCount !== null && readerSavedCount !== current.saved_count) queueReaderReportRefresh();
  readerSavedCount = current.saved_count;
  updateReaderControls();
}

function readerUnknown(error) {
  readerKnown = false;
  byId("reader-state").className = "reader-state unknown";
  byId("reader-state").textContent = "状态未知";
  const detail = error.name === "AbortError" ? "读取采集状态超时。" : error.message || "无法读取采集状态。";
  byId("reader-status-message").textContent = `${detail} 无法确认是否正在采集${readerSnapshot ? "；下方保留上次读取的信息" : ""}。`;
  updateReaderControls();
}

async function readerResponse(response) {
  if (response.status === 401) {
    byId("auth-panel").hidden = false;
    throw new Error("请输入正确的服务访问密钥。");
  }
  let data;
  try { data = await response.json(); }
  catch (_) { throw new Error(`无法读取采集服务响应（HTTP ${response.status}）。`); }
  if (!response.ok || !data.ok) throw new Error(data.error || `采集操作失败（HTTP ${response.status}）。`);
  return data;
}

async function refreshReader(force = false) {
  if (readerBusy || (readerLoading && !force)) return;
  const version = ++readerVersion;
  if (readerController) readerController.abort();
  const controller = new AbortController(); readerController = controller; readerLoading = true;
  const timer = setTimeout(() => controller.abort(), 10000);
  updateReaderControls();
  try {
    const response = await fetch("/api/reader/status", {headers: headers(), cache: "no-store", signal: controller.signal});
    if (version !== readerVersion) return;
    const data = await readerResponse(response);
    if (version === readerVersion) renderReader(data);
  } catch (error) { if (version === readerVersion) readerUnknown(error); }
  finally {
    clearTimeout(timer);
    if (version === readerVersion) { readerLoading = false; readerController = null; updateReaderControls(); }
  }
}

async function mutateReader(action, payload, successMessage) {
  if (!readerKnown || readerBusy) return;
  ++readerVersion;
  if (readerController) readerController.abort();
  readerController = null; readerLoading = false; readerBusy = true;
  readerFeedback("正在提交，请稍候…"); updateReaderControls();
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/reader/${action}`, {
      method: "POST", headers: {...headers(), "Content-Type": "application/json"},
      body: JSON.stringify(payload), signal: controller.signal,
    });
    renderReader(await readerResponse(response), action === "config");
    readerFeedback(successMessage);
  } catch (error) {
    const detail = error.name === "AbortError" ? "操作请求超时，请以重新读取的采集状态为准。" : error.message || "采集操作失败。";
    readerFeedback(detail, true); readerUnknown(new Error("正在重新确认采集状态"));
  } finally {
    clearTimeout(timer); readerBusy = false; updateReaderControls(); refreshReader(true);
  }
}

readerForm.addEventListener("input", () => { readerDirty = true; updateReaderControls(); });
readerForm.addEventListener("change", () => { readerDirty = true; updateReaderControls(); });
readerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!readerKnown || readerBusy || readerSnapshot.status.running || !readerForm.reportValidity()) return;
  const payload = {};
  for (const key of readerConfigKeys) {
    const value = readerForm.elements.namedItem(key).value.trim();
    payload[key] = ["host", "framing", "encoding"].includes(key) ? value : Number(value);
  }
  if (payload.framing === "fixed" && payload.fixed_length < 1) {
    readerFeedback("固定字节长度模式需要填写大于 0 的固定长度。", true); return;
  }
  mutateReader("config", payload, "连接配置已保存。点击“连接采集”开始接收条码。");
});
byId("reader-reset").addEventListener("click", () => {
  if (!readerKnown || readerBusy || !readerSnapshot || readerSnapshot.status.running) return;
  fillReaderConfig(readerSnapshot.config); readerDirty = false; readerFeedback(""); updateReaderControls();
});
byId("reader-start").addEventListener("click", () => {
  if (!readerDirty && readerSnapshot && !readerSnapshot.status.running) mutateReader("start", {}, "自动采集已启用，当前连接状态见上方提示。");
});
byId("reader-stop").addEventListener("click", () => mutateReader("stop", {}, "已请求停止采集，请以采集状态和保存结果为准。"));
byId("reader-refresh").addEventListener("click", () => refreshReader(true));

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
byId("refresh").addEventListener("click", () => { refresh(); refreshReader(true); });
byId("previous").addEventListener("click", () => { if (report && report.page > 1) { page = report.page - 1; refresh(); } });
byId("next").addEventListener("click", () => { if (report && report.page < report.pages) { page = report.page + 1; refresh(); } });
byId("auth-form").addEventListener("submit", (event) => {
  event.preventDefault(); apiKey = byId("api-key").value.trim();
  try { sessionStorage.setItem(storageKey, apiKey); } catch (_) { /* Keep the key in memory for this page. */ }
  refresh(); refreshReader(true);
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

setToday(); captureFilters(); refresh(); refreshReader();
fetch("/api/health", {cache: "no-store"})
  .then((response) => response.json())
  .then((data) => { if (data.auth_required) byId("auth-panel").hidden = false; })
  .catch(() => { /* The report request displays connection errors. */ });
setInterval(() => { if (!document.hidden && !loading) refresh(); }, 10000);
setInterval(() => { if (!document.hidden) refreshReader(); }, 4000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { refresh(); refreshReader(true); } });
