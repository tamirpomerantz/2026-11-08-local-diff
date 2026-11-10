import { useReactFlow } from "@xyflow/react";
import { nodeHeight, nodeWidth } from "./placement.js";

export function ImageNode({ id, data, selected }) {
  const { deleteElements } = useReactFlow();
  const image = data?.image;
  const generating = Boolean(data?.generating);
  const exiting = Boolean(data?.exiting);
  const width = nodeWidth(image);
  const height = nodeHeight(image);
  const hasImage = Boolean(image?.url);

  return (
    <div className={`canvas-image${exiting ? " is-exiting" : ""}`} style={{ width }}>
      <div
        className={`canvas-image-card${selected && !exiting ? " is-selected" : ""}${generating ? " is-generating" : ""}${hasImage ? " has-image" : ""}${exiting ? " is-exiting" : ""}`}
        style={{ width, height }}
      >
        {hasImage ? (
          <img src={image.url} alt="" draggable={false} />
        ) : generating ? (
          <span className="canvas-image-aspect">{image?.aspect || ""}</span>
        ) : null}
        {exiting ? null : (
          <button
            type="button"
            className="canvas-image-delete nodrag nopan"
            aria-label={generating ? "Cancel generation" : "Delete image"}
            title={generating ? "Cancel generation" : "Delete from folder"}
            onClick={(event) => {
              event.stopPropagation();
              deleteElements({ nodes: [{ id }] });
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                d="M18 6 6 18M6 6l12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
