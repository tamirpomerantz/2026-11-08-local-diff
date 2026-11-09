import express from "express";
import * as esbuild from "esbuild";
import { spawn, execFile } from "child_process";
import { watch } from "node:fs";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import os from "node:os";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = path.join(__dirname, "generated");
const PREVIEW_DIR = path.join(GENERATED_DIR, ".preview");
const MANIFEST_PATH = path.join(GENERATED_DIR, "manifest.json");
const CANVAS_PATH = path.join(GENERATED_DIR, "canvas.json");
const DEBUG_LOG_PATH = path.join(__dirname, "klein-debug.log");
const PUBLIC_DIR = path.join(__dirname, "public");
const PYTHON = path.join(__dirname, ".venv", "bin", "python3.13");
const WORKER_SCRIPT = path.join(__dirname, "python", "worker.py");
const HF_HOME = process.env.HF_HOME ?? path.join(__dirname, ".hf-cache");

const MODEL = process.env.DRAWTHINGS_MODEL ?? "flux_2_klein_4b_q8p.ckpt";
const FAL_VISION_URL = "https://fal.run/fal-ai/any-llm/vision";
const FAL_DESCRIBE_MODEL = process.env.FAL_DESCRIBE_MODEL ?? "openai/gpt-5-mini";
const DESCRIBE_SUBJECT_PROMPT =
  "Write a dense text-to-image prompt for ONLY the subject and positioning, at least 25 words. " +
  "Include who or what is depicted, pose, gesture, scale, placement in the frame, and spatial arrangement. " +
  "Do not mention style, lighting, materials, colors, camera, medium, or mood. " +
  "Do not mention that it is a photo, screenshot, or image. Output only the prompt.";
const DESCRIBE_STYLE_PROMPT =
  "You are writing the ONLY style instructions another image model will receive. " +
  "In 1 or 2 short sentences (about 20 to 40 words), tell it the medium and how it should feel, not what is in the picture. " +
  "Start by naming the medium in plain words: photograph, oil painting, watercolor, ink drawing, 3D render, digital illustration, analog snapshot, or whatever it actually is. " +
  "Then name the genre or treatment (cinematic, editorial, studio still life, documentary, painterly, etc.). " +
  "Describe the ambience and atmosphere. Name 3 to 5 specific colors. Mention lighting quality in a few words. " +
  "Write it as a brief to the model, in prose, not a keyword list and not labeled fields. " +
  "Do not mention camera bodies, focal length, aperture, film stock names, or technique catalogs. " +
  "Do not name or describe the subject, people, objects, or poses. " +
  "Do not call it a screenshot or an image. Output only the style brief.";
const SHORT_SIDE = 128;
const ENLARGE_SHORT_SIDE = 1024;
const ENLARGE_STRENGTH = 0.3;
const ENLARGE_PROMPT = "highly detailed, sharp natural textures, refined surfaces";
const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT ?? 3456);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MIN_SLOTS = 1;
const MAX_SLOTS = 1;

const RATIOS = [
  { id: "1:1", w: 1, h: 1 },
  { id: "5:4", w: 5, h: 4 },
  { id: "4:3", w: 4, h: 3 },
  { id: "3:2", w: 3, h: 2 },
  { id: "16:9", w: 16, h: 9 },
  { id: "4:5", w: 4, h: 5 },
  { id: "3:4", w: 3, h: 4 },
  { id: "2:3", w: 2, h: 3 },
  { id: "9:16", w: 9, h: 16 },
];

const SAMPLERS = [
  { id: 5, name: "UniPC", hint: "Consistent detail at low steps" },
  { id: 0, name: "DPM++ 2M Karras", hint: "Balanced quality and speed" },
  { id: 1, name: "Euler Ancestral", hint: "Fast, varied exploration" },
  { id: 4, name: "DPM++ SDE Karras", hint: "Richer texture, slower" },
  { id: 3, name: "PLMS", hint: "Simple, older DDIM-style fallback" },
  { id: 2, name: "DDIM", hint: "Fast and reproducible" },
  { id: 6, name: "LCM", hint: "Few-step; needs an LCM model" },
  { id: 7, name: "Euler A Substep", hint: "Ancestral sampling with extra detail" },
  { id: 8, name: "DPM++ SDE Substep", hint: "Stochastic sampling, extra refinement" },
  { id: 9, name: "TCD", hint: "Few-step; needs a TCD model" },
  { id: 19, name: "TCD Trailing", hint: "Few-step trailing for distilled/flow" },
  { id: 15, name: "DPM++ 2M Trailing", hint: "Clean multi-step Flux/flow" },
  { id: 10, name: "Euler A Trailing", hint: "Creative Flux/flow sampling" },
  { id: 11, name: "DPM++ SDE Trailing", hint: "Stochastic Flux texture" },
  { id: 16, name: "DDIM Trailing", hint: "Fast, stable Flux default" },
  { id: 17, name: "UniPC Trailing", hint: "Consistent Flux details" },
  { id: 12, name: "DPM++ 2M AYS", hint: "Faster convergence at low steps" },
  { id: 13, name: "Euler A AYS", hint: "Creative, adaptive step schedule" },
  { id: 14, name: "DPM++ SDE AYS", hint: "Varied texture, adaptive steps" },
  { id: 18, name: "UniPC AYS", hint: "Versatile quality at 2–4 steps" },
];
const DEFAULT_SAMPLER = 16;

