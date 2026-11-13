/**
 * Whether a request to a feedback route came from the hub's own pages. The viewer's host is the same site as the
 * hub's, so a prototype's script in the review frame can send `ah_session`-bearing requests to the hub: `SameSite`
 * does not stop it, and only what the browser stamps on the request tells the two apart.
 *
 * An `Origin` has to be the hub's. Browsers leave `Origin` off a same-origin GET, so without one the request has to
 * carry `Sec-Fetch-Site: same-origin` instead; a no-cors GET from the viewer's host says `same-site`, and a browser
 * that sends neither header is refused rather than guessed about.
 */
export function sameOriginRequest(request: Request, hubOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    return origin === hubOrigin;
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}
