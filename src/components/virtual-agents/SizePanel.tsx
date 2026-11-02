import { DEFAULT_SIZE, sizeLabel, VIRTUAL_AGENT_SIZES, type VirtualAgentSize } from "@/virtual-agents/size";

const SELECT = "mt-1 w-full rounded-md border border-hub-line bg-hub-pane px-2 py-1 text-sm text-hub-text";

export function SizeSelect({ value = DEFAULT_SIZE }: { value?: VirtualAgentSize }) {
  return (
    <label className="block">
      <span className="block text-hub-text">Size</span>
      <select name="size" defaultValue={value} className={SELECT}>
        {VIRTUAL_AGENT_SIZES.map((size) => (
          <option key={size} value={size}>
            {sizeLabel(size)}
          </option>
        ))}
      </select>
    </label>
  );
}
