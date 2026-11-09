const subjectEl = document.querySelector("#prompt-subject");
const styleEl = document.querySelector("#prompt-style");
const promptEls = [subjectEl, styleEl];

function fieldText(el) {
  return (el.innerText ?? "").replace(/\u00a0/g, " ").trim();
}

function setField(el, text) {
  const value = String(text ?? "");
  el.textContent = value;
  if (!value.trim()) el.replaceChildren();
}

function subjectText() {
  return fieldText(subjectEl);
}

function styleText() {
  return fieldText(styleEl);
}

function combinePrompt(subject = subjectText(), style = styleText()) {
  return [subject, style].map((part) => String(part ?? "").trim()).filter(Boolean).join("\n\n");
}

function setPrompts({ subject = "", style = "" } = {}) {
  setField(subjectEl, subject);
  setField(styleEl, style);
}

function descriptionOf(image) {
  const subject = String(image?.subject ?? "").trim();
  const style = String(image?.style ?? "").trim();
  return { subject, style, ready: Boolean(subject && style) };
}
const subjectBox = document.querySelector("#describe-subject");
const styleBox = document.querySelector("#describe-style");
const describeBoxes = { subject: subjectBox, style: styleBox };
const dragLiftLayer = document.querySelector("#drag-lift-layer");
const samplerBtn = document.querySelector("#sampler-btn");
const samplerLabel = document.querySelector("#sampler-label");
const samplerMenuEl = document.querySelector("#sampler-menu");
const generateBtn = document.querySelector("#generate-btn");
const statusEl = document.querySelector("#status");
const errorEl = document.querySelector("#error");
const statusPill = document.querySelector("#status-pill");
const slotsEl = document.querySelector("#slots");
const stripPlayEl = document.querySelector("#strip-play");
const ratioMenuEl = document.querySelector("#ratio-menu");
const imageMenuEl = document.querySelector("#image-menu");
const ENLARGE_SHORT_SIDE = 1024;
const ENLARGE_STRENGTH = 0.3;

function paintIcons(root = document) {
  window.lucide?.createIcons({
    root,
    attrs: { "stroke-width": "2" },
  });
}

function lucideIcon(name) {
  const icon = document.createElement("i");
  icon.setAttribute("data-lucide", name);
  return icon;
}

paintIcons();

function kleinLog(source, message, data) {
  console.debug("klein", source, message, data ?? "");
  fetch("/api/debug-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, message, data: data ?? null, at: Date.now() }),
  }).catch(() => {});
}

let config = {
  ratios: [
    { id: "1:1", width: 128, height: 128 },
    { id: "16:9", width: 256, height: 128 },
    { id: "3:4", width: 128, height: 192 },
    { id: "9:16", width: 128, height: 256 },
  ],
  minSlots: 1,
  maxSlots: 1,
  mlx: false,
};
let images = [];
let selected = null;
let busy = false;
const describing = { subject: false, style: false };
const describeGen = { subject: 0, style: 0 };
const describeAbort = { subject: null, style: null };

function isDescribing(part) {
  return part ? Boolean(describing[part]) : describing.subject || describing.style;
}
const RANDOM_SAMPLER = "random";
let currentSampler = 16;
let slotId = 0;
let slots = [];
let models = {
  klein: {
    key: "klein",
    title: "FLUX.2 Klein 4B",
    id: "flux_2_klein_4b_q8p.ckpt",
    loaded: false,
    action: "idle",
    percent: 0,
    message: "",
  },
  memoryGb: 0,
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

function showError(message) {
  errorEl.hidden = !message;
  errorEl.textContent = message || "";
}

function setPill(text, kind) {
  statusPill.dataset.label = text;
  statusPill.setAttribute("aria-label", text);
  statusPill.className = `live-dot ${kind ?? ""}`.trim();
}

function applyModels(payload) {
  if (!payload) return;
  if (payload.klein) Object.assign(models.klein, payload.klein);
  if (payload.memoryGb != null) models.memoryGb = payload.memoryGb;
  renderDescribe();
}

function modelStateLabel(model) {
  if (model.action === "load") return `loading ${model.percent}%`;
  if (model.action === "unload") return `unloading ${model.percent}%`;
  return model.loaded ? "loaded" : "unloaded";
}

function renderDescribe() {
  subjectBox.dataset.state = describing.subject ? "describing" : subjectText() ? "ready" : "idle";
  styleBox.dataset.state = describing.style ? "describing" : styleText() ? "ready" : "idle";
}

async function unloadModel(which) {
  showError("");
  try {
    const response = await fetch("/api/models/unload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: which }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unload failed.");
    applyModels(payload);
  } catch (error) {
    showError(error.message);
  }
}

function watchModels() {
  const source = new EventSource("/api/models/watch");
  source.onmessage = (event) => {
    try {
      applyModels(JSON.parse(event.data));
    } catch {
      // Ignore a truncated status frame.
    }
  };
}

function selectedSteps() {
  return Number(document.querySelector('input[name="steps"]:checked')?.value || 4);
}

function setSteps(steps) {
  const value = steps === 2 || steps === 4 ? String(steps) : "";
  if (!value) return;
  const input = document.querySelector(`input[name="steps"][value="${value}"]`);
  if (input) input.checked = true;
}

function samplerList() {
  return config.samplers ?? [];
}

function samplerMenuItems() {
  return [
    { id: RANDOM_SAMPLER, name: "Random", hint: "A different sampler each generate" },
    ...samplerList(),
  ];
}

function samplerById(id) {
  if (id == null || id === "") return null;
  const value = Number(id);
  if (!Number.isInteger(value)) return null;
  return samplerList().find((sampler) => sampler.id === value) ?? null;
}

function selectedSampler() {
  if (currentSampler === RANDOM_SAMPLER) return RANDOM_SAMPLER;
  return samplerById(currentSampler)?.id ?? config.defaultSampler ?? 16;
}

function resolveSampler() {
  const list = samplerList();
  if (currentSampler === RANDOM_SAMPLER) {
    if (!list.length) return config.defaultSampler ?? 16;
    return list[Math.floor(Math.random() * list.length)].id;
  }
  return samplerById(currentSampler)?.id ?? config.defaultSampler ?? 16;
}

function setSampler(id) {
  if (id === RANDOM_SAMPLER) {
    currentSampler = RANDOM_SAMPLER;
    samplerLabel.textContent = "Random";
    samplerBtn.setAttribute("aria-label", "Sampler Random");
    return;
  }
  const sampler = samplerById(id) ?? samplerById(config.defaultSampler) ?? samplerList()[0];
  if (!sampler) return;
  currentSampler = sampler.id;
  samplerLabel.textContent = sampler.name;
  samplerBtn.setAttribute("aria-label", `Sampler ${sampler.name}`);
}

function aspectFromImage(image) {
  const known = config.ratios.find((ratio) => ratio.id === image?.aspect);
  if (known) return known.id;
  const width = Number(image?.width);
  const height = Number(image?.height);
  if (!width || !height) return null;
  const target = width / height;
  let best = null;
  let bestDiff = Infinity;
  for (const ratio of config.ratios) {
    const parts = String(ratio.id).split(":");
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!w || !h) continue;
    const diff = Math.abs(w / h - target);
    if (diff < bestDiff) {
      best = ratio.id;
      bestDiff = diff;
    }
  }
  return bestDiff < 0.08 ? best : null;
}

