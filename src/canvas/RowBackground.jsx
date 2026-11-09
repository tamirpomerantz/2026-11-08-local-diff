import { useStore } from "@xyflow/react";

const ROW_GAP = 56;

export function RowBackground() {
  const [x, y, zoom] = useStore((state) => state.transform);
  const scaledGap = ROW_GAP * (zoom || 1);

  return (
    <svg
      className="react-flow__background"
      aria-hidden
      style={{
        position: "absolute",
        width: "100%",
        height: "100%",
        top: 0,
        left: 0,
        pointerEvents: "none",
        backgroundColor: "transparent",
      }}
    >
      <pattern
        id="klein-row-background"
        x={x % scaledGap}
        y={y % scaledGap}
        width={scaledGap}
        height={scaledGap}
        patternUnits="userSpaceOnUse"
      >
        <path
          d={`M0 ${scaledGap / 2} H${scaledGap}`}
          stroke="var(--row-color)"
          strokeWidth={1}
          fill="none"
        />
      </pattern>
      <rect width="100%" height="100%" fill="url(#klein-row-background)" />
    </svg>
  );
}
