export const ATLASSIAN_SITE_URL = "https://hmcts.atlassian.net";

/** An Atlassian sign-in is optional: without one a virtual agent starts as usual, with no `twg` CLI. */
export function AtlassianHint() {
  return (
    <p className="text-hub-muted">
      Optional. It gives your virtual agents the <code className="font-mono">twg</code> CLI for Jira and Confluence on{" "}
      <a href={ATLASSIAN_SITE_URL} target="_blank" rel="noreferrer noopener" className="text-hub-link underline">
        hmcts.atlassian.net
      </a>
      ; they start without it. Your virtual agent asks you to sign in with a device code.
    </p>
  );
}
