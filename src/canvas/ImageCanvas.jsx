import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  SelectionMode,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { ImageNode } from "./ImageNode.jsx";
import { RowBackground } from "./RowBackground.jsx";
import { snapToGrid } from "./gridSnap.js";
import {
  NODE_GAP,
  NODE_WIDTH,
  centerOrigin,
  findFreePosition,
  masonryLayout,
  nodeHeight,
  nodeWidth,
  occupiedBoxes,
} from "./placement.js";
import { createSmoothDragController } from "./smoothNodeDrag.js";
import { kleinLog, nodeIds } from "../debugLog.js";

const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };
const EXIT_MS = 280;
const GRID_MS = 520;
const FOCUS_MS = 720;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;
const MIN_NODE_SCREEN = 180;
const TARGET_NODE_SCREEN = 240;

function easeOutQuart(t) {
  return 1 - (1 - t) ** 4;
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const nodeTypes = { image: ImageNode };

function describePartFromPoint(event) {
  for (const part of ["subject", "style"]) {
    const box = document.querySelector(part === "style" ? "#describe-style" : "#describe-subject");
    if (!box) continue;
    const rect = box.getBoundingClientRect();
    if (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    ) {
      return part;
    }
  }
  return "";
}

function nodeScreenRect(node) {
  const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(String(node.id))}"]`);
  return el?.getBoundingClientRect() ?? null;
}

function liftItem(node) {
  const rect = nodeScreenRect(node);
  return {
    id: node.id,
    url: node.data?.image?.url || "",
    x: rect?.left || 0,
    y: rect?.top || 0,
    width: rect?.width || 0,
    height: rect?.height || 0,
  };
}

function nodesForDrag(node, nodes, fallback) {
  if (Array.isArray(nodes) && nodes.length) return nodes;
  return fallback.filter((item) => item.selected || item.id === node.id);
}

function liftSingleDetail(node) {
  if (!node?.data?.image?.url) return { on: false };
  return { on: true, mode: "single", items: [liftItem(node)] };
}

function liftGroupDetail(nodes) {
  const items = nodes
    .filter((item) => item.data?.image?.url && !item.data?.exiting)
    .map(liftItem);
  if (!items.length) return { on: false };
  return { on: true, mode: "group", items };
}

function nodeClassList(node) {
  return new Set(String(node.className || "").split(/\s+/).filter(Boolean));
}

function withNodeClass(node, name) {
  const names = nodeClassList(node);
  names.add(name);
  return { ...node, className: [...names].join(" ") };
}

function withoutNodeClass(node, name) {
  const names = nodeClassList(node);
  names.delete(name);
  return { ...node, className: names.size ? [...names].join(" ") : undefined };
}

function describePointerDetail(node, part) {
  if (!part) return { on: false };
  const rect = nodeScreenRect(node);
  return {
    on: true,
    part,
    width: rect?.width || 0,
    height: rect?.height || 0,
  };
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

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function importFile(file) {
  const named = namedImageFile(file, 0);
  if (!named) return null;
  const data = await readFileAsDataUrl(named);
  const response = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: named.name, data }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Import failed.");
  return payload.image;
}

function generatingId(slotId) {
  return `gen:${slotId}`;
}

function toNode(image, position, extra = {}) {
  return {
    id: image.filename,
    type: "image",
    position,
    data: { image, ...extra },
    style: { width: nodeWidth(image) },
    deletable: true,
  };
}

function toGeneratingNode(slot, position) {
  const image = {
    width: slot.width,
    height: slot.height,
    aspect: slot.aspect,
    scale: slot.scale || 1,
    url: slot.url || null,
  };
  return {
    id: generatingId(slot.id),
    type: "image",
    position,
    data: {
      generating: true,
      slotId: slot.id,
      image,
    },
    style: { width: nodeWidth(image) },
    deletable: true,
  };
}

function menuableNodes(nodes) {
  return nodes.filter(
    (node) =>
      node.selected &&
      !node.data?.generating &&
      !node.data?.exiting &&
      node.data?.image?.url,
  );
}