function applyImageSettings(image) {
  setPrompts(descriptionOf(image));
  if (image.steps === 2 || image.steps === 4) setSteps(image.steps);
  if (samplerById(image.sampler)) setSampler(image.sampler);
  const aspect = aspectFromImage(image);
  if (!aspect) return;
  for (const slot of slots) {
    if (isPending(slot)) slot.aspect = aspect;
  }
  renderSlots();
}

function ratioFor(id) {
  return config.ratios.find((ratio) => ratio.id === id) ?? config.ratios[0];
}

function isPending(slot) {
  return !slot?.image;
}

function lastAspect() {
  return slots[0]?.aspect || "1:1";
}

function addSlot(aspect = lastAspect()) {
  const ratio = ratioFor(aspect);
  if (slots[0]) {
    slots[0].aspect = ratio.id;
    slots[0].image = null;
    slots[0].status = "idle";
    slots[0].error = "";
    renderSlots();
    return slots[0];
  }
  slots.push({
    id: ++slotId,
    aspect: ratio.id,
    image: null,
    status: "idle",
    error: "",
  });
  renderSlots();
  return slots[0];
}

async function finishGeneratedSlot(slot, generated) {
  slot.image = null;
  slot.status = "idle";
  slot.error = "";
  renderSlots();
  try {
    await loadImages();
  } catch (error) {
    showError(error.message);
  }
  if (generated?.filename) {
    const image = images.find((item) => item.filename === generated.filename) ?? generated;
    selectImage(image, { restore: false });
  }
}

function cycleAspect(slot) {
  if (!isPending(slot)) return;
  const ids = config.ratios.map((ratio) => ratio.id);
  const index = Math.max(0, ids.indexOf(slot.aspect));
  slot.aspect = ids[(index + 1) % ids.length];
  slot.image = null;
  slot.status = "idle";
  slot.error = "";
  renderSlots();
}

function setSlotAspect(slot, aspect) {
  if (!isPending(slot)) return;
  slot.aspect = ratioFor(aspect).id;
  slot.image = null;
  slot.status = "idle";
  slot.error = "";
  closeRatioMenu();
  renderSlots();
}

function aspectIconStyle(aspect) {
  const parts = String(aspect).split(":");
  const w = Number(parts[0]) || 1;
  const h = Number(parts[1]) || 1;
  const maxDim = Math.max(w, h);
  return `width:${Math.round((w / maxDim) * 20)}px;height:${Math.round((h / maxDim) * 20)}px`;
}

let ratioMenuAnchor = null;

function closeRatioMenu() {
  ratioMenuEl.hidden = true;
  ratioMenuEl.replaceChildren();
  ratioMenuEl.style.maxHeight = "";
  ratioMenuEl.style.overflowY = "";
  ratioMenuAnchor = null;
}

function closeImageMenu() {
  imageMenuEl.hidden = true;
  imageMenuEl.replaceChildren();
  imageMenuEl.style.maxHeight = "";
  imageMenuEl.style.overflowY = "";
}

function sizeForShortSide(width, height, shortSide = ENLARGE_SHORT_SIDE) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const scale = shortSide / Math.min(w, h);
  const snap = (value) => Math.max(64, Math.round(value / 64) * 64);
  return { width: snap(w * scale), height: snap(h * scale) };
}

async function blobToPng(blob) {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return canvasToPngBlob(canvas);
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode image."));
    }, "image/png");
  });
}

