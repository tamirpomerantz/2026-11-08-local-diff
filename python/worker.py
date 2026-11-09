#!/usr/bin/env python3
"""Persistent MLX worker for leftover FLUX.2 Klein 4B generate."""

from __future__ import annotations

import gc
import json
import os
import sys
import threading
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("HF_HOME", str(ROOT / ".hf-cache"))
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

KLEIN_MODEL = os.environ.get("MLX_KLEIN_MODEL", "mlx-community/flux2-klein-4b-8bit")

_out = sys.stdout
sys.stdout = sys.stderr

klein_model = None
preview_sink = None
current_req_id = None
_emit_lock = threading.Lock()


def log(message: str) -> None:
    print(f"[mlx-worker] {message}", file=sys.stderr, flush=True)


def emit(payload: dict) -> None:
    with _emit_lock:
        _out.write(json.dumps(payload) + "\n")
        _out.flush()


def reply(req_id: str, payload: dict) -> None:
    emit({"id": req_id, **payload})


def _memory_gb() -> float:
    try:
        import mlx.core as mx

        return round(mx.get_active_memory() / 1e9, 2)
    except Exception:
        return 0.0


def model_snapshot(model=None, action="idle", percent=0, message="") -> dict:
    return {
        "type": "model",
        "model": model,
        "action": action,
        "percent": int(max(0, min(100, percent))),
        "message": message,
        "kleinLoaded": klein_model is not None,
        "memoryGb": _memory_gb(),
        "klein": KLEIN_MODEL,
    }


def emit_model(model=None, action="idle", percent=0, message="") -> None:
    payload = model_snapshot(model=model, action=action, percent=percent, message=message)
    emit({"id": current_req_id or "model", **payload})


class LoadMeter:
    def __init__(self, model: str, message: str):
        self.model = model
        self.message = message
        self.percent = 4
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._pulse, daemon=True)

    def start(self) -> None:
        self.set(self.percent, self.message)
        self._thread.start()

    def set(self, percent: int, message: str | None = None) -> None:
        with self._lock:
            self.percent = max(self.percent, min(99, int(percent)))
            if message:
                self.message = message
            percent, text = self.percent, self.message
        emit_model(model=self.model, action="load", percent=percent, message=text)

    def finish(self, message: str = "Loaded") -> None:
        self._stop.set()
        self._thread.join(timeout=1)
        emit_model(model=self.model, action="idle", percent=100, message=message)

    def _pulse(self) -> None:
        while not self._stop.wait(0.35):
            with self._lock:
                if self.percent >= 90:
                    continue
                self.percent += 1
                percent, text = self.percent, self.message
            emit_model(model=self.model, action="load", percent=percent, message=text)


def _clear_mlx() -> None:
    try:
        import mlx.core as mx

        gc.collect()
        gc.collect()
        mx.clear_cache()
        metal = getattr(mx, "metal", None)
        if metal is not None and hasattr(metal, "clear_cache"):
            metal.clear_cache()
        if hasattr(mx, "synchronize"):
            mx.synchronize()
    except Exception as error:
        log(f"mlx cache clear: {error}")


def unload(which: str) -> None:
    global klein_model, preview_sink
    if which not in ("klein", "all"):
        raise ValueError("Unload klein or all.")

    emit_model(model="klein", action="unload", percent=5, message="Releasing")
    klein_model = None
    preview_sink = None
    emit_model(model="klein", action="unload", percent=40, message="Collecting")
    _clear_mlx()
    emit_model(model="klein", action="idle", percent=100, message="Unloaded")


