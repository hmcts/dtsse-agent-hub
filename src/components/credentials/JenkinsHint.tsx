export const JENKINS_TOKEN_URL = "https://build.hmcts.net/me/configure";

/** A Jenkins API token is optional: without one a virtual agent starts as usual, with no Jenkins tools. */
export function JenkinsHint() {
  return (
    <p className="text-hub-muted">
      Optional. It enables your virtual agents' Jenkins tools; they start without it. Create one under API Token on{" "}
      <a href={JENKINS_TOKEN_URL} target="_blank" rel="noreferrer noopener" className="text-hub-link underline">
        your Jenkins user's Configure page
      </a>
      .
    </p>
  );
}