async function copyCanvasImage(image) {
  const response = await fetch(image.url);
  if (!response.ok) throw new Error("Could not read image.");
  const png = await blobToPng(await response.blob());
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

function downloadCanvasImage(image) {
  const link = document.createElement("a");
  link.href = image.url;
  link.download = image.filename || "image.png";
  document.body.append(link);
  link.click();
  link.remove();
}

function enlargeCanvasImage(image, nodeId) {
  const known = images.find((item) => item.filename === image.filename) ?? image;
  const sized = sizeForShortSide(known.width, known.height);
  const parts = descriptionOf(known);
  const job = {
    id: `job-${++jobSeq}-${Date.now()}`,
    slotId: `enlarge-${jobSeq}`,
    aspect: known.aspect || `${sized.width}x${sized.height}`,
    width: sized.width,
    height: sized.height,
    scale: 2,
    subject: parts.subject,
    style: parts.style,
    steps: selectedSteps(),
    sampler: resolveSampler(),
    source: known.filename,
    image: known.filename,
    strength: ENLARGE_STRENGTH,
    mode: "enlarge",
    beside: nodeId || known.filename,
  };
  queueTotal += 1;
  generateQueue.push(job);
  kleinLog("app", "enlarge-start", { id: job.id, image: job.image, beside: job.beside });
  window.dispatchEvent(
    new CustomEvent("klein:generate-start", {
      detail: {
        beside: job.beside,
        slots: [
          {
            id: job.id,
            aspect: job.aspect,
            width: job.width,
            height: job.height,
            scale: 2,
            url: known.url,
          },
        ],
      },
    }),
  );
  pumpGenerateQueue();
}

function openImageMenu(detail) {
  const multi = detail?.mode === "multi" && Array.isArray(detail.nodeIds) && detail.nodeIds.length > 1;
  const image = detail?.image;
  if (!multi && !image?.url) return;
  closeRatioMenu();
  closeSamplerMenu();
  imageMenuEl.replaceChildren();
  const actions = multi
    ? [
        { id: "grid", label: "Grid", icon: "layout-grid" },
        { id: "delete", label: "Delete", icon: "trash-2" },
      ]
    : [
        { id: "copy", label: "Copy", icon: "copy" },
        { id: "download", label: "Download", icon: "download" },
        { id: "enlarge", label: "Enlarge", icon: "maximize-2" },
      ];
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.append(lucideIcon(action.icon), document.createTextNode(action.label));
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      closeImageMenu();
      try {
        if (action.id === "copy") await copyCanvasImage(image);
        else if (action.id === "download") downloadCanvasImage(image);
        else if (action.id === "enlarge") enlargeCanvasImage(image, detail.nodeId);
        else if (action.id === "grid") {
          window.dispatchEvent(
            new CustomEvent("klein:selection-grid", { detail: { nodeIds: detail.nodeIds } }),
          );
        } else if (action.id === "delete") {
          window.dispatchEvent(
            new CustomEvent("klein:selection-delete", { detail: { nodeIds: detail.nodeIds } }),
          );
        }
      } catch (error) {
        showError(error.message);
      }
    });
    imageMenuEl.append(button);
  }
  imageMenuEl.hidden = false;
  placeOnScreen(imageMenuEl, detail.x, detail.y);
  paintIcons(imageMenuEl);
  boardPeek?.latch();
}

function placeOnScreen(el, x, y, margin = 8) {
  el.style.maxHeight = "none";
  el.style.overflowY = "";
  el.style.left = "0px";
  el.style.top = "0px";
  const { width, height } = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxW = Math.max(0, vw - margin * 2);
  const maxH = Math.max(0, vh - margin * 2);
  const boxW = Math.min(width, maxW);
  const boxH = Math.min(height, maxH);
  let left = x + boxW > vw - margin ? x - boxW : x;
  let top = y + boxH > vh - margin ? y - boxH : y;
  left = Math.min(Math.max(left, margin), vw - margin - boxW);
  top = Math.min(Math.max(top, margin), vh - margin - boxH);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  if (height > maxH) {
    el.style.maxHeight = `${Math.round(maxH)}px`;
    el.style.overflowY = "auto";
  }
}

function openRatioMenu(event, slot) {
  if (!isPending(slot)) return;
  event.preventDefault();
  event.stopPropagation();
  ratioMenuEl.replaceChildren();
  for (const ratio of config.ratios) {
    const option = document.createElement("button");
    option.type = "button";
    option.setAttribute("aria-current", ratio.id === slot.aspect ? "true" : "false");
    option.innerHTML = `<span>${ratio.id}</span><span class="ratio-icon" style="${aspectIconStyle(ratio.id)}"></span>`;
    option.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      setSlotAspect(slot, ratio.id);
    });
    ratioMenuEl.append(option);
  }
  closeSamplerMenu();
  ratioMenuEl.hidden = false;
  ratioMenuAnchor = { x: event.clientX, y: event.clientY };
  placeOnScreen(ratioMenuEl, ratioMenuAnchor.x, ratioMenuAnchor.y);
  boardPeek?.latch();
}

function closeSamplerMenu() {
  samplerMenuEl.hidden = true;
  samplerMenuEl.replaceChildren();
  samplerMenuEl.style.maxHeight = "";
  samplerMenuEl.style.overflowY = "";
  samplerBtn.setAttribute("aria-expanded", "false");
}

function openSamplerMenu() {
  closeRatioMenu();
  if (!samplerMenuEl.hidden) {
    closeSamplerMenu();
    return;
  }
  samplerMenuEl.replaceChildren();
  for (const sampler of samplerMenuItems()) {
    const option = document.createElement("button");
    option.type = "button";
    option.setAttribute("role", "option");
    option.setAttribute("aria-current", sampler.id === selectedSampler() ? "true" : "false");
    if (sampler.id === RANDOM_SAMPLER) option.classList.add("sampler-option-random");
    option.innerHTML = `<span class="sampler-option-name">${sampler.name}</span><span class="sampler-option-hint">${sampler.hint}</span>`;
    option.addEventListener("click", (event) => {
      event.stopPropagation();
      setSampler(sampler.id);
      closeSamplerMenu();
    });
    samplerMenuEl.append(option);
  }
  samplerMenuEl.hidden = false;
  samplerBtn.setAttribute("aria-expanded", "true");
  const rect = samplerBtn.getBoundingClientRect();
  placeOnScreen(samplerMenuEl, rect.right, rect.bottom + 4);
  boardPeek?.latch();
}

function selectImage(image, { restore = false } = {}) {
  selected = image;
  if (restore && !busy) applyImageSettings(image);
  updateActionButtons();
}

function renderSlotCard(slot) {
  const parts = String(slot.aspect || "1:1").split(":");
  const card = document.createElement("article");
  card.className = "slot";
  const ratio = `${Number(parts[0]) || 1} / ${Number(parts[1]) || 1}`;
  card.style.aspectRatio = ratio;

  const frame = document.createElement("div");
  frame.className = `frame ${slot.status === "error" ? "error" : "idle"}`;
  frame.style.aspectRatio = ratio;
  frame.setAttribute("aria-label", slot.aspect);
  frame.title = `${slot.aspect} · click to cycle · right-click for menu`;

  frame.addEventListener("click", (event) => {
    if (event.button !== 0) return;
    cycleAspect(slot);
  });
  frame.addEventListener("contextmenu", (event) => openRatioMenu(event, slot));

  const label = document.createElement("span");
  label.className = "aspect-label";
  label.textContent = slot.aspect;
  frame.append(label);

  card.append(frame);
  return card;
}

