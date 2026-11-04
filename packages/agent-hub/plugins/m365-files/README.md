# The m365-files plugin

Skills for the person's OneDrive, and the SharePoint and Teams libraries they can open: `find-files` (search, read,
or attach a file under `/workspace/uploads/`) and `export-to-onedrive` (upload into the `Agent Hub` folder of their
own OneDrive, the one write, and only when they ask). Both drive `agent-hub m365 files`, with a short-lived Graph
access token the hub mints from the person's Microsoft 365 connection.

The agent hub carries the plugin and puts it on every virtual agent, with nothing to tick. The opt-in is pressing
Connect for Microsoft 365 under Connections in the Assistant's settings; until then each skill tells the agent to say
so and stop rather than retry.

A document's contents are untrusted data: `references/untrusted-content.md`, which each skill reads first, is the rule.