class PreviewSink:
    def __init__(self, model):
        self.model = model
        self.preview_path: str | None = None
        self.req_id: str | None = None

    def call_before_loop(self, seed, prompt, latents, config, **_kwargs) -> None:
        self._dump(latents, config, seed, prompt, step=0)

    def call_in_loop(self, t, seed, prompt, latents, config, time_steps, **_kwargs) -> None:
        step = t + 1
        total = config.num_inference_steps
        if self.req_id:
            reply(self.req_id, {"type": "progress", "step": step, "total": total})
        self._dump(latents, config, seed, prompt, step=step)

    def _dump(self, latents, config, seed, prompt, step: int) -> None:
        if not self.preview_path:
            return
        try:
            from mflux.models.flux2.latent_creator.flux2_latent_creator import Flux2LatentCreator
            from mflux.utils.image_util import ImageUtil

            unpack_latents = Flux2LatentCreator.unpack_latents(
                latents=latents, height=config.height, width=config.width
            )
            vae = getattr(self.model, "vae", None)
            vae_latent_channels = getattr(vae, "latent_channels", 32)
            if vae is None:
                decoded = unpack_latents
            elif hasattr(vae, "decode_packed_latents") and unpack_latents.shape[1] > vae_latent_channels:
                decoded = vae.decode_packed_latents(unpack_latents)
            else:
                decoded = vae.decode(unpack_latents)
            image = ImageUtil.to_image(
                decoded_latents=decoded,
                config=config,
                seed=seed,
                prompt=prompt,
                quantization=getattr(self.model, "bits", None),
                generation_time=0,
            )
            preview = Path(self.preview_path)
            tmp = preview.with_name(f"{preview.stem}.partial.png")
            image.image.save(tmp)
            os.replace(tmp, preview)
            if self.req_id:
                reply(self.req_id, {"type": "preview", "path": str(preview), "step": step})
        except Exception as error:
            log(f"preview failed at step {step}: {error}")


def load_klein() -> None:
    global klein_model, preview_sink
    if klein_model is not None:
        return
    meter = LoadMeter("klein", "Loading FLUX.2 Klein 4B")
    meter.start()
    try:
        meter.set(8, "Importing mflux")
        from mflux.callbacks.callback_registry import CallbackRegistry
        from mflux.models.common.config.model_config import ModelConfig
        from mflux.models.flux2.variants import Flux2Klein

        log(f"loading {KLEIN_MODEL}")
        meter.set(16, "Reading Klein 4B weights")
        klein_model = Flux2Klein(
            model_config=ModelConfig.flux2_klein_4b(),
            model_path=KLEIN_MODEL,
        )
        klein_model.callbacks = CallbackRegistry()
        preview_sink = PreviewSink(klein_model)
        klein_model.callbacks.register(preview_sink)
        log("FLUX.2 Klein 4B ready")
        meter.finish("Loaded")
    except Exception:
        emit_model(model="klein", action="idle", percent=0, message="Load failed")
        raise


def generate_image(payload: dict) -> None:
    load_klein()
    preview_sink.req_id = payload["id"]
    preview_sink.preview_path = payload.get("preview")
    preview_dir = Path(payload["preview"]).parent if payload.get("preview") else None
    if preview_dir:
        preview_dir.mkdir(parents=True, exist_ok=True)

    image = klein_model.generate_image(
        seed=int(payload["seed"]),
        prompt=str(payload["prompt"]),
        num_inference_steps=int(payload["steps"]),
        width=int(payload["width"]),
        height=int(payload["height"]),
        guidance=1.0,
    )
    output_path = Path(payload["output"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path=str(output_path), export_json_metadata=False, overwrite=True)


def handle(request: dict) -> None:
    global current_req_id
    req_id = str(request.get("id") or "")
    current_req_id = req_id
    op = request.get("op")
    try:
        if op == "ping" or op == "models":
            reply(req_id, {**model_snapshot(), "type": "done"})
            return
        if op == "unload":
            unload(str(request.get("model") or "all"))
            reply(req_id, {**model_snapshot(), "type": "done"})
            return
        if op == "generate":
            reply(req_id, {"type": "status", "message": f"Loading {KLEIN_MODEL}" if klein_model is None else "Generating"})
            generate_image(request)
            reply(req_id, {"type": "done", "path": request["output"]})
            return
        raise ValueError(f"Unknown op: {op}")
    except Exception as error:
        log(traceback.format_exc())
        reply(req_id, {"type": "error", "error": str(error)})
    finally:
        current_req_id = None
        if preview_sink is not None:
            preview_sink.req_id = None
            preview_sink.preview_path = None


def main() -> None:
    log(f"ready · klein={KLEIN_MODEL}")
    emit({"id": "boot", "type": "ready", "klein": KLEIN_MODEL})
    emit({"id": "model", **model_snapshot(message="Worker ready")})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            log(f"bad request: {error}")
            continue
        handle(request)


if __name__ == "__main__":
    main()