function renderSlots() {
  generateBtn.disabled = false;
  slotsEl.replaceChildren();
  const slot = slots[0];
  if (slot) slotsEl.append(renderSlotCard(slot));
}

let imagesFetchSeq = 0;
async function loadImages() {
  const seq = ++imagesFetchSeq;
  const response = await fetch("/api/images");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load images.");
  if (seq !== imagesFetchSeq) {
    kleinLog("app", "images-stale", { seq, latest: imagesFetchSeq, count: data.images?.length ?? 0 });
    return data;
  }
  const previous = selected?.filename;
  images = data.images;
  if (previous) {
    selected = images.find((image) => image.filename === previous) ?? null;
  } else if (images[0]) {
    selected = images[0];
  }
  kleinLog("app", "images", { seq, count: images.length, last: images.at(-1)?.filename || null });
  window.dispatchEvent(new CustomEvent("klein:images", { detail: { images } }));
  updateActionButtons();
  return data;
}

function watchLibrary() {
  const source = new EventSource("/api/watch");
  source.onmessage = () => {
    loadImages().catch((error) => showError(error.message));
  };
  source.onerror = () => {
    // EventSource reconnects on its own.
  };
}

async function checkHealth() {
  const response = await fetch("/api/health");
  const data = await response.json();
  if (!data.ok) {
    setPill("missing", "bad");
    showError(data.error || "Draw Things Klein is not available.");
    return data;
  }
  if (data.models) applyModels(data.models);
  setPill(busy ? "working" : "ready", busy ? "busy" : "ok");
  return data;
}

function updateActionButtons() {
  generateBtn.disabled = false;
  renderDescribe();
}

function setBusy(isBusy, statusText = "") {
  busy = isBusy;
  statusEl.textContent = statusText;
  setPill(isBusy ? "working" : "ready", isBusy ? "busy" : "ok");
  updateActionButtons();
  renderSlots();
}

const DESCRIBE_MAX_EDGE = 256;
const DESCRIBE_JPEG_QUALITY = 0.4;
const DESCRIBE_MAX_BYTES = 20_000;

async function blobFromSource(source) {
  if (source instanceof Blob) return source;
  if (source?.file instanceof Blob) return source.file;
  const url = source?.url;
  if (!url) throw new Error("Drop an image onto the prompt to describe it.");
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not read dropped image.");
  return response.blob();
}

async function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not compress image."));
    }, "image/jpeg", quality);
  });
}

async function shrinkForDescribe(blob) {
  const bitmap = await createImageBitmap(blob);
  const maxEdge = Math.max(bitmap.width, bitmap.height);
  let edge = Math.min(DESCRIBE_MAX_EDGE, maxEdge);
  let quality = DESCRIBE_JPEG_QUALITY;
  let out = blob;

  try {
    const draw = async (size, q) => {
      const scale = size / maxEdge;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Could not compress image.");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvasToJpegBlob(canvas, q);
    };

    out = await draw(edge, quality);
    while (out.size > DESCRIBE_MAX_BYTES && (quality > 0.28 || edge > 160)) {
      if (quality > 0.28) quality = Math.max(0.28, quality - 0.08);
      else edge = Math.max(160, Math.round(edge * 0.75));
      out = await draw(edge, quality);
    }
  } finally {
    bitmap.close?.();
  }
  return out;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function rememberDescription(filename, patch) {
  if (!filename || !patch) return;
  const subject = String(patch.subject ?? "").trim();
  const style = String(patch.style ?? "").trim();
  if (!subject && !style) return;
  images = images.map((image) =>
    image.filename === filename
      ? {
          ...image,
          ...(subject ? { subject } : {}),
          ...(style ? { style } : {}),
        }
      : image,
  );
  if (selected?.filename === filename) {
    selected = {
      ...selected,
      ...(subject ? { subject } : {}),
      ...(style ? { style } : {}),
    };
  }
  window.dispatchEvent(new CustomEvent("klein:images", { detail: { images } }));
}

function storedPartFor(source, part) {
  if (!source?.filename) return "";
  const known = images.find((item) => item.filename === source.filename) ?? source;
  return String(part === "style" ? known.style ?? "" : known.subject ?? "").trim();
}

async function describeWithFal(imageDataUrl, filename, part, signal) {
  const task = part === "style" ? "style" : "subject";
  const describeResponse = await fetch("/api/describe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image: imageDataUrl,
      part: task,
      ...(filename ? { filename } : {}),
    }),
    signal,
  });
  const described = await describeResponse.json();
  if (!describeResponse.ok) throw new Error(described.error || "Describe failed.");
  const text = String(described[task] ?? "").trim();
  if (!text) throw new Error("Describe failed.");
  if (filename) rememberDescription(filename, { [task]: text });
  return text;
}

const mealObjectUrls = { subject: "", style: "" };

function releaseMealUrl(part) {
  if (!part) {
    releaseMealUrl("subject");
    releaseMealUrl("style");
    return;
  }
  if (mealObjectUrls[part]) {
    URL.revokeObjectURL(mealObjectUrls[part]);
    mealObjectUrls[part] = "";
  }
}

function partOfBox(box) {
  return box?.dataset?.part === "style" ? "style" : "subject";
}

function describeStatus(text) {
  if (busy) return;
  statusEl.textContent = text;
}

function mealSizeFromNatural(width, height, box = subjectBox) {
  const maxW = Math.max(80, (box?.clientWidth || 320) - 20);
  const scale = Math.min(1, maxW / Math.max(1, width));
  return { width: width * scale, height: height * scale };
}

function boxMeal(box) {
  return box?.querySelector(".describe-meal");
}

