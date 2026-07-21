"use client";

type ZoomControlProps = {
  value: number;
  shifted: boolean;
  onChange: (value: number) => void;
};

export function ZoomControl({ value, shifted, onChange }: ZoomControlProps) {
  const setBounded = (next: number) => onChange(Math.max(0.68, Math.min(3.2, next)));
  const percentage = Math.round(value * 100);

  return (
    <div className={`zoom-control glass-surface ${shifted ? "is-shifted" : ""}`}>
      <button type="button" onClick={() => setBounded(value - 0.08)} aria-label="Zoom out">−</button>
      <input
        type="range"
        min="0.68"
        max="3.2"
        step="0.01"
        value={value}
        onChange={(event) => setBounded(Number(event.target.value))}
        aria-label="Universe zoom"
        aria-valuetext={`${percentage}%`}
      />
      <button type="button" onClick={() => setBounded(value + 0.08)} aria-label="Zoom in">+</button>
      <output aria-live="polite">{percentage}%</output>
    </div>
  );
}
