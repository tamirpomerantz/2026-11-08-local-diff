import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { getLlama, LlamaChatSession, resolveModelFile } from "node-llama-cpp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const MODELS_DIR = path.join(ROOT, "models");

export const TEXT_MODEL_URI =
  process.env.LOCAL_TEXT_MODEL ??
  "hf:Qwen/Qwen2.5-1.5B-Instruct-GGUF/qwen2.5-1.5b-instruct-q4_k_m.gguf";
export const TEXT_MODEL_FILE = "qwen2.5-1.5b-instruct-q4_k_m.gguf";
export const TEXT_MODEL_ID = process.env.LOCAL_TEXT_MODEL_ID ?? "Qwen2.5-1.5B-Instruct-Q4_K_M";

const PROMPT_JSON_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    style: { type: "string" },
  },
  required: ["subject", "style"],
};

function log(message) {
  console.log(`[text-llm] ${message}`);
}

class LocalTextLlm {
  constructor() {
    this.llama = null;
    this.model = null;
    this.context = null;
    this.grammar = null;
    this.modelPath = null;
    this.loaded = false;
    this.loading = null;
    this.lock = Promise.resolve();
  }

  snapshot() {
    return {
      id: TEXT_MODEL_ID,
      loaded: this.loaded,
      path: this.modelPath,
    };
  }

  withLock(task) {
    const run = this.lock.then(task, task);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async ensureModelFile() {
    if (this.modelPath) return this.modelPath;
    log(`resolving ${TEXT_MODEL_ID}`);
    this.modelPath = await resolveModelFile(TEXT_MODEL_URI, {
      directory: MODELS_DIR,
      fileName: TEXT_MODEL_FILE,
      cli: true,
    });
    log(`ready on disk: ${path.basename(this.modelPath)}`);
    return this.modelPath;
  }

  async load() {
    if (this.loaded && this.model && this.context && this.grammar) return;
    if (this.loading) return this.loading;
    this.loading = this._load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async _load() {
    const modelPath = await this.ensureModelFile();
    log(`loading ${TEXT_MODEL_ID}`);
    this.llama = await getLlama({ gpu: "auto" });
    this.grammar = await this.llama.createGrammarForJsonSchema(PROMPT_JSON_SCHEMA);
    this.model = await this.llama.loadModel({
      modelPath,
      gpuLayers: "auto",
    });
    this.context = await this.model.createContext({
      contextSize: 2048,
      sequences: 1,
      batchSize: 256,
      flashAttention: "auto",
    });
    this.loaded = true;
    log("loaded");
  }

  async complete({ systemPrompt, userPrompt, temperature = 0.4, maxTokens = 384 } = {}) {
    return this.withLock(async () => {
      await this.load();
      const sequence = this.context.getSequence();
      const session = new LlamaChatSession({
        contextSequence: sequence,
        systemPrompt,
        autoDisposeSequence: true,
      });
      try {
        return await session.prompt(userPrompt, {
          temperature,
          maxTokens,
          grammar: this.grammar,
        });
      } finally {
        await session.dispose({ disposeSequence: true });
      }
    });
  }

  async unload() {
    return this.withLock(() => this._unload());
  }

  async _unload() {
    if (!this.loaded && !this.llama && !this.model && !this.context) return;
    log("unloading");
    const context = this.context;
    const model = this.model;
    const llama = this.llama;
    this.context = null;
    this.model = null;
    this.grammar = null;
    this.llama = null;
    this.loaded = false;
    try {
      await context?.dispose?.();
    } catch (error) {
      log(`context dispose: ${error.message || error}`);
    }
    try {
      await model?.dispose?.();
    } catch (error) {
      log(`model dispose: ${error.message || error}`);
    }
    try {
      await llama?.dispose?.();
    } catch (error) {
      log(`llama dispose: ${error.message || error}`);
    }
    log("unloaded");
  }
}

export const textLlm = new LocalTextLlm();

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  await textLlm.ensureModelFile();
}
