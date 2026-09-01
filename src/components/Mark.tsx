/** The asterisk that sits beside the headline. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <line key={i} x1="16" y1="3" x2="16" y2="29" stroke="currentColor" strokeWidth="3" strokeLinecap="round" transform={`rotate(${i * 22.5} 16 16)`} />
      ))}
    </svg>
  );
}