function setDragLift(detail) {
  if (!detail?.on) {
    dragLiftLayer.hidden = true;
    dragLiftLayer.replaceChildren();
    return;
  }
  const items = Array.isArray(detail.items) && detail.items.length
    ? detail.items
    : detail.url
      ? [detail]
      : [];
  if (!items.length) {
    dragLiftLayer.hidden = true;
    dragLiftLayer.replaceChildren();
    return;
  }
  dragLiftLayer.hidden = false;
  const existing = [...dragLiftLayer.querySelectorAll(".drag-lift")];
  while (existing.length > items.length) existing.pop().remove();
  items.forEach((item, index) => {
    let wrap = existing[index];
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "drag-lift";
      const img = document.createElement("img");
      img.className = "drag-lift-img";
      img.alt = "";
      wrap.append(img);
      dragLiftLayer.append(wrap);
    }
    const img = wrap.querySelector("img");
    if (item.url && img.getAttribute("src") !== item.url) img.src = item.url;
    wrap.classList.toggle("is-group", detail.mode === "group");
    wrap.style.left = `${Math.round(item.x || 0)}px`;
    wrap.style.top = `${Math.round(item.y || 0)}px`;
    wrap.style.width = `${Math.round(item.width || 0)}px`;
    wrap.style.height = `${Math.round(item.height || 0)}px`;
  });
}

function prepareEat(box, { width, height, force = false } = {}) {
  if (!box) return;
  const part = partOfBox(box);
  for (const [otherPart, other] of Object.entries(describeBoxes)) {
    if (other !== box && !describing[otherPart]) endEat(other, { keepMealUrl: true });
  }
  if (describing[part] && !force) return;
  const imgH = Math.max(80, Number(height) || 180);
  const imgW = Math.max(80, Number(width) || 180);
  box.classList.add("is-drop-target");
  box.classList.remove("is-eating", "is-swallowing", "is-waiting", "is-revealing");
  box.style.minHeight = `${Math.round(imgH + 50)}px`;
  box.style.setProperty("--eat-width", `${Math.round(imgW)}px`);
  box.style.setProperty("--eat-img-height", `${Math.round(imgH)}px`);
  const meal = boxMeal(box);
  if (meal) {
    meal.hidden = true;
    meal.removeAttribute("src");
  }
}

function beginEat(box, { url, width, height } = {}) {
  prepareEat(box, { width, height, force: true });
  if (!box) return;
  box.classList.add("is-eating");
  const meal = boxMeal(box);
  if (meal && url) {
    meal.hidden = false;
    meal.src = url;
  }
}

function endEat(box, { keepMealUrl = false, force = false } = {}) {
  if (!box) {
    if (!describing.subject || force) endEat(subjectBox, { keepMealUrl, force });
    if (!describing.style || force) endEat(styleBox, { keepMealUrl, force });
    return;
  }
  const part = partOfBox(box);
  if (describing[part] && !force) return;
  box.classList.remove("is-drop-target", "is-eating", "is-swallowing", "is-waiting", "is-revealing");
  box.style.minHeight = "";
  box.style.removeProperty("--eat-width");
  box.style.removeProperty("--eat-img-height");
  const meal = boxMeal(box);
  if (meal) {
    meal.removeAttribute("src");
    meal.hidden = true;
  }
  if (!keepMealUrl) releaseMealUrl(part);
}

function reduceDescribeMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function waitDescribe(ms) {
  if (reduceDescribeMotion()) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function settleWaiting(box, gen) {
  const part = partOfBox(box);
  if (!box || (gen != null && describeGen[part] !== gen)) return false;
  box.classList.remove("is-eating", "is-swallowing", "is-drop-target", "is-revealing");
  box.classList.add("is-waiting");
  const meal = boxMeal(box);
  if (meal?.src) meal.hidden = false;
  return true;
}

async function fadeWaiting(box, gen, part) {
  if (!box) return;
  if (gen != null && describeGen[part] !== gen) return;
  if (box.classList.contains("is-waiting") && !reduceDescribeMotion()) {
    box.classList.add("is-revealing");
    await waitDescribe(520);
    if (gen != null && describeGen[part] !== gen) return;
  }
  endEat(box, { force: true });
}

async function presentFileMeal(file, box, gen) {
  const part = partOfBox(box);
  releaseMealUrl(part);
  mealObjectUrls[part] = URL.createObjectURL(file);
  const size = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(mealSizeFromNatural(img.naturalWidth, img.naturalHeight, box));
    img.onerror = () => resolve({ width: 180, height: 180 });
    img.src = mealObjectUrls[part];
  });
  if (gen != null && describeGen[part] !== gen) return;
  beginEat(box, { url: mealObjectUrls[part], ...size });
}

function applyDescribedPart(part, text) {
  if (part === "style") setField(styleEl, text);
  else setField(subjectEl, text);
  renderDescribe();
}

async function describeFromSource(source, { alreadyEating = false, part = "subject" } = {}) {
  const task = part === "style" ? "style" : "subject";
  const box = describeBoxes[task];
  showError("");
  describeAbort[task]?.abort();
  const ac = new AbortController();
  describeAbort[task] = ac;
  const gen = ++describeGen[task];
  describing[task] = true;
  const status = box?.querySelector(".describe-status");
  if (status) status.textContent = "describing…";
  describeStatus(task === "style" ? "Describing style…" : "Describing subject…");
  renderDescribe();
  boardPeek?.latch();
  let revealed = false;
  try {
    if (!alreadyEating) {
      if (source?.file) await presentFileMeal(source.file, box, gen);
      else if (source?.url) beginEat(box, { url: source.url, width: source.width, height: source.height });
    }
    if (describeGen[task] !== gen) return null;
    settleWaiting(box, gen);
    const stored = storedPartFor(source, task);
    let text = stored;
    if (!text) {
      const blob = await blobFromSource(source);
      const small = await shrinkForDescribe(blob);
      if (describeGen[task] !== gen) return null;
      text = await describeWithFal(await blobToDataUrl(small), source?.filename, task, ac.signal);
    } else {
      await waitDescribe(450);
    }
    if (describeGen[task] !== gen) return null;
    describing[task] = false;
    applyDescribedPart(task, text);
    describeStatus("Description ready.");
    revealed = true;
    await fadeWaiting(box, gen, task);
    return text;
  } catch (error) {
    if (error?.name === "AbortError" || describeGen[task] !== gen) return null;
    showError(error.message);
    return null;
  } finally {
    if (describeGen[task] === gen) {
      describing[task] = false;
      if (describeAbort[task] === ac) describeAbort[task] = null;
      if (!revealed) await fadeWaiting(box, gen, task);
      renderDescribe();
    }
  }
}

