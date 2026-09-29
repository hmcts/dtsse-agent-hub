const TILES = ["bg-[#e8912d]", "bg-[#2bac76]", "bg-[#1d9bd1]", "bg-[#e01e5a]", "bg-[#9f5bb0]", "bg-[#4a8a8c]", "bg-[#c2410c]", "bg-[#4f46e5]"];

function tile(name: string): string {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  return TILES[Math.abs(hash) % TILES.length] ?? TILES[0]!;
}

export function initials(name: string): string {
  const words = name
    .replace(/^@/, "")
    .split(/[\s\-_.]+/)
    .filter((word) => word !== "");
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** A square tile with someone's initials, its colour fixed by the name so the same author always looks the same. */
export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-5 w-5 rounded text-[9px]" : "h-9 w-9 rounded-md text-sm";
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 select-none items-center justify-center font-bold text-white ${box} ${tile(name)}`}>
      {initials(name)}
    </span>
  );
}