export function ImageCanvas() {
  const { screenToFlowPosition, setViewport, deleteElements } = useReactFlow();
  const paneRef = useRef(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [multiNodeSelection, setMultiNodeSelection] = useState(false);
  const nodesRef = useRef(nodes);
  const viewportRef = useRef(DEFAULT_VIEWPORT);
  const layoutRef = useRef({ viewport: DEFAULT_VIEWPORT, positions: {} });
  const batchRef = useRef(null);
  const saveTimerRef = useRef(null);
  const hydratedRef = useRef(false);
  const describeDropOriginRef = useRef(null);
  const dragSessionRef = useRef({ mode: null, ids: [] });
  const liftEpochRef = useRef(0);
  const pendingLiftClearRef = useRef(null);
  const reflowRef = useRef({ gen: 0, raf: 0 });
  nodesRef.current = nodes;

  const stopReflow = useCallback(() => {
    reflowRef.current.gen += 1;
    if (reflowRef.current.raf) cancelAnimationFrame(reflowRef.current.raf);
    reflowRef.current.raf = 0;
  }, []);

  const smoothDragRef = useRef(null);
  if (!smoothDragRef.current) {
    smoothDragRef.current = createSmoothDragController({ setNodes, snapToGrid });
  }

  const persistLayout = useCallback((immediate = false) => {
    const write = () => {
      const positions = {};
      for (const node of nodesRef.current) {
        if (node.data?.generating || String(node.id).startsWith("gen:")) continue;
        positions[node.id] = { x: node.position.x, y: node.position.y };
      }
      const payload = {
        viewport: viewportRef.current,
        positions,
      };
      layoutRef.current = payload;
      fetch("/api/canvas", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {});
    };
    clearTimeout(saveTimerRef.current);
    if (immediate) {
      write();
      return;
    }
    saveTimerRef.current = setTimeout(write, 400);
  }, []);

  const visibleCenter = useCallback(() => {
    const rect = paneRef.current?.getBoundingClientRect();
    const board = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--board-width"),
    ) || 372;
    const x = rect ? rect.left + Math.max(120, (rect.width - board) / 2) : window.innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    return screenToFlowPosition({ x, y });
  }, [screenToFlowPosition]);

  const focusFrame = useCallback(
    (image, position) => {
      const rect = paneRef.current?.getBoundingClientRect();
      if (!rect || !image || !position) return;
      const board =
        Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue("--board-width"),
        ) || 372;
      const centerX = Math.max(120, (rect.width - board) / 2);
      const centerY = rect.height / 2;
      const width = nodeWidth(image);
      const height = nodeHeight(image);
      const current = viewportRef.current;
      const currentZoom = current.zoom || 1;
      const short = Math.min(width, height);
      const visibleW = Math.max(160, rect.width - board);
      const fitZoom = Math.min((visibleW - 80) / width, (rect.height - 80) / height, MAX_ZOOM);
      let zoom = currentZoom;
      if (short * currentZoom < MIN_NODE_SCREEN) {
        const targetScreen = Math.min(TARGET_NODE_SCREEN, Math.min(visibleW, rect.height) * 0.36);
        zoom = Math.min(MAX_ZOOM, fitZoom, Math.max(currentZoom, targetScreen / short));
      }
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
      const next = {
        x: centerX - (position.x + width / 2) * zoom,
        y: centerY - (position.y + height / 2) * zoom,
        zoom,
      };
      if (
        Math.abs(current.x - next.x) < 2 &&
        Math.abs(current.y - next.y) < 2 &&
        Math.abs(current.zoom - next.zoom) < 0.01
      ) {
        return;
      }
      setViewport(next, {
        duration: prefersReducedMotion() ? 0 : FOCUS_MS,
        ease: easeOutQuart,
      });
    },
    [setViewport],
  );

  const placeImage = useCallback(
    (image, preferred) => {
      const boxes = occupiedBoxes(nodesRef.current, image.filename);
      if (preferred) return findFreePosition(preferred, image, boxes);
      if (batchRef.current) {
        const origin =
          batchRef.current.count === 0
            ? centerOrigin(batchRef.current.origin, image)
            : batchRef.current.origin;
        const position = findFreePosition(origin, image, boxes);
        if (batchRef.current.count === 0) batchRef.current.origin = position;
        batchRef.current.count += 1;
        return position;
      }
      return findFreePosition(centerOrigin(visibleCenter(), image), image, boxes);
    },
    [visibleCenter],
  );

  const syncFolder = useCallback(
    (images) => {
      const incoming = new Map(images.map((image) => [image.filename, image]));
      setNodes((current) => {
        const next = [];
        const seen = new Set();
        const keptMissing = [];
        for (const node of current) {
          if (node.data?.generating || String(node.id).startsWith("gen:")) {
            next.push(node);
            continue;
          }
          const image = incoming.get(node.id);
          if (!image) {
            keptMissing.push(node.id);
            next.push(node);
            seen.add(node.id);
            continue;
          }
          seen.add(node.id);
          next.push({
            ...node,
            data: { ...node.data, image, generating: false },
          });
        }
        const saved = layoutRef.current.positions || {};
        const added = [];
        for (const image of images) {
          if (seen.has(image.filename)) continue;
          const stored = saved[image.filename];
          const position = stored
            ? { x: stored.x, y: stored.y }
            : placeImage(image);
          next.push(toNode(image, position));
          seen.add(image.filename);
          added.push(image.filename);
        }
        kleinLog("canvas", "sync", {
          incoming: images.length,
          before: nodeIds(current),
          after: nodeIds(next),
          added,
          keptMissing,
        });
        return next;
      });
    },
    [placeImage, setNodes],
  );

  const latestRef = useRef({});
  latestRef.current = { placeImage, persistLayout, syncFolder, visibleCenter, focusFrame };

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const [imagesRes, layoutRes] = await Promise.all([
          fetch("/api/images").then((response) => response.json()),
          fetch("/api/canvas").then((response) => response.json()),
        ]);
        if (ignore) return;
        layoutRef.current = {
          viewport: layoutRes.viewport ?? DEFAULT_VIEWPORT,
          positions: layoutRes.positions ?? {},
        };
        viewportRef.current = layoutRef.current.viewport;
        setViewport(layoutRef.current.viewport, { duration: 0 });
        const images = imagesRes.images ?? [];
        const nodesFromLayout = images.map((image) => {
          const stored = layoutRef.current.positions[image.filename];
          return [image, stored];
        });
        const built = [];
        for (const [image, stored] of nodesFromLayout) {
          if (stored) {
            built.push(toNode(image, { x: stored.x, y: stored.y }));
            continue;
          }
          const position = findFreePosition({ x: 80, y: 80 }, image, occupiedBoxes(built));
          built.push(toNode(image, position));
        }
        if (hydratedRef.current || nodesRef.current.some((node) => node.data?.generating)) {
          kleinLog("canvas", "hydrate-skip", {
            hydrated: hydratedRef.current,
            generating: nodeIds(nodesRef.current.filter((node) => node.data?.generating)),
          });
          hydratedRef.current = true;
          latestRef.current.syncFolder(images);
          return;
        }
        kleinLog("canvas", "hydrate", { count: built.length, ids: nodeIds(built) });
        setNodes(built);
        hydratedRef.current = true;
        latestRef.current.persistLayout(true);
      } catch (error) {
        kleinLog("canvas", "hydrate-error", String(error?.message || error));
        hydratedRef.current = true;
      }
    })();

    const onImages = (event) => {
      if (!hydratedRef.current) {
        kleinLog("canvas", "images-ignored-unhydrated", event.detail?.images?.length ?? 0);
        return;
      }
      latestRef.current.syncFolder(event.detail?.images ?? []);
    };
    const onGenerateStart = (event) => {
      const slots = event.detail?.slots ?? [];
      if (!slots.length) return;
      const besideId = event.detail?.beside;
      const origin = latestRef.current.visibleCenter();
      if (!besideId && !batchRef.current) batchRef.current = { origin, count: 0 };
      kleinLog("canvas", "generate-start", { ids: slots.map((slot) => slot.id), beside: besideId || null });
      let focus = null;
      setNodes((current) => {
        const next = [...current];
        const beside = besideId ? next.find((node) => node.id === besideId) : null;
        let packOrigin = batchRef.current?.origin;
        slots.forEach((slot) => {
          if (next.some((node) => node.id === generatingId(slot.id))) return;
          const stub = {
            width: slot.width,
            height: slot.height,
            aspect: slot.aspect,
            scale: slot.scale || 1,
          };
          let preferred;
          if (beside) {
            preferred = {
              x: beside.position.x + nodeWidth(beside.data?.image) + NODE_GAP,
              y: beside.position.y,
            };
          } else {
            preferred =
              batchRef.current?.count === 0 ? centerOrigin(origin, stub) : packOrigin;
          }
          const position = findFreePosition(preferred, stub, occupiedBoxes(next));
          if (!beside) {
            if (!batchRef.current) batchRef.current = { origin: position, count: 0 };
            if (batchRef.current.count === 0) packOrigin = position;
            batchRef.current.count += 1;
            batchRef.current.origin = packOrigin;
          }
          next.push(toGeneratingNode(slot, position));
          focus = { image: stub, position };
        });
        return next;
      });
      if (focus) latestRef.current.focusFrame(focus.image, focus.position);
    };
    const patchGenerating = (slotId, patch) => {
      if (slotId == null) return;
      const genId = generatingId(slotId);
      setNodes((current) =>
        current.map((node) =>
          node.id === genId
            ? {
                ...node,
                data: {
                  ...node.data,
                  generating: true,
                  ...patch(node.data),
                },
              }
            : node,
        ),
      );
    };
    const onGeneratePreview = (event) => {
      const url = event.detail?.url;
      if (!url) return;
      patchGenerating(event.detail?.id, (data) => ({
        image: { ...data.image, url },
      }));
    };
    const onGenerateDone = (event) => {
      const slotId = event.detail?.id;
      const image = event.detail?.image;
      if (slotId == null || !image?.filename) {
        kleinLog("canvas", "generate-done-skipped", { slotId, filename: image?.filename || null });
        return;
      }
      setNodes((current) => {
        const genId = generatingId(slotId);
        const placeholder = current.find((node) => node.id === genId);
        const existing = current.find((node) => node.id === image.filename);
        const rest = current.filter((node) => node.id !== genId && node.id !== image.filename);
        const position =
          placeholder?.position ?? existing?.position ?? latestRef.current.placeImage(image);
        kleinLog("canvas", "generate-done", {
          slotId,
          filename: image.filename,
          hadPlaceholder: Boolean(placeholder),
          hadExisting: Boolean(existing),
          before: nodeIds(current),
          after: [...nodeIds(rest), image.filename],
        });
        return [...rest, toNode(image, position)];
      });
      latestRef.current.persistLayout(true);
    };
    const onGenerateError = (event) => {
      const slotId = event.detail?.id;
      kleinLog("canvas", "generate-error", { slotId, error: event.detail?.error || "" });
      if (slotId == null) return;
      setNodes((current) => current.filter((node) => node.id !== generatingId(slotId)));
    };
    const onGenerateEnd = () => {
      kleinLog("canvas", "generate-end", {
        generating: nodeIds(nodesRef.current.filter((node) => node.data?.generating)),
      });
      batchRef.current = null;
    };

    window.addEventListener("klein:images", onImages);
    window.addEventListener("klein:generate-start", onGenerateStart);
    window.addEventListener("klein:generate-preview", onGeneratePreview);
    window.addEventListener("klein:generate-done", onGenerateDone);
    window.addEventListener("klein:generate-error", onGenerateError);
    window.addEventListener("klein:generate-end", onGenerateEnd);
    return () => {
      ignore = true;
      window.removeEventListener("klein:images", onImages);
      window.removeEventListener("klein:generate-start", onGenerateStart);
      window.removeEventListener("klein:generate-preview", onGeneratePreview);
      window.removeEventListener("klein:generate-done", onGenerateDone);
      window.removeEventListener("klein:generate-error", onGenerateError);
      window.removeEventListener("klein:generate-end", onGenerateEnd);
    };
  }, [setNodes, setViewport]);

  useEffect(() => () => {
    clearTimeout(saveTimerRef.current);
    stopReflow();
    smoothDragRef.current?.dispose();
  }, [stopReflow]);

  const handleNodesChange = useCallback(
    (changes) => {
      const removed = changes.filter((change) => change.type === "remove").map((change) => change.id);
      if (removed.length) kleinLog("canvas", "nodes-remove", removed);
      if (dragSessionRef.current.mode === "group") onNodesChange(changes);
      else smoothDragRef.current.onNodesChange(changes, onNodesChange);
      if (
        changes.some(
          (change) =>
            change.type === "remove" || (change.type === "position" && change.dragging === false),
        )
      ) {
        persistLayout();
      }
    },
    [onNodesChange, persistLayout],
  );

  const markLifting = (ids, { zIndex } = {}) => {
    setNodes((current) =>
      current.map((item) => {
        if (!ids.has(item.id)) return item;
        const next = withNodeClass(item, "lifting");
        return zIndex == null ? next : { ...next, zIndex };
      }),
    );
  };

  useEffect(() => {
    const onLiftSettled = () => {
      const pending = pendingLiftClearRef.current;
      pendingLiftClearRef.current = null;
      if (!pending || pending.epoch !== liftEpochRef.current) return;
      const ids = pending.ids;
      setNodes((current) =>
        current.map((item) => {
          const next = withoutNodeClass(item, "lifting");
          return ids.has(item.id) ? { ...next, zIndex: undefined } : next;
        }),
      );
    };
    window.addEventListener("klein:drag-lift-settled", onLiftSettled);
    return () => window.removeEventListener("klein:drag-lift-settled", onLiftSettled);
  }, [setNodes]);

  const startSingleDrag = (event, node) => {
    describeDropOriginRef.current = { id: node.id, position: { ...node.position } };
    liftEpochRef.current += 1;
    pendingLiftClearRef.current = null;
    window.dispatchEvent(new CustomEvent("klein:drag-lift", { detail: liftSingleDetail(node) }));
    markLifting(new Set([node.id]), { zIndex: 1000 });
    smoothDragRef.current.onDragStart(event, node);
  };

  const moveSingleDrag = (event, node) => {
    smoothDragRef.current.onDrag(event, node);
    window.dispatchEvent(new CustomEvent("klein:drag-lift", { detail: liftSingleDetail(node) }));
    window.dispatchEvent(
      new CustomEvent("klein:describe-hover", {
        detail: describePointerDetail(node, describePartFromPoint(event)),
      }),
    );
  };

  const stopSingleDrag = (event, node) => {
    const origin = describeDropOriginRef.current;
    describeDropOriginRef.current = null;
    const part = describePartFromPoint(event);
    const dropped =
      Boolean(part) &&
      node.data?.image?.url &&
      !node.data?.generating &&
      !node.data?.exiting;
    if (dropped && origin?.id === node.id) {
      liftEpochRef.current += 1;
      pendingLiftClearRef.current = null;
      window.dispatchEvent(new CustomEvent("klein:drag-lift", { detail: { on: false, immediate: true } }));
      const size = liftItem(node);
      smoothDragRef.current.cancelActive?.();
      setNodes((current) =>
        current.map((item) =>
          item.id === node.id
            ? { ...withoutNodeClass(item, "lifting"), position: origin.position, zIndex: undefined }
            : withoutNodeClass(item, "lifting"),
        ),
      );
      window.dispatchEvent(
        new CustomEvent("klein:describe", {
          detail: {
            image: node.data.image,
            url: size.url,
            width: size.width,
            height: size.height,
            part,
          },
        }),
      );
      return;
    }
    pendingLiftClearRef.current = { epoch: liftEpochRef.current, ids: new Set([node.id]) };
    window.dispatchEvent(new CustomEvent("klein:drag-lift", { detail: { on: false } }));
    window.dispatchEvent(new CustomEvent("klein:describe-hover", { detail: { on: false } }));
    smoothDragRef.current.onDragStop(event, node);
    persistLayout();
  };

  const startGroupDrag = (group) => {
    describeDropOriginRef.current = group.map((item) => ({
      id: item.id,
      position: { ...item.position },
    }));
    liftEpochRef.current += 1;
    pendingLiftClearRef.current = null;
    window.dispatchEvent(new CustomEvent("klein:drag-lift", { detail: liftGroupDetail(group) }));
    markLifting(new Set(group.map((item) => item.id)));
  };

  const moveGroupDrag = (event, group) => {
    window.dispatchEvent(new CustomEvent("klein:drag-lift", { detail: liftGroupDetail(group) }));
    window.dispatchEvent(
      new CustomEvent("klein:describe-hover", {
        detail: describePointerDetail(group[0], describePartFromPoint(event)),
      }),
    );
  };

  const stopGroupDrag = (event, group) => {
    const origins = Array.isArray(describeDropOriginRef.current) ? describeDropOriginRef.current : [];
    describeDropOriginRef.current = null;
    const originById = new Map(origins.map((item) => [item.id, item.position]));
    const part = describePartFromPoint(event);
    const sources = group.filter(
      (item) => item.data?.image?.url && !item.data?.generating && !item.data?.exiting,
    );
    const dropped = Boolean(part) && sources.length >= 1;
    if (dropped) {
      liftEpochRef.current += 1;
      pendingLiftClearRef.current = null;
      window.dispatchEvent(new CustomEvent("klein:drag-lift", { detail: { on: false, immediate: true } }));
      window.dispatchEvent(new CustomEvent("klein:describe-hover", { detail: { on: false } }));
      setNodes((current) =>
        current.map((item) => {
          const origin = originById.get(item.id);
          const next = withoutNodeClass(item, "lifting");
          return origin ? { ...next, position: origin, zIndex: undefined } : next;
        }),
      );
      const picked = sources.slice(0, 4);
      window.dispatchEvent(
        new CustomEvent("klein:describe", {
          detail: {
            images: picked.map((item) => item.data.image),
            items: picked.map(liftItem),
            part,
          },
        }),
      );
      return;
    }
    pendingLiftClearRef.current = {
      epoch: liftEpochRef.current,
      ids: new Set(group.map((item) => item.id)),
    };
    window.dispatchEvent(new CustomEvent("klein:drag-lift", { detail: { on: false } }));
    window.dispatchEvent(new CustomEvent("klein:describe-hover", { detail: { on: false } }));
    persistLayout();
  };

  const onNodeDragStart = useCallback((event, node, nodes) => {
    stopReflow();
    const group = nodesForDrag(node, nodes, nodesRef.current);
    const mode = group.length > 1 ? "group" : "single";
    dragSessionRef.current = { mode, ids: group.map((item) => item.id) };
    if (mode === "group") startGroupDrag(group);
    else startSingleDrag(event, node);
  }, [setNodes, stopReflow]);

  const onNodeDrag = useCallback((event, node, nodes) => {
    if (dragSessionRef.current.mode === "group") {
      moveGroupDrag(event, nodesForDrag(node, nodes, nodesRef.current));
      return;
    }
    moveSingleDrag(event, node);
  }, []);

  const onNodeDragStop = useCallback((event, node, nodes) => {
    const mode = dragSessionRef.current.mode;
    dragSessionRef.current = { mode: null, ids: [] };
    if (mode === "group") {
      stopGroupDrag(event, nodesForDrag(node, nodes, nodesRef.current));
      return;
    }
    stopSingleDrag(event, node);
  }, [persistLayout, setNodes]);

  const onMove = useCallback((_event, viewport) => {
    viewportRef.current = viewport;
  }, []);

  const onMoveStart = useCallback(() => {
    smoothDragRef.current?.cancelActive?.();
  }, []);

  const onMoveEnd = useCallback(() => {
    persistLayout();
  }, [persistLayout]);

  const openNodesMenu = useCallback((event, nodes) => {
    event.preventDefault();
    event.stopPropagation();
    const usable = menuableNodes(nodes);
    if (usable.length > 1) {
      window.dispatchEvent(
        new CustomEvent("klein:image-menu", {
          detail: {
            mode: "multi",
            nodeIds: usable.map((item) => item.id),
            x: event.clientX,
            y: event.clientY,
          },
        }),
      );
      return true;
    }
    return false;
  }, []);

  const onNodeContextMenu = useCallback((event, node) => {
    const selected = menuableNodes(nodesRef.current);
    if (selected.length > 1 && selected.some((item) => item.id === node.id)) {
      openNodesMenu(event, selected);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (node.data?.generating || node.data?.exiting || !node.data?.image?.url) return;
    window.dispatchEvent(
      new CustomEvent("klein:image-menu", {
        detail: {
          image: node.data.image,
          nodeId: node.id,
          x: event.clientX,
          y: event.clientY,
        },
      }),
    );
  }, [openNodesMenu]);

  const onSelectionContextMenu = useCallback((event, selectedNodes) => {
    if (!openNodesMenu(event, selectedNodes?.length ? selectedNodes : nodesRef.current)) {
      event.preventDefault();
    }
  }, [openNodesMenu]);

  const onSelectionChange = useCallback(({ nodes: selectedNodes }) => {
    setMultiNodeSelection(selectedNodes.length > 1);
    const picked = selectedNodes.find((node) => node.data?.image?.filename && !node.data?.generating);
    if (picked?.data?.image) {
      window.dispatchEvent(new CustomEvent("klein:select", { detail: { image: picked.data.image } }));
    }
  }, []);

  useEffect(() => {
    const onSelectionGrid = (event) => {
      const ids = new Set(event.detail?.nodeIds ?? []);
      if (ids.size < 2) return;
      const chosen = nodesRef.current
        .filter((node) => ids.has(node.id) && node.data?.image)
        .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
      if (chosen.length < 2) return;
      const origin = {
        x: Math.min(...chosen.map((node) => node.position.x)),
        y: Math.min(...chosen.map((node) => node.position.y)),
      };
      const laid = masonryLayout(
        chosen.map((node) => ({ id: node.id, image: node.data.image })),
        origin,
      );
      const fromById = new Map(chosen.map((node) => [node.id, { ...node.position }]));
      const toById = new Map(laid.map((item) => [item.id, item.position]));
      const moving = laid.some((item) => {
        const from = fromById.get(item.id);
        return from && (from.x !== item.position.x || from.y !== item.position.y);
      });
      if (!moving) return;

      const place = (eased) => {
        setNodes((current) =>
          current.map((node) => {
            const from = fromById.get(node.id);
            const to = toById.get(node.id);
            if (!from || !to) return node;
            return {
              ...node,
              position: {
                x: from.x + (to.x - from.x) * eased,
                y: from.y + (to.y - from.y) * eased,
              },
            };
          }),
        );
      };

      stopReflow();
      smoothDragRef.current?.cancelActive?.();
      if (prefersReducedMotion()) {
        place(1);
        persistLayout(true);
        return;
      }

      const gen = reflowRef.current.gen;
      const start = performance.now();
      const tick = (now) => {
        if (gen !== reflowRef.current.gen) return;
        const t = Math.min(1, (now - start) / GRID_MS);
        place(easeOutQuart(t));
        if (t < 1) {
          reflowRef.current.raf = requestAnimationFrame(tick);
          return;
        }
        reflowRef.current.raf = 0;
        persistLayout(true);
      };
      reflowRef.current.raf = requestAnimationFrame(tick);
    };
    const onSelectionDelete = (event) => {
      const ids = new Set(event.detail?.nodeIds ?? []);
      const doomed = nodesRef.current.filter((node) => ids.has(node.id));
      if (!doomed.length) return;
      deleteElements({ nodes: doomed.map((node) => ({ id: node.id })) });
    };
    window.addEventListener("klein:selection-grid", onSelectionGrid);
    window.addEventListener("klein:selection-delete", onSelectionDelete);
    return () => {
      window.removeEventListener("klein:selection-grid", onSelectionGrid);
      window.removeEventListener("klein:selection-delete", onSelectionDelete);
    };
  }, [deleteElements, persistLayout, setNodes, stopReflow]);

  const onBeforeDelete = useCallback(async ({ nodes: doomed }) => {
    const generating = doomed.filter((node) => node.data?.generating);
    const removable = doomed.filter((node) => !node.data?.generating && node.data?.image?.filename);
    kleinLog("canvas", "before-delete", {
      doomed: doomed.map((node) => node.id),
      generating: generating.map((node) => node.id),
      removable: removable.map((node) => node.id),
    });
    for (const node of generating) {
      window.dispatchEvent(
        new CustomEvent("klein:cancel-generate", {
          detail: { id: node.data?.slotId || String(node.id).replace(/^gen:/, "") },
        }),
      );
    }
    if (!removable.length) return generating.length ? { nodes: generating, edges: [] } : false;
    const ids = new Set(removable.map((node) => node.id));
    setNodes((current) =>
      current.map((node) =>
        ids.has(node.id)
          ? {
              ...node,
              selected: false,
              className: "exiting",
              draggable: false,
              selectable: false,
              data: { ...node.data, exiting: true },
            }
          : node,
      ),
    );
    await waitForPaint();
    if (!prefersReducedMotion()) await wait(EXIT_MS);
    try {
      await Promise.all(
        removable.map(async (node) => {
          const response = await fetch(`/api/images/${encodeURIComponent(node.id)}`, {
            method: "DELETE",
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || "Could not delete image.");
          }
        }),
      );
      return { nodes: [...removable, ...generating], edges: [] };
    } catch (error) {
      setNodes((current) =>
        current.map((node) =>
          ids.has(node.id)
            ? {
                ...node,
                className: undefined,
                draggable: true,
                selectable: true,
                data: { ...node.data, exiting: false },
              }
            : node,
        ),
      );
      window.dispatchEvent(new CustomEvent("klein:error", { detail: { message: error.message } }));
      return generating.length ? { nodes: generating, edges: [] } : false;
    }
  }, [setNodes]);

  const onDragOver = useCallback((event) => {
    if (!hasImageFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    async (event) => {
      event.preventDefault();
      const files = filesFromDataTransfer(event.dataTransfer);
      if (!files.length) return;
      try {
        for (const [index, file] of files.entries()) {
          const image = await importFile(file);
          if (!image) continue;
          const position = screenToFlowPosition({
            x: event.clientX + index * 24,
            y: event.clientY + index * 24,
          });
          const free = findFreePosition(position, image, occupiedBoxes(nodesRef.current));
          setNodes((current) => {
            if (current.some((node) => node.id === image.filename)) return current;
            return [...current, toNode(image, free)];
          });
        }
        persistLayout(true);
      } catch (error) {
        window.dispatchEvent(new CustomEvent("klein:error", { detail: { message: error.message } }));
      }
    },
    [persistLayout, screenToFlowPosition, setNodes],
  );

  useEffect(() => {
    const onPaste = async (event) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("[contenteditable], textarea, input")) {
        return;
      }
      const files = filesFromDataTransfer(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      try {
        const origin = visibleCenter();
        for (const [index, file] of files.entries()) {
          const image = await importFile(file);
          if (!image) continue;
          const preferred = {
            x: origin.x + index * 28 - NODE_WIDTH / 2,
            y: origin.y + index * 28,
          };
          const position = findFreePosition(preferred, image, occupiedBoxes(nodesRef.current));
          setNodes((current) => {
            if (current.some((node) => node.id === image.filename)) return current;
            return [...current, toNode(image, position)];
          });
        }
        persistLayout(true);
      } catch (error) {
        window.dispatchEvent(new CustomEvent("klein:error", { detail: { message: error.message } }));
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [persistLayout, setNodes, visibleCenter]);

  const handleNodesChangeSafe = handleNodesChange;

  return (
    <div ref={paneRef} className="canvas-root">
      <ReactFlow
        nodes={nodes}
        onNodesChange={handleNodesChangeSafe}
        onSelectionChange={onSelectionChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeContextMenu={onNodeContextMenu}
        onSelectionContextMenu={onSelectionContextMenu}
        onPaneContextMenu={(event) => event.preventDefault()}
        onMove={onMove}
        onMoveStart={onMoveStart}
        onMoveEnd={onMoveEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onBeforeDelete={onBeforeDelete}
        nodeTypes={nodeTypes}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        defaultViewport={DEFAULT_VIEWPORT}
        minZoom={0.1}
        maxZoom={2}
        panOnDrag={false}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        selectionKeyCode={null}
        panOnScroll
        panOnScrollSpeed={1.25}
        preventScrolling
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        selectNodesOnDrag
        deleteKeyCode={["Backspace", "Delete"]}
        className={multiNodeSelection ? "bg-background rf-multi-select" : "bg-background"}
        proOptions={{ hideAttribution: true }}
      >
        <RowBackground />
      </ReactFlow>
    </div>
  );
}