function extensionForType(type) {
  if (type === "image/jpeg" || type === "image/jpg") return ".jpg";
  if (type === "image/webp") return ".webp";
  return ".png";
}

function namedImageFile(file, index) {
  const type = file.type || "image/png";
  if (!IMAGE_TYPES.has(type) && !/\.(png|jpe?g|webp)$/i.test(file.name || "")) {
    return null;
  }
  if (file.name && /\.(png|jpe?g|webp)$/i.test(file.name)) return file;
  return new File([file], `paste-${Date.now()}-${index}${extensionForType(type)}`, {
    type: type === "image/jpg" ? "image/jpeg" : type,
  });
}

function filesFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return [];
  const collected = [];
  const seen = new Set();

  const take = (file) => {
    if (!file || seen.has(file)) return;
    const named = namedImageFile(file, collected.length);
    if (!named) return;
    seen.add(file);
    collected.push(named);
  };

  if (dataTransfer.files) {
    for (const file of dataTransfer.files) take(file);
  }
  if (dataTransfer.items) {
    for (const item of dataTransfer.items) {
      if (item.kind === "file") take(item.getAsFile());
    }
  }
  return collected;
}

function hasImageFiles(dataTransfer) {
  if (!dataTransfer) return false;
  if (dataTransfer.files) {
    for (const file of dataTransfer.files) {
      if (IMAGE_TYPES.has(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name || "")) {
        return true;
      }
    }
  }
  if (dataTransfer.items) {
    for (const item of dataTransfer.items) {
      if (item.kind === "file" && (IMAGE_TYPES.has(item.type) || item.type.startsWith("image/"))) {
        return true;
      }
    }
    if ([...dataTransfer.types].includes("Files")) return true;
  }
  return false;
}

async function importFiles(fileList) {
  showError("");
  let last = null;
  for (const file of fileList) {
    const named = namedImageFile(file, 0);
    if (!named) continue;
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(named);
    });
    const response = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: named.name, data }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Import failed.");
    last = payload.image;
    selectImage(payload.image);
  }
  await loadImages();
  if (last) {
    const fresh = images.find((image) => image.filename === last.filename);
    if (fresh) selectImage(fresh);
  }
}

async function readSseEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((row) => row.startsWith("data: "));
      if (!line) continue;
      onEvent(JSON.parse(line.slice(6)));
    }
  }
}

let generateQueue = [];
let queueRunning = false;
let queueDone = 0;
let queueTotal = 0;
let jobSeq = 0;

function queueStatus(aspect, extra = "", verb = "Generating") {
  const current = Math.min(queueDone + 1, Math.max(queueTotal, 1));
  const more = generateQueue.length;
  const suffix = extra ? ` · ${extra}` : "";
  const waiting = more ? ` · ${more} queued` : "";
  return `${verb} ${current} / ${queueTotal} · ${aspect}${waiting}${suffix}`;
}

async function runGenerateJob(job) {
  let generated = null;
  setBusy(true, queueStatus(job.aspect, "", job.mode === "enlarge" ? "Enlarging" : "Generating"));
  const response = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: job.subject,
      style: job.style,
      steps: job.steps,
      sampler: job.sampler,
      aspect: job.aspect,
      source: job.source,
      ...(job.mode === "enlarge"
        ? {
            mode: "enlarge",
            image: job.image,
            strength: job.strength,
          }
        : {}),
    }),
  });
  if (response.status === 409) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    generateQueue.unshift(job);
    return false;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Generation failed.");
  }
  await readSseEvents(response, (event) => {
    if (event.type === "preview") {
      window.dispatchEvent(
        new CustomEvent("klein:generate-preview", {
          detail: { id: job.id, url: event.url },
        }),
      );
    } else if (event.type === "progress") {
      statusEl.textContent = queueStatus(
        job.aspect,
        `${event.step}/${event.total}`,
        job.mode === "enlarge" ? "Enlarging" : "Generating",
      );
    } else if (event.type === "status") {
      statusEl.textContent = event.message || statusEl.textContent;
    } else if (event.type === "model") {
      applyModels({
        klein: {
          ...models.klein,
          action: event.action ?? models.klein.action,
          percent: event.percent ?? models.klein.percent,
          message: event.message ?? models.klein.message,
          loaded: event.kleinLoaded ?? models.klein.loaded,
        },
        memoryGb: event.memoryGb ?? models.memoryGb,
      });
    } else if (event.type === "done") {
      generated = event.image;
    } else if (event.type === "error") {
      throw new Error(event.error || "Generation failed.");
    }
  });
  if (!generated?.filename) throw new Error("Generation ended without an image.");
  kleinLog("app", "generate-done", { id: job.id, filename: generated.filename, mode: job.mode || "generate" });
  window.dispatchEvent(
    new CustomEvent("klein:generate-done", {
      detail: { id: job.id, image: generated },
    }),
  );
  await finishGeneratedSlot(
    slots.find((slot) => slot.id === job.slotId) ?? {
      id: job.slotId,
      aspect: job.aspect,
      image: null,
      status: "idle",
      error: "",
    },
    generated,
  );
  return true;
}