function findSampler(id) {
  if (id === "random") {
    return SAMPLERS[Math.floor(Math.random() * SAMPLERS.length)] ?? null;
  }
  const value = Number(id);
  return SAMPLERS.find((sampler) => sampler.id === value) ?? null;
}

await loadEnvFile(path.join(__dirname, ".env"));

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use("/generated", express.static(GENERATED_DIR));
app.use(
  "/preview",
  express.static(PREVIEW_DIR, {
    etag: false,
    maxAge: 0,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store");
    },
  }),
);
app.get("/vendor/lucide.min.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "node_modules/lucide/dist/umd/lucide.min.js"));
});
app.use(express.static(PUBLIC_DIR));

let busy = false;
const watchClients = new Set();
const modelClients = new Set();
const ignoredWatchFiles = new Set(["manifest.json", "canvas.json", ".DS_Store"]);
const modelState = {
  klein: {
    key: "klein",
    id: MODEL,
    title: "FLUX.2 Klein 4B",
    loaded: false,
    action: "idle",
    percent: 0,
    message: "",
  },
  memoryGb: 0,
};

function publicModelState() {
  return {
    klein: { ...modelState.klein },
    memoryGb: modelState.memoryGb,
  };
}

function resetModelState() {
  modelState.memoryGb = 0;
}

function applyModelEvent(event) {
  if (typeof event.memoryGb === "number") modelState.memoryGb = event.memoryGb;
  broadcastModels();
}

function setKleinState({ loaded, action = "idle", percent = 0, message = "" }) {
  modelState.klein.loaded = Boolean(loaded);
  modelState.klein.action = action;
  modelState.klein.percent = percent;
  modelState.klein.message = message;
  broadcastModels();
}

function broadcastModels() {
  const payload = `data: ${JSON.stringify({ type: "models", ...publicModelState() })}\n\n`;
  for (const client of modelClients) client.write(payload);
}

function snap64(value, min = SHORT_SIDE) {
  return Math.max(min, Math.round(value / 64) * 64);
}

function sizeForShortSide(width, height, shortSide = ENLARGE_SHORT_SIDE) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const scale = shortSide / Math.min(w, h);
  return {
    width: snap64(w * scale, 64),
    height: snap64(h * scale, 64),
  };
}

async function lanczosResize(src, dest, width, height) {
  try {
    await execFileAsync(PYTHON, [
      "-c",
      [
        "from PIL import Image",
        `src = ${JSON.stringify(src)}`,
        `dest = ${JSON.stringify(dest)}`,
        `size = (${Number(width)}, ${Number(height)})`,
        "im = Image.open(src).convert('RGB')",
        "im = im.resize(size, Image.Resampling.LANCZOS)",
        "im.save(dest, 'PNG')",
      ].join("\n"),
    ]);
  } catch {
    await execFileAsync("sips", ["-z", String(height), String(width), src, "--out", dest]);
  }
}

function sizeForRatio(ratio) {
  if (ratio.w === ratio.h) return { width: SHORT_SIDE, height: SHORT_SIDE };
  if (ratio.w > ratio.h) {
    return { width: snap64((SHORT_SIDE * ratio.w) / ratio.h), height: SHORT_SIDE };
  }
  return { width: SHORT_SIDE, height: snap64((SHORT_SIDE * ratio.h) / ratio.w) };
}

function ratiosWithSizes() {
  return RATIOS.map((ratio) => ({ id: ratio.id, ...sizeForRatio(ratio) }));
}

function findRatio(id) {
  return RATIOS.find((ratio) => ratio.id === id) ?? null;
}

async function loadEnvFile(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is optional.
  }
}

function publicError(error) {
  const key = process.env.FALKEY || process.env.FAL_KEY || "";
  let message = String(error?.message || error);
  if (key) message = message.split(key).join("[redacted]");
  return message;
}

function falKey() {
  return String(process.env.FALKEY || process.env.FAL_KEY || "").trim();
}

function mimeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function falErrorMessage(payload, status) {
  const detail = payload?.detail ?? payload?.error ?? payload?.message;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (Array.isArray(detail)) {
    return detail
      .map((item) => (typeof item === "string" ? item : item?.msg || JSON.stringify(item)))
      .filter(Boolean)
      .join("; ");
  }
  if (detail && typeof detail === "object") return JSON.stringify(detail);
  return `fal describe failed (${status})`;
}

