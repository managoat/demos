import { initials, shortName } from "../../shared/author";

/** A person, as a circle of initials in a colour their email always gets. */
export function Avatar({ email, size = 24 }: { email: string; size?: number }) {
  const hue = [...email].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span className="avatar" title={email} aria-label={shortName(email)} style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: `hsl(${hue} 45% 78%)`, color: `hsl(${hue} 50% 22%)` }}>
      {initials(email)}
    </span>
  );
}
