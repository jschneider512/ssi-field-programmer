/* SSI Field Programmer - Web Serial client
 * MPG protocol ported from ssi_mpg/protocol.py (verified against the
 * decompiled vendor app + live hardware). Stripped field-tech build:
 * MPG only, no printing, on-screen record via QR + copyable text.
 */
"use strict";

const $ = (id) => document.getElementById(id);

const BAUD = 57600;
const VID_FILTER = { usbVendorId: 0x04d8 };   // Microchip MCP2221

const EOI_INTERVALS = ["1", "5", "10", "15", "30", "60"];
const EOI_PULSE_WIDTHS = ["50", "100", "250", "500", "1000", "2000", "5000", "10000"];
const FORM_A_WIDTHS = ["25", "50", "100", "200", "500", "1000"];

// fw -> unsupported features (MainWindow.IsFeatureSupported)
const FW_UNSUPPORTED = {
  "2.14": ["eoi", "eoipw", "energy", "odometer"], "2.15": ["eoi", "eoipw", "energy", "odometer"],
  "2.19": ["eoi", "eoipw", "energy", "odometer"],
  "2.51": ["filter", "reset_time"], "2.52": ["filter", "reset_time"],
  "2.53": ["filter", "reset_time"],
  "3.05": ["filter", "reset_time"], "3.06": ["filter", "reset_time"],
  "3.07": ["filter", "reset_time"],
};

let port = null;        // Web Serial port or demo device
let reader = null;      // active read loop controller
let rxBuffer = "";      // decoded response accumulator
let demo = false;
let device = null;      // {fw, version, settings, identity}
let formDirty = false;
let form = {};

// ------------------------------------------------------------- helpers

function toast(msg, bad) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("bad", !!bad);
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 2800);
}

function groupFours(s) {
  s = String(s).replace(/[\s:]/g, "");
  return s.replace(/(.{4})/g, "$1 ").trim();
}

function unsupported() {
  return FW_UNSUPPORTED[device?.version] || [];
}
function supports(f) { return !unsupported().includes(f); }

// ------------------------------------------------------------- serial
async function openSerial() {
  if (!("serial" in navigator)) throw new Error(
    "Web Serial not supported - use Chrome/Edge (Android: Chrome 121+)");
  port = await navigator.serial.requestPort({ filters: [VID_FILTER] });
  await port.open({ baudRate: BAUD, dataBits: 8, stopBits: 1, parity: "none",
                    bufferSize: 4096 });
  await port.setSignals({ dataTerminalReady: true, requestToSend: true });
  rxBuffer = "";
  pumpReads();
}

async function pumpReads() {
  reader = port.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rxBuffer += new TextDecoder().decode(value);
    }
  } catch (e) { /* cancelled or device gone */ }
  finally {
    try { reader.releaseLock(); } catch (e) {}
    reader = null;
  }
}