function cleanDescribeText(text) {
  let value = String(text ?? "").trim();
  if (value.startsWith("```")) {
    value = value.replace(/^```(?:\w+)?\s*/, "").replace(/\s*```$/, "").trim();
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

const DESCRIBE_MAX_EDGE = 256;
const DESCRIBE_JPEG_QUALITY = "35";
const DESCRIBE_DATA_URL_MAX_BYTES = 5 * 1024 * 1024;

function parseImageDataUrl(value) {
  const text = String(value ?? "").trim();
  const comma = text.indexOf(",");
  if (!text.startsWith("data:image/") || comma < 0) return null;
  const header = text.slice(5, comma).toLowerCase();
  const mime = header.split(";")[0];
  const kind = mime.replace("image/", "") === "jpg" ? "jpeg" : mime.replace("image/", "");
  if (!["jpeg", "png", "webp"].includes(kind)) return null;
  const buf = Buffer.from(text.slice(comma + 1).replace(/\s+/g, ""), "base64");
  if (!buf.length || buf.length > DESCRIBE_DATA_URL_MAX_BYTES) return null;
  return { buf, ext: kind === "jpeg" ? ".jpg" : `.${kind}` };
}

async function bufferToFalJpegDataUrl(buf, ext = ".png") {
  const src = path.join(os.tmpdir(), `klein-describe-src-${randomUUID()}${ext}`);
  const tmp = path.join(os.tmpdir(), `klein-describe-${randomUUID()}.jpg`);
  try {
    await fs.writeFile(src, buf);
    await execFileAsync("sips", [
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      DESCRIBE_JPEG_QUALITY,
      "-Z",
      String(DESCRIBE_MAX_EDGE),
      src,
      "--out",
      tmp,
    ]);
    const out = await fs.readFile(tmp);
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    return `data:${mimeForPath(`file${ext}`)};base64,${buf.toString("base64")}`;
  } finally {
    await fs.unlink(src).catch(() => {});
    await fs.unlink(tmp).catch(() => {});
  }
}

async function imageToFalDataUrl(filePath) {
  const buf = await fs.readFile(filePath);
  return bufferToFalJpegDataUrl(buf, path.extname(filePath).toLowerCase() || ".png");
}

async function falVision(imageUrl, prompt) {
  const key = falKey();
  if (!key) throw new Error("Missing FALKEY. Add it to .env to describe images.");
  const response = await fetch(FAL_VISION_URL, {
    method: "POST",
    headers: {
      Authorization: `Key ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      system_prompt: "Output only the image prompt. No preface, quotes, or markdown.",
      image_urls: [imageUrl],
      model: FAL_DESCRIBE_MODEL,
      reasoning: true,
      priority: "latency",
      temperature: 0.3,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(falErrorMessage(payload, response.status));
  const data = payload?.data ?? payload;
  const text = cleanDescribeText(data?.output);
  if (!text) throw new Error("fal returned an empty description.");
  return text;
}

async function describeWithFal({ filePath, dataUrl, part }) {
  const task = part === "style" ? "style" : "subject";
  let imageUrl;
  if (dataUrl) {
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed) throw new Error("Could not read dropped image.");
    imageUrl = await bufferToFalJpegDataUrl(parsed.buf, parsed.ext);
  } else {
    imageUrl = await imageToFalDataUrl(filePath);
  }
  const text = await falVision(
    imageUrl,
    task === "style" ? DESCRIBE_STYLE_PROMPT : DESCRIBE_SUBJECT_PROMPT,
  );
  return { [task]: text };
}

function safeBasename(name) {
  return path.basename(String(name ?? "")).replace(/[^a-zA-Z0-9._-]/g, "");
}

async function ensureDirs() {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
}

async function readManifest() {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeManifest(entries) {
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(entries, null, 2));
}

let manifestWrite = Promise.resolve();
function enqueueManifest(task) {
  const run = manifestWrite.then(task, task);
  manifestWrite = run.then(() => undefined, () => undefined);
  return run;
}

function descriptionParts(entry) {
  const subject = String(entry?.subject ?? "").trim();
  const style = String(entry?.style ?? "").trim();
  return { subject, style, ready: Boolean(subject && style) };
}

function combinePrompt(subject, style) {
  return [subject, style].map((part) => String(part ?? "").trim()).filter(Boolean).join("\n\n");
}

async function rememberedPart(filename, part) {
  const base = path.basename(String(filename ?? ""));
  const task = part === "style" ? "style" : "subject";
  if (!base) return "";
  const manifest = await readManifest();
  const parts = descriptionParts(manifest.find((item) => item.filename === base));
  return parts[task];
}

async function rememberImageDescription(filename, { subject, style }) {
  const base = path.basename(String(filename ?? ""));
  const nextSubject = String(subject ?? "").trim();
  const nextStyle = String(style ?? "").trim();
  if (!base || (!nextSubject && !nextStyle)) return;
  await enqueueManifest(async () => {
    const manifest = await readManifest();
    const index = manifest.findIndex((item) => item.filename === base);
    const current = index >= 0 ? manifest[index] : { filename: base, createdAt: new Date().toISOString() };
    const merged = {
      ...current,
      ...(nextSubject ? { subject: nextSubject } : {}),
      ...(nextStyle ? { style: nextStyle } : {}),
    };
    if (index >= 0) manifest[index] = merged;
    else manifest.push(merged);
    await writeManifest(manifest);
  });
  broadcastLibrary();
}

const DEFAULT_CANVAS = { viewport: { x: 0, y: 0, zoom: 1 }, positions: {} };

async function readCanvas() {
  try {
    const parsed = JSON.parse(await fs.readFile(CANVAS_PATH, "utf8"));
    return {
      viewport: parsed?.viewport && typeof parsed.viewport === "object"
        ? parsed.viewport
        : DEFAULT_CANVAS.viewport,
      positions:
        parsed?.positions && typeof parsed.positions === "object" ? parsed.positions : {},
    };
  } catch {
    return { viewport: { ...DEFAULT_CANVAS.viewport }, positions: {} };
  }
}

async function writeCanvas(data) {
  await fs.writeFile(CANVAS_PATH, JSON.stringify(data, null, 2));
}

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? __dirname,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error((stderr || stdout).trim() || `${command} exited ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function parseSamplingProgress(text) {
  const match = /Sampling\.\.\.\s+(\d+)\s*\/\s*(\d+)/.exec(text);
  if (!match) return null;
  return { step: Number(match[1]), total: Number(match[2]) };
}

async function drawThingsModelPresent() {
  try {
    const { stdout, stderr } = await runCommand("draw-things-cli", ["models", "list", "--downloaded-only"]);
    const text = `${stdout}\n${stderr}`;
    return text.includes(MODEL);
  } catch {
    return false;
  }
}

async function refreshKleinAvailability() {
  const present = await drawThingsModelPresent();
  setKleinState({
    loaded: present,
    action: "idle",
    percent: present ? 100 : 0,
    message: present ? "Draw Things" : "Missing",
  });
  return present;
}

function releaseMlxForGenerate() {
  if (!worker.alive) return Promise.resolve();
  return worker
    .request({ op: "unload", model: "all" })
    .catch(() => {})
    .finally(() => {
      worker.stop();
    });
}

const PTY_WRAPPER = `
import os, sys, pty
os.environ.setdefault("TERM", "xterm-256color")
os.environ.setdefault("TERM_PROGRAM", "iTerm.app")
os.environ.setdefault("COLUMNS", "80")
os.environ.setdefault("LINES", "24")
status = pty.spawn(sys.argv[1:])
code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else os.WEXITSTATUS(status)
raise SystemExit(code)
`;

function consumeITermImages(state, chunk, onPng) {
  state.buf += chunk.toString("latin1");
  const marker = "\u001b]1337;File=";
  while (true) {
    const start = state.buf.indexOf(marker);
    if (start < 0) {
      if (state.buf.length > 2_000_000) state.buf = state.buf.slice(-2000);
      return;
    }
    const colon = state.buf.indexOf(":", start);
    if (colon < 0) return;
    const bel = state.buf.indexOf("\u0007", colon);
    const st = state.buf.indexOf("\u001b\\", colon);
    let end = -1;
    let payloadEnd = -1;
    if (bel >= 0 && (st < 0 || bel < st)) {
      end = bel + 1;
      payloadEnd = bel;
    } else if (st >= 0) {
      end = st + 2;
      payloadEnd = st;
    } else {
      return;
    }
    const b64 = state.buf.slice(colon + 1, payloadEnd).replace(/\s/g, "");
    state.buf = state.buf.slice(end);
    try {
      const png = Buffer.from(b64, "base64");
      if (png.length > 32 && png[0] === 0x89) onPng(png);
    } catch {
      // Ignore a truncated protocol chunk.
    }
  }
}

function generateWithLivePreview({ args, outputPath, previewPath, onPreview, onProgress }) {
  const previewArgs = [
    ...args,
    "--terminal-image",
    "--terminal-image-protocol",
    "iterm2",
    "--no-download-missing",
  ];
  const fallbackArgs = [...args, "--output", outputPath, "--disable-preview", "--no-download-missing"];

  const runWithPty = () =>
    new Promise((resolve, reject) => {
      const child = spawn("python3", ["-u", "-c", PTY_WRAPPER, "draw-things-cli", ...previewArgs], {
        cwd: __dirname,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          TERM_PROGRAM: "iTerm.app",
          COLUMNS: "80",
          LINES: "24",
          PYTHONUNBUFFERED: "1",
        },
      });
      const iterm = { buf: "" };
      let stdout = "";
      let stderr = "";
      let frames = 0;
      let writing = Promise.resolve();
      const handleBytes = (chunk) => {
        const text = chunk.toString("utf8");
        stdout += text;
        const progress = parseSamplingProgress(text.replace(/\r/g, "\n"));
        if (progress) onProgress?.(progress);
        consumeITermImages(iterm, chunk, (png) => {
          writing = writing.then(async () => {
            frames += 1;
            await fs.writeFile(previewPath, png);
            onPreview?.();
          });
        });
      };
      child.stdout.on("data", handleBytes);
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        handleBytes(chunk);
      });
      child.on("error", reject);
      child.on("close", async (code) => {
        await writing.catch(() => {});
        if (code === 0 && frames > 0) {
          await fs.copyFile(previewPath, outputPath);
          resolve({ stdout, stderr, frames });
          return;
        }
        reject(Object.assign(new Error((stderr || stdout).trim() || `draw-things-cli exited ${code}`), { frames }));
      });
    });

  return runWithPty().catch(async (error) => {
    if (error.frames > 0) throw error;
    await runCommand("draw-things-cli", fallbackArgs);
    return { frames: 0, fallback: true };
  });
}

class MlxWorker {
  constructor() {
    this.proc = null;
    this.pending = new Map();
    this.ready = false;
    this.alive = false;
    this.lastError = "";
    this.starting = null;
    this.restartTimer = null;
  }

  start() {
    if (this.ready && this.alive) return Promise.resolve(this);
    if (this.starting) return this.starting;
    this.starting = this._spawn().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async _spawn() {
    this.stop();
    this.ready = false;
    this.alive = false;
    this.lastError = "";

    await fs.access(PYTHON).catch(() => {
      throw new Error("Python 3.13 venv is missing. Create it with python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt");
    });
    await fs.access(WORKER_SCRIPT).catch(() => {
      throw new Error("python/worker.py is missing.");
    });

    const child = spawn(PYTHON, ["-u", WORKER_SCRIPT], {
      cwd: __dirname,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        HF_HOME,
        HF_XET_HIGH_PERFORMANCE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = child;
    this.alive = true;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => this._onLine(line));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text.startsWith("[mlx-worker]") ? text : `[mlx] ${text}`);
    });
    child.on("error", (error) => {
      this.lastError = error.message;
      this._failAll(error);
    });
    child.on("close", (code) => {
      if (this.proc !== child) return;
      this.alive = false;
      this.ready = false;
      this.proc = null;
      resetModelState();
      broadcastModels();
      const error = new Error(this.lastError || `MLX worker exited ${code ?? "early"}`);
      this._failAll(error);
      this.starting = null;
    });

    await Promise.race([
      this.request({ op: "ping" }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("MLX worker did not become ready.")), 120_000);
      }),
    ]).catch((error) => {
      this.lastError = error.message;
      throw error;
    });

    this.ready = true;
    this.starting = null;
    return this;
  }

  stop() {
    clearTimeout(this.restartTimer);
    if (!this.proc) return;
    const child = this.proc;
    this.proc = null;
    this.alive = false;
    this.ready = false;
    child.kill("SIGTERM");
  }

  _onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (event.type === "ready") {
      this.ready = true;
      resetModelState();
      return;
    }
    if (event.type === "model") applyModelEvent(event);
    const pending = this.pending.get(event.id);
    if (!pending) return;
    pending.onEvent(event);
    if (event.type === "done" || event.type === "error") {
      this.pending.delete(event.id);
      if (event.type === "error") pending.reject(new Error(event.error || "MLX worker error"));
      else pending.resolve(event);
    }
  }

  _failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async ensure() {
    if (this.ready && this.alive) return;
    await this.start();
  }

  request(payload, onEvent = () => {}) {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin.writable) {
        reject(new Error("MLX worker is not running."));
        return;
      }
      const id = payload.id ?? randomUUID();
      this.pending.set(id, { resolve, reject, onEvent });
      this.proc.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
  }
}

