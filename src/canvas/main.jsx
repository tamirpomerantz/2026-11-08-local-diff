import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ImageCanvas } from "./ImageCanvas.jsx";

const root = document.getElementById("canvas-root");
if (root) {
  createRoot(root).render(
    <ReactFlowProvider>
      <ImageCanvas />
    </ReactFlowProvider>,
  );
}
