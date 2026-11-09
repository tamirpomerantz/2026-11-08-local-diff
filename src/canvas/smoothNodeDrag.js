const DRAG_LERP_FOLLOW = 0.38;
const DRAG_LERP_SETTLE = 0.22;
const DRAG_LERP_EPSILON = 0.45;

export function createSmoothDragController({ setNodes, snapToGrid }) {
  const stateRef = { current: null };

  const tick = () => {
    const state = stateRef.current;
    if (!state) return;
    state.rafId = null;

    const factor = state.dragging ? DRAG_LERP_FOLLOW : DRAG_LERP_SETTLE;
    const dx = state.target.x - state.current.x;
    const dy = state.target.y - state.current.y;
    const dist = Math.hypot(dx, dy);

    if (dist < DRAG_LERP_EPSILON) {
      state.current = { ...state.target };
    } else {
      state.current = {
        x: state.current.x + dx * factor,
        y: state.current.y + dy * factor,
      };
    }

    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === state.id ? { ...node, position: { ...state.current } } : node,
      ),
    );

    const atTarget =
      Math.hypot(state.target.x - state.current.x, state.target.y - state.current.y) <
      DRAG_LERP_EPSILON;

    if (state.dragging || !atTarget) {
      state.rafId = requestAnimationFrame(tick);
    } else {
      stateRef.current = null;
    }
  };

  const schedule = () => {
    const state = stateRef.current;
    if (!state || state.rafId != null) return;
    state.rafId = requestAnimationFrame(tick);
  };

  const setTarget = (id, position) => {
    const state = stateRef.current;
    if (!state || state.id !== id || !position) return;
    state.target = { x: position.x, y: position.y };
    schedule();
  };

  return {
    onDragStart(_event, node) {
      if (stateRef.current?.rafId) cancelAnimationFrame(stateRef.current.rafId);
      stateRef.current = {
        id: node.id,
        target: { ...node.position },
        current: { ...node.position },
        dragging: true,
        rafId: null,
      };
    },

    onDrag(_event, node) {
      setTarget(node.id, node.position);
    },

    onDragStop(_event, node) {
      const state = stateRef.current;
      if (!state || state.id !== node.id) return;
      state.dragging = false;
      state.target = {
        x: snapToGrid(state.target.x),
        y: snapToGrid(state.target.y),
      };
      schedule();
    },

    onNodesChange(changes, applyChanges) {
      const state = stateRef.current;
      if (!state?.dragging) {
        applyChanges(changes);
        return;
      }

      const filtered = [];
      for (const change of changes) {
        if (change.type === "position" && change.id === state.id && change.position) {
          setTarget(change.id, change.position);
        } else {
          filtered.push(change);
        }
      }
      if (filtered.length) applyChanges(filtered);
    },

    cancelActive() {
      if (stateRef.current?.rafId) cancelAnimationFrame(stateRef.current.rafId);
      stateRef.current = null;
    },

    dispose() {
      if (stateRef.current?.rafId) cancelAnimationFrame(stateRef.current.rafId);
      stateRef.current = null;
    },
  };
}