async function pumpGenerateQueue() {
  if (queueRunning) return;
  queueRunning = true;
  setBusy(true, statusEl.textContent || "Generating…");
  let failed = 0;
  try {
    while (generateQueue.length) {
      const job = generateQueue.shift();
      try {
        if (await runGenerateJob(job)) queueDone += 1;
      } catch (error) {
        failed += 1;
        queueDone += 1;
        window.dispatchEvent(
          new CustomEvent("klein:generate-error", {
            detail: { id: job.id, error: error.message },
          }),
        );
        kleinLog("app", "generate-error", { id: job.id, error: error.message });
        console.warn("Klein generate failed:", error.message);
        showError(error.message);
      }
    }
  } finally {
    queueRunning = false;
    if (generateQueue.length) {
      pumpGenerateQueue();
      return;
    }
    const generatedCount = queueTotal - failed;
    statusEl.textContent =
      failed && generatedCount
        ? `Generated ${generatedCount}, ${failed} failed.`
        : failed
          ? `${failed} thumbnail${failed === 1 ? "" : "s"} failed.`
          : `Generated ${generatedCount} thumbnail${generatedCount === 1 ? "" : "s"}.`;
    queueDone = 0;
    queueTotal = 0;
    kleinLog("app", "generate-end", { generated: generatedCount, failed });
    window.dispatchEvent(new CustomEvent("klein:generate-end"));
    setBusy(false, statusEl.textContent);
  }
}

function generateBoard() {
  showError("");
  const subject = subjectText();
  const style = styleText();
  if (!combinePrompt(subject, style)) {
    showError("Add a subject or style first.");
    return;
  }
  const slot = slots[0] ?? addSlot("1:1");
  const ratio = ratioFor(slot.aspect);
  const job = {
    id: `job-${++jobSeq}-${Date.now()}`,
    slotId: slot.id,
    aspect: slot.aspect,
    width: ratio.width,
    height: ratio.height,
    subject,
    style,
    steps: selectedSteps(),
    sampler: resolveSampler(),
    source: selected?.filename,
  };
  queueTotal += 1;
  generateQueue.push(job);
  kleinLog("app", "generate-start", { id: job.id, aspect: job.aspect, queued: generateQueue.length });
  window.dispatchEvent(
    new CustomEvent("klein:generate-start", {
      detail: {
        slots: [
          {
            id: job.id,
            aspect: job.aspect,
            width: job.width,
            height: job.height,
          },
        ],
      },
    }),
  );
  pumpGenerateQueue();
}

function describeTransfer(dataTransfer) {
  const files = filesFromDataTransfer(dataTransfer);
  return files[0] || null;
}

function bindDescribeBox(box, part) {
  if (!box) return;
  box.addEventListener("dragenter", (event) => {
    if (!hasImageFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    prepareEat(box, { width: box.clientWidth - 20, height: 180 });
  });
  box.addEventListener("dragover", (event) => {
    if (!hasImageFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    if (!box.classList.contains("is-drop-target")) {
      prepareEat(box, { width: box.clientWidth - 20, height: 180 });
    }
  });
  box.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && box.contains(event.relatedTarget)) return;
    if (!describing[part]) endEat(box);
  });
  box.addEventListener("drop", (event) => {
    if (!hasImageFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const file = describeTransfer(event.dataTransfer);
    if (file) describeFromSource({ file }, { part });
    else if (!describing[part]) endEat(box);
  });
}

bindDescribeBox(subjectBox, "subject");
bindDescribeBox(styleBox, "style");

for (const el of promptEls) {
  el.addEventListener("input", () => {
    if (!fieldText(el)) el.replaceChildren();
    renderDescribe();
  });
  el.addEventListener("paste", (event) => {
    event.preventDefault();
    const file = describeTransfer(event.clipboardData);
    if (file) {
      describeFromSource({ file }, { part: el === styleEl ? "style" : "subject" });
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    document.execCommand("insertText", false, text);
  });
}

window.addEventListener("klein:drag-lift", (event) => {
  setDragLift(event.detail);
});
window.addEventListener("klein:describe", async (event) => {
  const image = event.detail?.image;
  if (!image) return;
  const part = event.detail?.part === "style" ? "style" : "subject";
  const known = images.find((item) => item.filename === image.filename) ?? image;
  const box = describeBoxes[part];
  setDragLift({ on: false });
  beginEat(box, {
    url: known.url || event.detail?.url,
    width: event.detail?.width,
    height: event.detail?.height,
  });
  if (known.filename) selectImage(known, { restore: false });
  describeFromSource(
    {
      ...known,
      width: event.detail?.width,
      height: event.detail?.height,
    },
    { alreadyEating: true, part },
  );
});
window.addEventListener("klein:describe-hover", (event) => {
  if (event.detail?.on) {
    const part = event.detail.part === "style" ? "style" : "subject";
    prepareEat(describeBoxes[part], {
      width: event.detail.width,
      height: event.detail.height,
    });
    return;
  }
  endEat();
});
generateBtn.addEventListener("click", generateBoard);
samplerBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  openSamplerMenu();
});
document.addEventListener("click", (event) => {
  if (!ratioMenuEl.hidden && !ratioMenuEl.contains(event.target)) closeRatioMenu();
  if (!imageMenuEl.hidden && !imageMenuEl.contains(event.target)) closeImageMenu();
  if (
    !samplerMenuEl.hidden &&
    !samplerMenuEl.contains(event.target) &&
    !samplerBtn.contains(event.target)
  ) {
    closeSamplerMenu();
  }
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeRatioMenu();
    closeSamplerMenu();
    closeImageMenu();
  }
});
window.addEventListener("klein:image-menu", (event) => {
  const detail = event.detail;
  window.requestAnimationFrame(() => openImageMenu(detail));
});
document.addEventListener("contextmenu", (event) => {
  if (imageMenuEl.hidden) return;
  if (imageMenuEl.contains(event.target)) {
    event.preventDefault();
    return;
  }
  closeImageMenu();
});
window.addEventListener("resize", () => {
  if (!ratioMenuEl.hidden && ratioMenuAnchor) {
    placeOnScreen(ratioMenuEl, ratioMenuAnchor.x, ratioMenuAnchor.y);
  }
  if (!samplerMenuEl.hidden) {
    const rect = samplerBtn.getBoundingClientRect();
    placeOnScreen(samplerMenuEl, rect.right, rect.bottom + 4);
  }
});

window.addEventListener("klein:select", (event) => {
  const image = event.detail?.image;
  if (image) selectImage(image);
});

window.addEventListener("klein:error", (event) => {
  showError(event.detail?.message || "Canvas error.");
});