const worker = new MlxWorker();

async function imageSize(filePath) {
  const { stdout } = await runCommand("sips", ["-g", "pixelWidth", "-g", "pixelHeight", filePath]);
  const width = Number(/pixelWidth:\s+(\d+)/.exec(stdout)?.[1]);
  const height = Number(/pixelHeight:\s+(\d+)/.exec(stdout)?.[1]);
  if (!width || !height) throw new Error("Could not read image size.");
  return { width, height };
}

async function listImages() {
  const manifest = await readManifest();
  const byFile = new Map(manifest.map((entry) => [entry.filename, entry]));
  let names = [];
  try {
    names = (await fs.readdir(GENERATED_DIR)).filter(
      (name) =>
        !name.startsWith(".") && IMAGE_EXTS.has(path.extname(name).toLowerCase()),
    );
  } catch {
    names = [];
  }

  const images = await Promise.all(
    names.map(async (filename) => {
      const filePath = path.join(GENERATED_DIR, filename);
      const stats = await fs.stat(filePath);
      const meta = byFile.get(filename) ?? {};
      let width = meta.width;
      let height = meta.height;
      if (!width || !height) {
        try {
          const size = await imageSize(filePath);
          width = size.width;
          height = size.height;
        } catch {
          width = SHORT_SIDE;
          height = SHORT_SIDE;
        }
      }
      return {
        filename,
        url: `/generated/${encodeURIComponent(filename)}`,
        subject: meta.subject ?? "",
        style: meta.style ?? "",
        seed: meta.seed ?? null,
        steps: meta.steps ?? null,
        sampler: meta.sampler ?? null,
        aspect: meta.aspect ?? null,
        createdAt: meta.createdAt ?? stats.mtime.toISOString(),
        width,
        height,
        scale: Number(meta.scale) >= 2 ? 2 : 1,
      };
    }),
  );

  images.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return images;
}

