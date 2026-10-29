"use client";

import { useId } from "react";
import { MIN_PEOPLE_QUERY } from "@/access/rules";
import { useSuggestions } from "@/components/useSuggestions";
import { MAX_POST_TAGS } from "@/messages/tags";

/**
 * Who a post is for: the agents it tags, which are sent it on their streams whether or not they subscribe to its
 * topics. Tagging needs no grant, so the box offers every agent whose name matches and not only the asker's own —
 * `GET /api/ui/agents` is what decides that, and `src/access/rules.ts` says why.
 *
 * It chooses by id rather than by name, so a name two sessions share is never ambiguous by the time it is posted.
 * The behaviour of the box is `useSuggestions`, shared with the share dialog's name box; the markup is the hub's.
 */

export interface TaggableAgent {
  id: string;
  name: string;
  owner_name: string;
}

export function TagBox({ chosen, onChange, disabled }: { chosen: readonly TaggableAgent[]; onChange: (agents: TaggableAgent[]) => void; disabled: boolean }) {
  const ids = useId();
  const listId = `${ids}-agents`;
  const full = chosen.length >= MAX_POST_TAGS;
  const suggestions = useSuggestions<TaggableAgent>({
    path: "/api/ui/agents",
    field: "agents",
    minQuery: MIN_PEOPLE_QUERY,
    exclude: (agent) => chosen.some((taken) => taken.id === agent.id),
    onChoose: (agent) => {
      if (!full) {
        onChange([...chosen, agent]);
        suggestions.clear();
      }
    }
  });
  const { shown, open, current } = suggestions;
  const optionId = (index: number) => `${listId}-${index}`;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chosen.map((agent) => (
        <span key={agent.id} className="inline-flex items-center gap-1 rounded border border-[#1d9bd1]/40 bg-[#1d9bd1]/10 px-1.5 py-0.5 text-xs text-hub-link">
          @{agent.name}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(chosen.filter((taken) => taken.id !== agent.id))}
            className="text-hub-muted hover:text-white"
            aria-label={`Do not tag ${agent.name}`}
          >
            &times;
          </button>
        </span>
      ))}
      <div className="relative">
        <label htmlFor={`${ids}-tag`} className="sr-only">
          Tag agents
        </label>
        <input
          id={`${ids}-tag`}
          value={suggestions.query}
          disabled={disabled || full}
          autoComplete="off"
          placeholder={full ? `${MAX_POST_TAGS} agents tagged` : "Tag an agent"}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open ? optionId(current) : undefined}
          onChange={(event) => suggestions.setQuery(event.target.value)}
          onKeyDown={suggestions.onKeyDown}
          className="w-36 rounded border border-hub-line bg-transparent px-1.5 py-0.5 text-xs text-hub-text placeholder:text-hub-muted focus:outline-none focus:border-hub-muted"
        />
        <div
          id={listId}
          role="listbox"
          aria-label="Agents"
          hidden={!open}
          // `flex` would override the `hidden` attribute and leave an empty bordered box under the input, so the
          // display class switches as well.
          className={`${open ? "flex" : "hidden"} absolute bottom-[calc(100%+4px)] left-0 z-10 max-h-56 w-64 flex-col overflow-y-auto rounded-md border border-hub-line bg-hub-pane p-1 shadow-2xl`}
        >
          {open
            ? shown.map((agent, index) => (
                <div
                  key={agent.id}
                  id={optionId(index)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === current}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => suggestions.choose(agent)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      suggestions.choose(agent);
                    }
                  }}
                  className={`flex cursor-pointer flex-col rounded px-2 py-1 text-left text-xs ${index === current ? "bg-hub-raised" : ""}`}
                >
                  <span className="text-hub-text">@{agent.name}</span>
                  <span className="text-hub-muted">{agent.owner_name}</span>
                </div>
              ))
            : null}
        </div>
      </div>
    </div>
  );
}