async function writeLine(text) {
  const writer = port.writable.getWriter();
  await writer.write(new TextEncoder().encode(text + "\r"));
  writer.releaseLock();
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Write a command, collect the reply until a 50 ms quiet window.
   Mirrors MPGLink.transact (quiet-window framing). */
async function transact(command, timeoutMs = 1500) {
  rxBuffer = "";
  await writeLine(command);
  const deadline = performance.now() + timeoutMs;
  let sawData = false, lastData = 0;
  while (performance.now() < deadline) {
    const now = performance.now();
    if (rxBuffer.length) {
      if (!sawData) { sawData = true; }
      lastData = now;
      if (now - lastData < 50) { await sleep(15); continue; }
      if (now - lastData >= 50) break;
    }
    await sleep(10);
  }
  return cleanResponse(rxBuffer);
}

/* reply post-processing (vendor MPGSerialRead) */
function cleanResponse(text) {
  text = text.replace(/-+\r/g, "-").replace(/-+$/g, "-");
  return text.trim().replace(/^-+/, "").replace(/\r+$/, "").trim();
}

/* send + retry until the reply contains `expect` (10x / 500 ms, vendor) */
async function validated(command, expect, tries = 10) {
  let last = "";
  for (let i = 0; i < tries; i++) {
    last = await transact(command);
    if (last.includes(expect)) return last;
    if (i < tries - 1) await sleep(500);
  }
  throw new Error(`command ${command}: reply ${JSON.stringify(last)} ` +
                  `never contained ${JSON.stringify(expect)}`);
}

async function closeSerial() {
  try {
    if (reader) { await reader.cancel(); }
    if (port && port.close) await port.close();
  } catch (e) {}
  port = null;
  if (demo) demo = false;
}

// ------------------------------------------------------------- protocol
function parseFw(resp) {
  const m = (resp || "").match(/(?:SSI\s+)?(MPG|WPG)\S*\s+V([\d.\-]+)/);
  return m ? { family: m[1], text: m[0], version: m[2].replace("-", ".") } : null;
}

function parseDump(dump) {
  const v = {};
  for (const line of dump.split(/\r?\n/)) {
    if (line.includes(":")) {
      const i = line.indexOf(":");
      v[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (line.includes("Interval Disabled")) v["Interval Every"] = "Disabled";
  }
  const s = {
    multiplier: parseInt(v["Multiplier"]) || 1,
    pulse_value: parseInt(v["Pulse Value"]) || 10,
    output_mode: (v["Output Mode"] || "Normal").includes("Signed") ? "Signed" : "Normal",
    output_form: (v["Output Form"] || "C").startsWith("A") ? "A" : "C",
    form_a_width: (v["Output Form"] || "").match(/(\d+)\s*ms/)?.[1] || "200",
    eoi_interval: null, eoi_pulse_width: null,
    energy_adjustment: null, reset_time: null,
  };
  const ei = v["Interval Every"] ?? v["EOI Every"];
  if (ei !== undefined) s.eoi_interval = ei.replace("min.", "").trim();
  const ep = v["End of Interval"];
  if (ep !== undefined) s.eoi_pulse_width = ep.includes("Disabled") ? null : parseInt(ep);
  const ea = v["Energy Adj."];
  if (ea !== undefined) s.energy_adjustment = ea.includes("Enabled") ? "Enabled" : "Disabled";
  const rt = v["Reset Time"];
  if (rt !== undefined) s.reset_time = parseInt(rt);
  return s;
}

async function readIdentity() {
  if (!device.version.startsWith("3.")) return null;
  const t = async (cmd, quiet) => {
    await writeLine("+++");                    // toggle pass-through
    await sleep(350);
    const r = await transact(cmd, 2500);
    return r;
  };
  try {
    // enter pass-through: +++ until a command is acknowledged
    await writeLine("+++");
    await sleep(400);
    transactNoExpect("+++");                   // settle either state
    await sleep(300);
    const info = await transact("info", 2500);
    const m = info.match(/eui=x?\s*([0-9A-Fa-f\s]{17,22})/);
    const eui = m ? m[1].replace(/\s+/g, "").slice(0, 16).toUpperCase() : null;
    const se = await transact("se", 2500);
    const m2 = se.match(/ingest:\s*([0-9A-Fa-f]{8,40})/);
    const ic = m2 ? m2[1].toUpperCase() : null;
    const ver = await transact("version", 2500);
    const mv = ver.match(/Version:\s*([\d.]+)/)?.[1] || null;
    await writeLine("+++");                    // exit pass-through
    await sleep(300);
    return { eui, install_code: ic, module_version: mv };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// fire-and-forget variant used while syncing +++ state
function transactNoExpect(cmd) { writeLine(cmd); }

// ------------------------------------------------------------- demo sim
/* Minimal in-page MPG simulator so the page works without hardware
   (training) and so this app is testable on any machine. */
function makeDemoPort() {
  const st = {
    multiplier: 1004, pulse_value: 1004, output_mode: "Normal",
    output_form: "C", form_a_width: "200", eoi_interval: "15",
    eoi_pulse_width: 1000, energy_adjustment: "Enabled", reset_time: 120,
  };
  function dump() {
    return [
      `Multiplier: ${st.multiplier}`,
      `Pulse Value: ${st.pulse_value} Watt-hours`,
      `Output Mode: ${st.output_mode}`,
      st.output_form === "A" ? `Output Form: A ${st.form_a_width}ms`
                             : "Output Form: C",
      `Reset Time: ${st.reset_time} seconds`,
      `Interval Every: ${st.eoi_interval} min.`,
      `End of Interval: ${st.eoi_pulse_width}ms`,
      `Energy Adj.: ${st.energy_adjustment}`,
    ].join("\r") + "\r";
  }
  function handle(cmd) {
    if (cmd === "V") return "SSI MPG-3 V3-07\r";
    if (cmd === "R") return dump();
    if (cmd === "+++") return "";
    const m = cmd.match(/^([MPSTCWFEAI])(\d+)$/);
    if (!m) return "Error\r";
    const n = parseInt(m[2]);
    switch (m[1]) {
      case "M": st.multiplier = n; break;
      case "P": st.pulse_value = n; break;
      case "S": st.output_mode = n ? "Signed" : "Normal"; break;
      case "C": st.output_form = n ? "C" : "A"; break;
      case "W": st.form_a_width = FORM_A_WIDTHS[n]; break;
      case "F": break;
      case "I": st.eoi_interval = n === 0 ? "Disabled" : EOI_INTERVALS[n - 1]; break;
      case "E": st.eoi_pulse_width = n === 0 ? 0 : EOI_PULSE_WIDTHS[n - 1]; break;
      case "A": st.energy_adjustment = n ? "Enabled" : "Disabled"; break;
      case "T": st.reset_time = n; break;
    }
    return dump();
  }
  return {
    demo: true,
    async write(data) {
      const text = new TextDecoder().decode(data);
      let reply = "";
      for (const line of text.split("\r")) {
        if (line.trim()) reply += handle(line.trim());
      }
      if (reply) queueMicrotask(() => { rxBuffer += reply; });
    },
    async close() {},
    setSignals() {},
  };
}

// ------------------------------------------------------------- flow
function setPill(state, text) {
  const p = $("statusPill");
  p.className = "pill " + state;
  p.textContent = text;
}

async function connect(demoMode) {
  try {
    demo = !!demoMode;
    if (!demo) await openSerial(); else port = makeDemoPort();
    const resp = await transact("V");
    const fw = parseFw(resp);
    if (!fw) throw new Error(`no MPG/WPG identity in reply: ${JSON.stringify(resp)}`);
    device = { fw: fw.text, version: fw.version, family: fw.family };
    const settings = parseDump(await validated("R", "Multiplier"));
    device.settings = settings;
    device.identity = await readIdentity();

    $("connectCard").classList.add("hidden");
    $("idCard").classList.remove("hidden");
    $("setCard").classList.remove("hidden");
    $("btnProgram").classList.remove("hidden");
    $("fwVal").textContent = fw.text;
    loadForm(settings);
    applySupport();
    renderChips();
    if (device.identity?.eui) {
      $("euiVal").textContent = groupFours(device.identity.eui);
    } else $("kvEui").classList.add("hidden");
    if (device.identity?.install_code) {
      $("icVal").textContent = groupFours(device.identity.install_code);
    } else $("kvIc").classList.add("hidden");
    if (!device.identity || device.identity.error)
      $("modNote")?.classList.remove("hidden");
    setPill("connected", "CONNECTED");
    toast(demo ? "Demo device connected" : "Device connected");
  } catch (e) {
    await closeSerial();
    setPill("waiting", "NOT CONNECTED");
    toast(String(e.message || e), true);
  }
}

function loadForm(s) {
  form = { ...s };
  formDirty = false;
  $("f_multiplier").value = s.multiplier;
  $("f_pulse_value").value = s.pulse_value;
  if (s.reset_time != null) $("f_reset_time").value = s.reset_time;
}

function renderChips() {
  const sup = (f) => !unsupported().includes(f);
  chipRow("c_output_mode", ["Normal", "Signed"], form.output_mode,
          v => { form.output_mode = v; formDirty = true; renderChips(); });
  chipRow("c_output_form", ["A", "C"], form.output_form,
          v => { form.output_form = v; formDirty = true; renderChips(); });
  chipRow("c_form_a_width", FORM_A_WIDTHS, form.form_a_width,
          v => { form.form_a_width = v; formDirty = true; renderChips(); });
  chipRow("c_eoi_interval", ["Disabled", ...EOI_INTERVALS],
          String(form.eoi_interval),
          v => { form.eoi_interval = v; formDirty = true; renderChips(); });
  chipRow("c_eoi_pulse_width", ["Disabled", ...EOI_PULSE_WIDTHS],
          form.eoi_pulse_width === null ? "Disabled" : String(form.eoi_pulse_width),
          v => { form.eoi_pulse_width = v === "Disabled" ? null : parseInt(v);
                 formDirty = true; renderChips(); });
  chipRow("c_energy_adjustment", ["Enabled", "Disabled"],
          form.energy_adjustment,
          v => { form.energy_adjustment = v; formDirty = true; renderChips(); });

  $("grpWidth").classList.toggle("hidden", form.output_form !== "A");
  $("grpEoi").classList.toggle("hidden", !sup("eoi"));
  $("grpEoiW").classList.toggle("hidden",
    !sup("eoi") || form.eoi_interval === "Disabled");
  $("grpEnergy").classList.toggle("hidden", !sup("energy"));
  $("grpReset").classList.toggle("hidden", !sup("reset_time"));
}

function chipRow(id, values, current, onpick) {
  const el = $(id);
  el.innerHTML = "";
  values.forEach(v => {
    const b = document.createElement("button");
    b.textContent = v === "Disabled" ? "Off" : v;
    b.classList.toggle("sel", String(current) === String(v));
    b.onclick = () => onpick(v);
    el.appendChild(b);
  });
}

function applySupport() {
  const sup = (f) => !unsupported().includes(f);
  $("grpEoi").classList.toggle("hidden", !sup("eoi"));
  $("grpEoiW").classList.toggle("hidden", !sup("eoi"));
  $("grpEnergy").classList.toggle("hidden", !sup("energy"));
  $("grpReset").classList.toggle("hidden", !sup("reset_time"));
}

// ------------------------------------------------------------- program
function buildSettings() {
  const mult = parseInt($("f_multiplier").value);
  const pulse = parseInt($("f_pulse_value").value);
  if (!(mult >= 1 && mult <= 999999)) throw new Error("multiplier 1-999999");
  if (!(pulse >= 1 && pulse <= 999999)) throw new Error("pulse value 1-999999");
  const s = { multiplier: mult, pulse_value: pulse,
              output_mode: form.output_mode, output_form: form.output_form,
              form_a_width: form.output_form === "A" ? form.form_a_width : null,
              eoi_interval: sup("eoi") ? form.eoi_interval : null,
              eoi_pulse_width: null, energy_adjustment: null, reset_time: null };
  if (sup("eoi")) {
    s.eoi_pulse_width =
      form.eoi_interval === "Disabled" ? 0 :
      form.eoi_pulse_width == null ? 0 : form.eoi_pulse_width;
  }
  if (sup("energy")) s.energy_adjustment = form.energy_adjustment;
  if (sup("reset_time") && $("f_reset_time").value) {
    const rt = parseInt($("f_reset_time").value);
    if (!(rt >= 60 && rt <= 300)) throw new Error("reset time 60-300");
    s.reset_time = rt;
  }
  return s;
}

async function program() {
  let wanted;
  try { wanted = buildSettings(); }
  catch (e) { toast(e.message, true); return; }

  setPill("programming", "PROGRAMMING...");
  $("busyOverlay").classList.remove("hidden");
  $("resultCard").classList.add("hidden");
  clearResultBg();
  let diffs = [], actual = null, err = null;
  const t0 = performance.now();
  try {
    actual = await programDevice(wanted, m => {
      $("busyText").textContent = m;
    });
    diffs = verify(wanted, actual);
  } catch (e) {
    err = String(e.message || e);
  }
  $("busyOverlay").classList.add("hidden");
  logRun(wanted, diffs, err);
  showResult(wanted, actual, diffs, err, performance.now() - t0);
}

/* command sequence mirrors MPGBuildSerialCommandList + retry wrapper */
async function programDevice(w, progress) {
  const step = async (label, cmd, expect) => {
    progress(label);
    await validated(cmd, expect);
  };
  await step("multiplier", `M${w.multiplier}`, `Multiplier: ${w.multiplier}`);
  await step("pulse value", `P${w.pulse_value}`,
             `Pulse Value: ${w.pulse_value} Watt-hours`);
  if (w.reset_time != null)
    await step("reset time", `T${w.reset_time}`, `Reset Time: ${w.reset_time} seconds`);
  await step("output mode", w.output_mode === "Normal" ? "S0" : "S1",
             `Output Mode: ${w.output_mode}`);
  await step("output form", w.output_form === "A" ? "C0" : "C1",
             `Output Form: ${w.output_form}`);
  if (w.output_form === "A") {
    const idx = FORM_A_WIDTHS.indexOf(w.form_a_width);
    await step("form A width", `W${idx}`, `Output Form: A ${w.form_a_width}ms`);
  }
  if (w.eoi_interval != null) {
    if (w.eoi_interval === "Disabled") {
      await step("EOI interval", "I0", "Interval Disabled");
    } else {
      const idx = EOI_INTERVALS.indexOf(String(w.eoi_interval)) + 1;
      await step("EOI interval", `I${idx}`,
                 `Interval Every: ${w.eoi_interval} min.`);
    }
    if (w.eoi_pulse_width != null) {
      if (w.eoi_pulse_width === 0) {
        await step("EOI pulse width", "E0", "End of Interval: Disabled");
      } else {
        const idx = EOI_PULSE_WIDTHS.indexOf(String(w.eoi_pulse_width)) + 1;
        await step("EOI pulse width", `E${idx}`,
                   `End of Interval: ${w.eoi_pulse_width}ms`);
      }
    }
  }
  if (w.energy_adjustment != null) {
    await step("energy adjustment",
               w.energy_adjustment === "Disabled" ? "A0" : "A1",
               `Energy Adj.: ${w.energy_adjustment}`);
  }
  progress("verify (read back)");
  return parseDump(await validated("R", "Multiplier"));
}

function verify(w, a) {
  const diffs = [];
  const cmp = (name, x, y) => {
    if (y == null) return;
    if (String(x) !== String(y))
      diffs.push(`${name}: wanted ${y}, device reports ${x}`);
  };
  cmp("multiplier", a.multiplier, w.multiplier);
  cmp("pulse_value", a.pulse_value, w.pulse_value);
  cmp("output_mode", a.output_mode, w.output_mode);
  cmp("output_form", a.output_form, w.output_form);
  if (w.output_form === "A") cmp("form_a_width", a.form_a_width, w.form_a_width);
  if (w.eoi_interval != null) cmp("eoi_interval", a.eoi_interval, w.eoi_interval);
  if (w.eoi_pulse_width != null)
    cmp("eoi_pulse_width", a.eoi_pulse_width ?? 0, w.eoi_pulse_width);
  if (w.energy_adjustment != null)
    cmp("energy_adjustment", a.energy_adjustment, w.energy_adjustment);
  if (w.reset_time != null) cmp("reset_time", a.reset_time, w.reset_time);
  return diffs;
}

// ------------------------------------------------------------- record/QR
function recordText(w, a) {
  const L = [];
  L.push(`SSI MPG FW ${device.version}`);
  L.push(`Pulse Multiplier: ${a.multiplier}`);
  L.push(`Pulse Value: ${a.pulse_value} Wh`);
  L.push(`Mode: ${a.output_mode}`);
  L.push(a.output_form === "A" ? `Form: A ${a.form_a_width} ms` : "Form: C");
  if (a.eoi_interval != null)
    L.push(`EOI Interval: ${a.eoi_interval === "Disabled" ? "Off" : a.eoi_interval + " min"}`);
  if (a.eoi_pulse_width != null && w.eoi_pulse_width != null)
    L.push(`EOI Pulse Width: ${a.eoi_pulse_width} ms`);
  if (a.energy_adjustment)
    L.push(`Energy Adjustment: ${a.energy_adjustment}`);
  if (a.reset_time) L.push(`Reset Time: ${a.reset_time} s`);
  if (device.identity?.eui)
    L.push(`EUI: ${groupFours(device.identity.eui)}`);
  if (device.identity?.install_code)
    L.push(`Install Code: ${groupFours(device.identity.install_code)}`);
  return L.join("\n");
}

function showResult(w, a, diffs, err, ms) {
  const card = $("resultCard");
  const ok = !err && diffs.length === 0;
  card.classList.remove("hidden");
  card.classList.toggle("pass", ok);
  card.classList.toggle("fail", !ok);
  $("resultTitle").textContent = ok ? "PASS" : "FAIL";
  document.body.classList.toggle("bg-pass", ok);
  document.body.classList.toggle("bg-fail", !ok);
  const body = $("resultBody");
  if (ok) {
    body.innerHTML =
      `Multiplier: <b>${a.multiplier}</b><br>` +
      `Pulse: <b>${a.pulse_value} Wh</b><br>` +
      `${a.output_mode} / form ${a.output_form}` +
      (a.output_form === "A" ? ` ${a.form_a_width}ms` : "") +
      (a.eoi_interval ? `<br>EOI: ${a.eoi_interval}` : "") +
      (a.energy_adjustment ? `<br>Energy: ${a.energy_adjustment}` : "") +
      `<br><i>verified in ${(ms / 1000).toFixed(1)}s</i>`;
  } else {
    body.innerHTML = (err ? `<div class="diff">${err}</div>` : "") +
      (diffs || []).map(d => `<div class="diff">${d}</div>`).join("");
  }
  const text = ok ? recordText(w, a) : "";
  $("qrText").value = text;
  $("qrBox").innerHTML = "";
  if (ok && text) {
    try {
      const qr = qrcode(0, "M");            // auto type, EC level M
      qr.addData(text);
      qr.make();
      $("qrBox").innerHTML = qr.createSvgTag({ cellSize: 3, margin: 2 });
    } catch (e) { /* record too long - text box still works */ }
  }
}

function clearResultBg() {
  document.body.classList.remove("bg-pass", "bg-fail");
}

function nextDevice() {
  $("resultCard").classList.add("hidden");
  clearResultBg();
  formDirty = false;
}

// ------------------------------------------------------------- log
function logRun(wanted, diffs, err) {
  const key = "ssi_field_log";
  const runs = JSON.parse(localStorage.getItem(key) || "[]");
  runs.push({
    ts: new Date().toISOString(),
    fw: device?.version || "",
    eui: device?.identity?.eui || "",
    install_code: device?.identity?.install_code || "",
    result: !err && diffs.length === 0 ? "PASS" : "FAIL",
    multiplier: wanted.multiplier, pulse_value: wanted.pulse_value,
    output_mode: wanted.output_mode, output_form: wanted.output_form,
    form_a_width: wanted.form_a_width,
    eoi_interval: wanted.eoi_interval,
    eoi_pulse_width: wanted.eoi_pulse_width,
    energy_adjustment: wanted.energy_adjustment,
    reset_time: wanted.reset_time,
  });
  localStorage.setItem(key, JSON.stringify(runs.slice(-500)));
  renderLog();
}

function renderLog() {
  const runs = JSON.parse(localStorage.getItem("ssi_field_log") || "[]");
  $("logList").innerHTML = runs.length
    ? runs.slice().reverse().map(r =>
        `<div><span class="r-${r.result.toLowerCase()}">${r.result}</span> ` +
        `${r.ts.slice(0, 16).replace("T", " ")} m=${r.multiplier} ` +
        `p=${r.pulse_value}</div>`).join("")
    : "<div class='hint'>no runs yet</div>";
}

function downloadCsv() {
  const runs = JSON.parse(localStorage.getItem("ssi_field_log") || "[]");
  if (!runs.length) { toast("no runs logged", true); return; }
  const cols = Object.keys(runs[0]);
  const csv = [cols.join(",")].concat(
    runs.map(r => cols.map(c => JSON.stringify(r[c] ?? "")).join(","))).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "ssi_field_log.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------- wiring
(async function init() {
  if (!("serial" in navigator)) {
    $("serialUnsupported").classList.remove("hidden");
    $("btnConnect").disabled = true;
  }
  renderLog();
})();

$("btnConnect").onclick = () => connect(false);
$("lnkDemo").onclick = (e) => { e.preventDefault(); connect(true); };
$("btnProgram").onclick = program;
$("btnNext").onclick = nextDevice;
$("btnReread").onclick = async () => {
  try {
    const s = parseDump(await validated("R", "Multiplier"));
    device.settings = s;
    loadForm(s);
    renderChips();
    toast("Values re-read");
  } catch (e) { toast(String(e.message || e), true); }
};
$("btnCopy").onclick = () => {
  const t = $("qrText").value;
  if (!t) return;
  navigator.clipboard?.writeText(t)
    .then(() => toast("Record copied"))
    .catch(() => toast("copy failed - select the text manually", true));
};
$("btnLogDl").onclick = downloadCsv;
$("btnLogClear").onclick = () => {
  localStorage.removeItem("ssi_field_log");
  renderLog();
  toast("Log cleared");
};

["f_multiplier", "f_pulse_value", "f_reset_time"].forEach(id => {
  $(id).addEventListener("input", () => { formDirty = true; });
});