function resolveExistingFile(filename) {
  const base = path.basename(String(filename ?? ""));
  if (!base || base !== filename) return null;
  if (base.includes("\0") || base === "." || base === "..") return null;
  if (!IMAGE_EXTS.has(path.extname(base).toLowerCase())) return null;
  return path.join(GENERATED_DIR, base);
}

app.get("/api/config", (_req, res) => {
  res.json({
    model: MODEL,
    describeModel: FAL_DESCRIBE_MODEL,
    shortSide: SHORT_SIDE,
    minSlots: MIN_SLOTS,
    maxSlots: MAX_SLOTS,
    steps: [2, 4],
    samplers: SAMPLERS,
    defaultSampler: DEFAULT_SAMPLER,
    ratios: ratiosWithSizes(),
    mlx: false,
    drawThings: true,
    busy,
  });
});

app.get("/api/health", async (_req, res) => {
  const present = await refreshKleinAvailability();
  if (!present) {
    res.status(503).json({
      ok: false,
      drawThings: false,
      mlx: false,
      model: MODEL,
      describeModel: FAL_DESCRIBE_MODEL,
      error: `${MODEL} is not downloaded. Run draw-things-cli models ensure --model ${MODEL}`,
      models: publicModelState(),
    });
    return;
  }
  res.json({
    ok: true,
    drawThings: true,
    mlx: worker.ready,
    model: MODEL,
    describeModel: FAL_DESCRIBE_MODEL,
    kleinLoaded: modelState.klein.loaded,
    models: publicModelState(),
  });
});

