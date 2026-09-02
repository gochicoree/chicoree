// Brand mark: a chicory blossom — eight ligulate rays with the toothed tips
// the flower is known for, around a small disc. Drawn to stay legible at 16px.
const RAY =
  "M11.2 8.8C10.3 7.2 10.1 5 10.5 3.2L11.25 2 12 3.2 12.75 2 13.5 3.2C13.9 5 13.7 7.2 12.8 8.8Z";

export function Chicory({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <g fill="currentColor">
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
          <path key={deg} d={RAY} transform={`rotate(${deg} 12 12)`} />
        ))}
        <circle cx="12" cy="12" r="1.6" />
      </g>
    </svg>
  );
}