window.addEventListener("dragover", (event) => {
  if (hasImageFiles(event.dataTransfer)) event.preventDefault();
});

window.addEventListener("drop", (event) => {
  if (hasImageFiles(event.dataTransfer)) event.preventDefault();
});

const APPROACH_ZONE_PX = 100;
const FULL_OPEN_PX = 70;
const FOLLOW_HZ = 22;
const MENU_HIT_EXTEND_PX = 190;
const PEEK_OVERHANG_PX = 28;

function attachEdgePeek({
  panel,
  track,
  content,
  side,
  isLocked,
  alwaysOpen = false,
  followPointerY = true,
}) {
  const mobile = window.matchMedia("(max-width: 980px)");
  const pointer = {
    x: side === "left" ? APPROACH_ZONE_PX + 1 : window.innerWidth - APPROACH_ZONE_PX - 1,
    y: 0,
  };
  let current = 0;
  let target = 0;
  let latched = false;
  let menuHitExtend = false;
  let lastTs = 0;
  let interactive = false;
  let raf = 0;

  function panelWidth() {
    return panel.getBoundingClientRect().width || (side === "left" ? 176 : 168);
  }

  function closeClear(withExtend = true) {
    const extra = withExtend && (isLocked() || menuHitExtend) ? MENU_HIT_EXTEND_PX : 0;
    return panelWidth() + PEEK_OVERHANG_PX + extra;
  }

  function openFromX(x) {
    if (side === "left") {
      if (x <= FULL_OPEN_PX) return 1;
      if (x >= APPROACH_ZONE_PX) return 0;
      const t = 1 - (x - FULL_OPEN_PX) / (APPROACH_ZONE_PX - FULL_OPEN_PX);
      return t * t;
    }
    const fromRight = window.innerWidth - x;
    if (fromRight <= FULL_OPEN_PX) return 1;
    if (fromRight >= APPROACH_ZONE_PX) return 0;
    const t = 1 - (fromRight - FULL_OPEN_PX) / (APPROACH_ZONE_PX - FULL_OPEN_PX);
    return t * t;
  }

  function stillOverStrip(x, withExtend = true) {
    const clear = closeClear(withExtend);
    if (side === "left") return x <= clear;
    return x >= window.innerWidth - clear;
  }

  function applyReveal(reveal) {
    if (mobile.matches || alwaysOpen) {
      panel.style.transform = "none";
      panel.style.pointerEvents = "auto";
      panel.setAttribute("aria-hidden", "false");
      return;
    }
    const width = panelWidth();
    const x = side === "left" ? (reveal - 1) * width : (1 - reveal) * width;
    panel.style.transform = `translate3d(${x}px, 0, 0)`;
    const on = reveal > 0.015 || Boolean(isLocked?.());
    if (on !== interactive) {
      interactive = on;
      panel.style.pointerEvents = on ? "auto" : "none";
      panel.setAttribute("aria-hidden", on ? "false" : "true");
    }
  }

  function syncScroll(clientY) {
    if (!followPointerY || mobile.matches) return;
    const rect = track.getBoundingClientRect();
    if (rect.height <= 0) return;
    const t = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const overflow = Math.max(0, content.scrollHeight - track.clientHeight);
    content.style.transform = `translate3d(0, ${-t * overflow}px, 0)`;
  }

  function tick(ts) {
    raf = requestAnimationFrame(tick);
    if (mobile.matches || alwaysOpen) {
      applyReveal(1);
      return;
    }
    const last = lastTs || ts;
    lastTs = ts;
    const dt = Math.min(0.05, (ts - last) / 1000);
    const x = pointer.x;
    const locked = Boolean(isLocked?.());

    if (menuHitExtend && !locked && stillOverStrip(x, false)) {
      menuHitExtend = false;
    }

    let nextTarget;
    if (locked) {
      latched = true;
      nextTarget = 1;
    } else if (latched) {
      if (!stillOverStrip(x)) {
        latched = false;
        menuHitExtend = false;
        nextTarget = 0;
      } else {
        nextTarget = 1;
      }
    } else {
      const open = openFromX(x);
      if (open >= 1) latched = true;
      nextTarget = open;
    }

    target = nextTarget;
    const alpha = 1 - Math.exp(-FOLLOW_HZ * dt);
    let next = current + (target - current) * alpha;
    if (Math.abs(target - next) < 0.001) next = target;

    if (next !== current) {
      current = next;
      applyReveal(next);
    }

    if (current > 0.02 && !locked) syncScroll(pointer.y);
  }

  function onMove(event) {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  }

  window.addEventListener("mousemove", onMove, { passive: true });
  panel.addEventListener("mousemove", (event) => {
    onMove(event);
    if (followPointerY && !isLocked?.()) syncScroll(event.clientY);
  });
  if (!followPointerY) content.style.transform = "none";
  applyReveal(alwaysOpen ? 1 : 0);
  raf = requestAnimationFrame(tick);

  return {
    latch() {
      latched = true;
      menuHitExtend = true;
      target = 1;
      current = 1;
      applyReveal(1);
    },
    stop() {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
    },
  };
}

const boardPeek = attachEdgePeek({
  panel: document.querySelector("#board-panel"),
  track: document.querySelector("#board-track"),
  content: document.querySelector("#board-content"),
  side: "right",
  alwaysOpen: true,
  followPointerY: false,
  isLocked: () =>
    busy ||
    isDescribing() ||
    promptEls.includes(document.activeElement) ||
    !ratioMenuEl.hidden ||
    !samplerMenuEl.hidden ||
    !imageMenuEl.hidden,
});

for (const el of promptEls) {
  el.addEventListener("focus", () => boardPeek.latch());
  el.addEventListener("input", () => boardPeek.latch());
}

config = await fetch("/api/config").then((response) => response.json());
if (config.model) models.klein.id = config.model;
setSampler(config.defaultSampler);
addSlot("1:1");
renderDescribe();
await checkHealth();
await loadImages().catch((error) => showError(error.message));
watchLibrary();
watchModels();