app.get("/api/images", async (_req, res) => {
  try {
    await ensureDirs();
    res.json({ images: await listImages(), busy });
  } catch (error) {
    res.status(500).json({ error: publicError(error) });
  }
});

app.get("/api/canvas", async (_req, res) => {
  try {
    await ensureDirs();
    res.json(await readCanvas());
  } catch (error) {
    res.status(500).json({ error: publicError(error) });
  }
});

app.post("/api/debug-log", async (req, res) => {
  const entry = {
    t: new Date().toISOString(),
    source: String(req.body?.source ?? ""),
    message: String(req.body?.message ?? ""),
    data: req.body?.data ?? null,
  };
  const line = `${JSON.stringify(entry)}\n`;
  await fs.appendFile(DEBUG_LOG_PATH, line).catch(() => {});
  console.log(`[klein ${entry.source}] ${entry.message}${entry.data != null ? ` ${JSON.stringify(entry.data)}` : ""}`);
  res.json({ ok: true });
});

app.put("/api/canvas", async (req, res) => {
  try {
    await ensureDirs();
    const current = await readCanvas();
    const viewport = req.body?.viewport && typeof req.body.viewport === "object"
      ? req.body.viewport
      : current.viewport;
    const positions =
      req.body?.positions && typeof req.body.positions === "object"
        ? req.body.positions
        : current.positions;
    const next = { viewport, positions };
    await writeCanvas(next);
    res.json(next);
  } catch (error) {
    res.status(500).json({ error: publicError(error) });
  }
});

app.delete("/api/images/:filename", async (req, res) => {
  const filePath = resolveExistingFile(req.params.filename);
  if (!filePath) {
    res.status(400).json({ error: "Unknown image." });
    return;
  }
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      res.status(500).json({ error: publicError(error) });
      return;
    }
  }
  try {
    const filename = path.basename(filePath);
    const manifest = (await readManifest()).filter((entry) => entry.filename !== filename);
    await writeManifest(manifest);
    const canvas = await readCanvas();
    if (canvas.positions[filename]) {
      delete canvas.positions[filename];
      await writeCanvas(canvas);
    }
    broadcastLibrary();
    res.json({ ok: true, filename });
  } catch (error) {
    res.status(500).json({ error: publicError(error) });
  }
});

app.get("/api/models", (_req, res) => {
  res.json(publicModelState());
});

