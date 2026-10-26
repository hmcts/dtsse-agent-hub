import type { PluginOffer, PluginOption } from "@/virtual-agents/plugins";

/** What the hub offers, then any ticked name it no longer does, which can be kept or unticked but not ticked again. */
export function pluginChoices(available: readonly PluginOption[], checked: readonly string[]): (PluginOption & { offered: boolean })[] {
  const offered = available.map((option) => ({ ...option, offered: true }));
  const dropped = checked.filter((name) => !available.some((option) => option.name === name));
  return [...offered, ...dropped.map((name) => ({ name, description: "", offered: false }))];
}

/**
 * What a malformed `VIRTUAL_AGENT_PLUGINS` shows instead of the ticks. It quotes the variable and the fault, because
 * the fix is a change to the hub's configuration and the reader is who makes it; the surrounding page is unaffected,
 * so it says that too rather than leave the reader wondering what else to distrust.
 */
export function PluginConfigurationFault({ error }: { error: string }) {
  return (
    <div role="alert" className="block basis-full rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-amber-200">
      <p className="font-semibold">Plugins cannot be offered</p>
      <p className="mt-1 text-xs">{error}. Nothing can be ticked until the hub's configuration is corrected; the rest of this page is unaffected.</p>
    </div>
  );
}

/**
 * A checkbox per workspace plugin, each a `plugins` field, so the form sends the ticked names and nothing for none.
 * An offer that could not be read says so in their place. Nothing at all when there is nothing to offer or keep.
 */
export function PluginsField({ offer, checked = [] }: { offer: PluginOffer; checked?: readonly string[] }) {
  if (!offer.ok) {
    return <PluginConfigurationFault error={offer.error} />;
  }
  const choices = pluginChoices(offer.available, checked);
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
