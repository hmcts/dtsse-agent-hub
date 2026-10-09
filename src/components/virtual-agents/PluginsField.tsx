import type { PluginOption } from "@/virtual-agents/plugins";

/** What the hub offers, then any ticked name it no longer does, which can be kept or unticked but not ticked again. */
export function pluginChoices(available: readonly PluginOption[], checked: readonly string[]): (PluginOption & { offered: boolean })[] {
  const offered = available.map((option) => ({ ...option, offered: true }));
  const dropped = checked.filter((name) => !available.some((option) => option.name === name));
  return [...offered, ...dropped.map((name) => ({ name, description: "", offered: false }))];
}

/**
 * A checkbox per workspace plugin, each a `plugins` field, so the form sends the ticked names and nothing for none.
 * Nothing at all when there is nothing to offer or keep.
 */
export function PluginsField({ available, checked = [] }: { available: readonly PluginOption[]; checked?: readonly string[] }) {
  const choices = pluginChoices(available, checked);
  if (choices.length === 0) {
    return null;
  }
  return (
    <fieldset className="block basis-full">
      <legend className="text-hub-text">Plugins</legend>
      <ul className="mt-1 space-y-1">
        {choices.map((choice) => (
          <li key={choice.name}>
            <label className="flex items-baseline gap-2">
              <input type="checkbox" name="plugins" value={choice.name} defaultChecked={checked.includes(choice.name)} />
              <span className="font-mono text-hub-text">{choice.name}</span>
              {choice.offered ? null : <span className="text-xs text-amber-200">no longer offered; untick it to stop loading it</span>}
              {choice.description === "" ? null : <span className="text-xs text-hub-muted">{choice.description}</span>}
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