app.get("/api/models/watch", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: "models", ...publicModelState() })}\n\n`);
  modelClients.add(res);
  req.on("close", () => {
    modelClients.delete(res);
  });
});

app.post("/api/models/unload", async (req, res) => {
  const which = String(req.body?.model ?? "all");
  if (!["klein", "all"].includes(which)) {
    res.status(400).json({ error: "Unload klein or all." });
    return;
  }
  if (busy) {
    res.status(409).json({ error: "Cannot unload while generating." });
    return;
  }
  try {
    if (worker.alive) {
      const result = await worker.request({ op: "unload", model: which });
      applyModelEvent(result);
      if (which === "all") worker.stop();
    } else {
      resetModelState();
      broadcastModels();
    }
    await refreshKleinAvailability();
    res.json(publicModelState());
  } catch (error) {
    res.status(500).json({ error: publicError(error) });
  }
});

app.get("/api/watch", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
  watchClients.add(res);
  req.on("close", () => {
    watchClients.delete(res);
  });
});

app.post("/api/import", async (req, res) => {
  const filename = safeBasename(req.body?.filename);
  const data = String(req.body?.data ?? "");
  if (!filename || !IMAGE_EXTS.has(path.extname(filename).toLowerCase())) {
    res.status(400).json({ error: "Import a png, jpg, or webp file." });
    return;
  }
  const comma = data.indexOf(",");
  const base64 = data.startsWith("data:") ? data.slice(comma + 1) : data;
  if (!base64) {
    res.status(400).json({ error: "Missing image data." });
    return;
  }
  try {
    await ensureDirs();
    const unique = `${timestamp()}-${filename}`;
    const filePath = path.join(GENERATED_DIR, unique);
    await fs.writeFile(filePath, Buffer.from(base64, "base64"));
    const size = await imageSize(filePath);
    res.json({
      image: {
        filename: unique,
        url: `/generated/${encodeURIComponent(unique)}`,
        subject: "",
        style: "",
        createdAt: new Date().toISOString(),
        ...size,
      },
    });
  } catch (error) {
    res.status(500).json({ error: publicError(error) });
  }
});

app.post("/api/describe", async (req, res) => {
  const dataUrl = String(req.body?.image ?? "").trim();
  const parsed = dataUrl ? parseImageDataUrl(dataUrl) : null;
  const filePath = resolveExistingFile(req.body?.filename);
  if (!parsed && !filePath) {
    res.status(400).json({ error: "Drop an image onto the prompt to describe it." });
    return;
  }
  try {
    const filename = filePath ? path.basename(filePath) : "";
    const part = req.body?.part === "style" ? "style" : "subject";
    const stored = filename ? await rememberedPart(filename, part) : "";
    if (stored) {
      res.json({ [part]: stored, model: FAL_DESCRIBE_MODEL, cached: true });
      return;
    }
    if (filePath) await fs.access(filePath);
    const described = await describeWithFal({
      ...(parsed
        ? { dataUrl: `data:image/${parsed.ext === ".jpg" ? "jpeg" : parsed.ext.slice(1)};base64,${parsed.buf.toString("base64")}` }
        : { filePath }),
      part,
    });
    if (filename) await rememberImageDescription(filename, described);
    res.json({ ...described, model: FAL_DESCRIBE_MODEL });
  } catch (error) {
    res.status(500).json({ error: publicError(error) });
  }
});

app.post("/api/generate", async (req, res) => {
  const subject = String(req.body?.subject ?? "").trim();
  const style = String(req.body?.style ?? "").trim();
  const mode = String(req.body?.mode ?? "");
  const initPath = mode === "enlarge" ? resolveExistingFile(req.body?.image) : null;
  const prompt =
    combinePrompt(subject, style) ||
    String(req.body?.prompt ?? "").trim() ||
    (initPath ? ENLARGE_PROMPT : "");
  const aspect = String(req.body?.aspect ?? "1:1");
  const ratio = findRatio(aspect);
  if (!prompt) {
    res.status(400).json({ error: "Add a subject or style first." });
    return;
  }
  if (mode === "enlarge" && !initPath) {
    res.status(400).json({ error: "Enlarge needs a source image." });
    return;
  }
  if (!initPath && !ratio) {
    res.status(400).json({ error: "Unknown aspect ratio." });
    return;
  }
  if (busy) {
    res.status(409).json({ error: "A generation is already running." });
    return;
  }

  const steps = Number(req.body?.steps ?? 4);
  if (steps !== 2 && steps !== 4) {
    res.status(400).json({ error: "Steps must be 2 or 4." });
    return;
  }
  const sampler = findSampler(req.body?.sampler) ?? findSampler(DEFAULT_SAMPLER);
  const strength = initPath
    ? Math.min(1, Math.max(0.05, Number(req.body?.strength ?? ENLARGE_STRENGTH) || ENLARGE_STRENGTH))
    : null;

  let width;
  let height;
  if (initPath) {
    const original = await imageSize(initPath);
    const sized = sizeForShortSide(original.width, original.height, ENLARGE_SHORT_SIDE);
    width = sized.width;
    height = sized.height;
  } else {
    ({ width, height } = sizeForRatio(ratio));
  }
  const seed = Math.floor(Math.random() * 2 ** 31);
  const filename = `${timestamp()}-${aspect.replace(":", "x")}-${seed}.png`;
  const outputPath = path.join(GENERATED_DIR, filename);
  const previewName = `${seed}.png`;
  const previewPath = path.join(PREVIEW_DIR, previewName);
  const promptPath = path.join(PREVIEW_DIR, `${seed}.txt`);
  const initResizedPath = initPath ? path.join(PREVIEW_DIR, `${seed}-init.png`) : "";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  busy = true;
  try {
    await ensureDirs();
    if (!(await refreshKleinAvailability())) {
      throw new Error(`${MODEL} is not downloaded.`);
    }
    send({ type: "start", previewUrl: `/preview/${previewName}` });
    send({ type: "status", message: initPath ? "Enlarging with Draw Things" : "Generating with Draw Things" });
    await releaseMlxForGenerate();
    setKleinState({ loaded: true, action: "load", percent: 4, message: "Draw Things" });
    await fs.writeFile(promptPath, prompt);
    if (initPath) {
      await lanczosResize(initPath, initResizedPath, width, height);
      await fs.copyFile(initResizedPath, previewPath);
      send({ type: "preview", url: `/preview/${previewName}?t=${Date.now()}` });
      send({ type: "progress", step: 0, total: steps });
    }
    await generateWithLivePreview({
      args: [
        "generate",
        "--model",
        MODEL,
        "--prompt-file",
        promptPath,
        "--width",
        String(width),
        "--height",
        String(height),
        "--steps",
        String(steps),
        "--seed",
        String(seed),
        ...(initPath ? ["--image", initResizedPath, "--strength", String(strength)] : []),
        "--config-json",
        JSON.stringify({ sampler: sampler.id }),
      ],
      outputPath,
      previewPath,
      onPreview: () => {
        send({ type: "preview", url: `/preview/${previewName}?t=${Date.now()}` });
      },
      onProgress: ({ step, total }) => {
        const percent = Math.max(4, Math.round((step / total) * 100));
        setKleinState({ loaded: true, action: "load", percent, message: "Draw Things" });
        send({ type: "progress", step, total });
        send({
          type: "model",
          model: "klein",
          action: "load",
          percent,
          message: "Draw Things",
          kleinLoaded: true,
        });
      },
    });

    const entry = {
      filename,
      subject,
      style,
      seed,
      steps,
      sampler: sampler.id,
      aspect,
      createdAt: new Date().toISOString(),
      width,
      height,
      scale: initPath ? 2 : 1,
      strength: strength ?? null,
      model: MODEL,
      source: initPath
        ? path.basename(initPath)
        : req.body?.source
          ? path.basename(String(req.body.source))
          : null,
    };
    const manifest = await readManifest();
    manifest.push(entry);
    await writeManifest(manifest);
    setKleinState({ loaded: true, action: "idle", percent: 100, message: "Draw Things" });
    console.log(`[klein generate] wrote ${filename} ${width}x${height}`);
    send({
      type: "done",
      image: { ...entry, url: `/generated/${encodeURIComponent(filename)}` },
    });
    res.end();
  } catch (error) {
    send({ type: "error", error: publicError(error) });
    res.end();
  } finally {
    busy = false;
    await fs.unlink(promptPath).catch(() => {});
    await fs.unlink(previewPath).catch(() => {});
    if (initResizedPath) await fs.unlink(initResizedPath).catch(() => {});
    await refreshKleinAvailability();
  }
});

function broadcastLibrary() {
  const payload = `data: ${JSON.stringify({ type: "library" })}\n\n`;
  for (const client of watchClients) {
    client.write(payload);
  }
}

function isWatchedImage(filename) {
  if (!filename || filename.startsWith(".") || ignoredWatchFiles.has(filename)) return false;
  return IMAGE_EXTS.has(path.extname(filename).toLowerCase());
}

async function waitUntilStable(filePath) {
  let previous = -1;
  for (let i = 0; i < 10; i += 1) {
    try {
      const stats = await fs.stat(filePath);
      if (stats.size > 0 && stats.size === previous) return true;
      previous = stats.size;
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return previous > 0;
}

let watchTimer = null;
function queueLibraryRefresh(filename) {
  if (filename && !isWatchedImage(filename) && !ignoredWatchFiles.has(filename)) return;
  clearTimeout(watchTimer);
  watchTimer = setTimeout(async () => {
    if (isWatchedImage(filename)) {
      await waitUntilStable(path.join(GENERATED_DIR, filename));
    }
    broadcastLibrary();
  }, 150);
}

await ensureDirs();
watch(GENERATED_DIR, (eventType, filename) => {
  queueLibraryRefresh(filename);
});

const canvasBuild = await esbuild.context({
  absWorkingDir: __dirname,
  entryPoints: ["src/canvas/main.jsx"],
  outfile: "public/canvas.js",
  bundle: true,
  format: "esm",
  jsx: "automatic",
  sourcemap: true,
  logLevel: "silent",
});
await canvasBuild.rebuild();
await canvasBuild.watch();

const server = app.listen(PORT, () => {
  console.log(`Klein local studio: http://127.0.0.1:${PORT}`);
  console.log(`Draw Things generate: ${MODEL}`);
  console.log(`fal describe: ${FAL_DESCRIBE_MODEL}`);
  console.log(`Watching ${GENERATED_DIR}`);
  refreshKleinAvailability().catch(() => {});
});

function shutdown() {
  worker.stop();
  canvasBuild.dispose();
  server.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
